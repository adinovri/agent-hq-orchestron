import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { writeJson, readJson, listDir } from '@agent-hq-orchestron/file-store'
import type { SessionMetadata, SessionStatus, SpawnConfig } from '@agent-hq-orchestron/shared'
import type { AdapterRegistry } from '../adapters/registry.js'
import { TranscriptTailer } from '../streaming/transcript-tailer.js'

export class PoolFullError extends Error {
  constructor(max: number) {
    super(`Session pool is full (max ${max} concurrent sessions)`)
    this.name = 'PoolFullError'
  }
}

export class InvalidTransitionError extends Error {
  constructor(from: SessionStatus, to: SessionStatus) {
    super(`Invalid state transition: ${from} → ${to}`)
    this.name = 'InvalidTransitionError'
  }
}

// Legal transitions — tycho-inspired lifecycle
const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  spawning: ['waiting', 'failed', 'killed'],
  waiting: ['running', 'killed'],
  running: ['running', 'idle', 'needs_input', 'succeeded', 'killed'],
  idle: ['running', 'needs_input', 'sleeping', 'succeeded', 'killed'],
  needs_input: ['running', 'idle', 'sleeping', 'succeeded', 'killed'],
  sleeping: ['spawning', 'succeeded', 'killed'],   // wake → spawning; archive → succeeded; kill remains legal
  // Terminal states allow → 'spawning' for in-place respawn (fresh Claude
  // conversation using the same orchestron session id). No other exits.
  succeeded: ['spawning'],
  failed: ['spawning'],
  killed: ['spawning'],
}

// Detect whether an assistant text is soliciting user input (question).
// Cheap heuristic: ends with `?`, or contains typical question phrases.
const QUESTION_PHRASES = [
  /\?\s*$/,                         // ends with ?
  /would you like/i,
  /do you want/i,
  /should i /i,
  /which (one|do you|would)/i,
  /let me know/i,
  /please (tell|specify|confirm|clarify|choose)/i,
  /what (do you|would|should)/i,
  /any (specific|preference|thoughts)/i,
  /shall i/i,
  /could you (tell|specify|clarify|share)/i,
]
/** Drop a model when it looks like it belongs to a different harness — e.g.
 *  a project's defaultModel `claude-sonnet-5` accidentally passed to a codex
 *  spawn. Adapter's own default is safer than a rejection at spawn time. */
function filterModelForHarness(model: string | undefined, agentType: import('@agent-hq-orchestron/shared').AgentType): string | undefined {
  if (!model) return undefined
  const isClaudeModel = /^claude[-_]/i.test(model)
  const isGptModel = /^gpt[-_]/i.test(model)
  const isCodexAstra = /^(codex|astra)/i.test(model)
  if (agentType === 'claude' && (isGptModel || isCodexAstra)) return undefined
  if (agentType === 'codex' && isClaudeModel) return undefined
  return model
}

function textAsksQuestion(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return QUESTION_PHRASES.some((re) => re.test(t))
}

export interface SessionManagerConfig {
  dataDir: string
  maxConcurrent: number
  /** Milliseconds a session may stay idle/needs_input before its tmux is
   *  released (session goes to 'sleeping'). 0 disables the sweeper. */
  idleTimeoutMs?: number
  /** Absolute path to a shared Claude-memory directory. When set, every
   *  claude spawn/reopen/clone/respawn ensures the per-workspace
   *  `<configDir>/projects/<mangled-cwd>/memory/` is a symlink pointing at
   *  this dir — so all sessions across all workspaces share one memory
   *  pool. Real memory dirs found in the path get safety-renamed with a
   *  timestamp suffix so nothing is lost. Empty/unset disables the feature. */
  sharedMemoryDir?: string
  /** Absolute path to a directory holding the shared codex memories SQLite.
   *  When set, every codex spawn/reopen/clone/respawn ensures
   *  `<CODEX_HOME>/memories_1.sqlite` is a symlink pointing at
   *  `<sharedCodexMemoryDir>/memories_1.sqlite` — so codex sessions across
   *  every CODEX_HOME share one derived-memory pool. Only the memories DB
   *  is symlinked; thread_history / goals / queue stay per-CODEX_HOME so
   *  conversation state remains isolated per identity. Empty/unset
   *  disables the feature. */
  sharedCodexMemoryDir?: string
  /** When set, session-manager auto-writes a per-session MCP config that
   *  registers the orchestron MCP server and injects it into every spawn
   *  and reopen via `--mcp-config`. */
  mcpAutoInject?: {
    apiUrl: string
    token: string
    mcpServerPath: string   // absolute path to dist/mcp-server.js
  }
}

export class SessionManager {
  private readonly dataDir: string
  private readonly sessionsDir: string
  private readonly maxConcurrent: number
  private readonly registry: AdapterRegistry
  private readonly mcpAutoInject: SessionManagerConfig['mcpAutoInject']
  private readonly idleTimeoutMs: number
  private readonly sharedMemoryDir: string
  private readonly sharedCodexMemoryDir: string
  // Optional — needed only for the wake-up path (sleeping → spawning). Kept
  // optional so unit tests don't have to construct a ProjectRegistry.
  private projectResolver: ((projectId: string) => Promise<{ path: string; defaultModel?: string; defaultEffort?: import('@agent-hq-orchestron/shared').EffortLevel }>) | null = null
  // Watchers that flip running → awaiting_input on the next turn_duration event.
  // Keyed by session uuid; one active watcher per session at a time.
  private readonly turnWatchers = new Map<string, TranscriptTailer>()
  // Per-session warm-shutdown timers armed when the session enters
  // idle/needs_input. Fires warmShutdown() at (idleSince + idleTimeoutMs).
  private readonly idleSweepers = new Map<string, NodeJS.Timeout>()
  // Safety-net sweep interval — catches sessions whose per-session timer
  // was lost (e.g. server crash, dropped notification).
  private safetyNetSweep: NodeJS.Timeout | null = null

  constructor(config: SessionManagerConfig, registry: AdapterRegistry) {
    this.dataDir = config.dataDir
    this.sessionsDir = path.join(config.dataDir, 'sessions')
    this.maxConcurrent = config.maxConcurrent
    this.registry = registry
    this.mcpAutoInject = config.mcpAutoInject
    this.idleTimeoutMs = config.idleTimeoutMs ?? 0
    this.sharedMemoryDir = config.sharedMemoryDir ?? ''
    this.sharedCodexMemoryDir = config.sharedCodexMemoryDir ?? ''
  }

  /**
   * Ensure `<configDir>/projects/<mangled-cwd>/memory/` is a symlink into
   * the shared Claude-memory pool. Claude CLI creates this dir as a real
   * directory the first time a workspace is used — we detect that and
   * convert it (safety-renaming the real dir with a timestamp).
   */
  private async ensureMemorySymlink(agentType: import('@agent-hq-orchestron/shared').AgentType, configDir: string | undefined, workspace: string): Promise<void> {
    if (agentType === 'codex') return this.ensureCodexMemorySymlink(configDir)
    if (agentType !== 'claude' || !this.sharedMemoryDir) return
    try {
      const fsp = await import('node:fs/promises')
      const p = await import('node:path')
      const os = await import('node:os')
      const expandHome = (x: string) => x.startsWith('~/') ? p.join(os.homedir(), x.slice(2)) : x === '~' ? os.homedir() : x
      const sharedTarget = expandHome(this.sharedMemoryDir)
      const baseDir = expandHome(configDir ?? process.env['CLAUDE_CONFIG_DIR'] ?? p.join(os.homedir(), '.claude'))
      const mangled = expandHome(workspace).replace(/\//g, '-')
      const memPath = p.join(baseDir, 'projects', mangled, 'memory')

      // Make sure the shared pool exists first.
      await fsp.mkdir(sharedTarget, { recursive: true, mode: 0o700 })
      // And the parent so we can create the symlink.
      await fsp.mkdir(p.dirname(memPath), { recursive: true, mode: 0o700 })

      let stat: import('node:fs').Stats | null = null
      try { stat = await fsp.lstat(memPath) } catch { stat = null }
      if (!stat) {
        await fsp.symlink(sharedTarget, memPath)
        return
      }
      if (stat.isSymbolicLink()) return   // already linked (to anything) — leave alone
      if (stat.isDirectory()) {
        // Real dir — safety-move + symlink. Never delete: files could be
        // hand-edited memory the user wants to merge into the pool later.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const bak = `${memPath}.bak-${stamp}`
        await fsp.rename(memPath, bak)
        console.warn(`[session-manager] moved real memory dir to ${bak} and symlinked ${memPath} → ${sharedTarget}`)
        await fsp.symlink(sharedTarget, memPath)
        return
      }
      console.warn(`[session-manager] unexpected fs type at ${memPath}; skipping shared-memory symlink`)
    } catch (err) {
      // Never let this block a spawn — memory-symlink is a convenience, not a hard dep.
      console.warn(`[session-manager] ensureMemorySymlink failed: ${(err as Error).message}`)
    }
  }

  /**
   * Ensure <CODEX_HOME>/memories_1.sqlite is a symlink into the shared
   * codex-memory pool. Codex writes its curated cross-thread memory pool
   * to this single SQLite file; symlinking to a shared location lets
   * multiple CODEX_HOME identities (different profiles) contribute to one
   * pool of learned patterns. Auto-generated -wal / -shm sidecars live in
   * the same directory as the symlinked DB file — SQLite handles the
   * concurrent-writer serialization via WAL locks.
   *
   * Deliberately does NOT symlink thread_history / goals / queue — those
   * carry conversation content that should stay isolated per identity.
   */
  private async ensureCodexMemorySymlink(configDir: string | undefined): Promise<void> {
    if (!this.sharedCodexMemoryDir) return
    try {
      const fsp = await import('node:fs/promises')
      const p = await import('node:path')
      const os = await import('node:os')
      const expandHome = (x: string) => x.startsWith('~/') ? p.join(os.homedir(), x.slice(2)) : x === '~' ? os.homedir() : x
      const sharedDir = expandHome(this.sharedCodexMemoryDir)
      const codexHome = expandHome(configDir ?? process.env['CODEX_HOME'] ?? p.join(os.homedir(), '.codex'))

      const sharedDbPath = p.join(sharedDir, 'memories_1.sqlite')
      const localDbPath = p.join(codexHome, 'memories_1.sqlite')

      // Ensure both directories exist so symlink() can succeed.
      await fsp.mkdir(sharedDir, { recursive: true, mode: 0o700 })
      await fsp.mkdir(codexHome, { recursive: true, mode: 0o700 })

      let stat: import('node:fs').Stats | null = null
      try { stat = await fsp.lstat(localDbPath) } catch { stat = null }
      if (!stat) {
        // Sqlite file doesn't exist yet — create the symlink; SQLite will
        // materialize the DB (and WAL sidecars) at the shared location on
        // first codex write.
        await fsp.symlink(sharedDbPath, localDbPath)
        return
      }
      if (stat.isSymbolicLink()) return   // already linked
      if (stat.isFile()) {
        // Real DB file. Safety-move to bak (never delete — codex's own
        // derived memories from this identity), then symlink. WAL sidecars
        // stay behind and become stale; codex re-creates them at shared
        // location on next write.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const bak = `${localDbPath}.bak-${stamp}`
        await fsp.rename(localDbPath, bak)
        console.warn(`[session-manager] moved codex memories DB to ${bak} and symlinked ${localDbPath} → ${sharedDbPath}`)
        await fsp.symlink(sharedDbPath, localDbPath)
        return
      }
      console.warn(`[session-manager] unexpected fs type at ${localDbPath}; skipping codex-memory symlink`)
    } catch (err) {
      // Convenience feature — never block spawn.
      console.warn(`[session-manager] ensureCodexMemorySymlink failed: ${(err as Error).message}`)
    }
  }

  /** Wire in a project lookup for the wake-up flow. Called from server boot. */
  setProjectResolver(resolver: NonNullable<SessionManager['projectResolver']>): void {
    this.projectResolver = resolver
  }

  private mcpConfigPath(sessionId: string): string {
    return path.join(this.dataDir, 'mcp-configs', `${sessionId}.json`)
  }

  /** Build inline MCP config args for Codex (`-c mcp_servers.NAME.*=VALUE`).
   *  Codex accepts TOML-typed config overrides via `-c KEY=VALUE`. Strings
   *  need TOML quoting; arrays use TOML array syntax. Kept in sync with the
   *  claude JSON config shape written by ensureSessionMcpConfig(). */
  private buildCodexMcpArgs(sessionId: string): string[] | undefined {
    if (!this.mcpAutoInject) return undefined
    const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    const args: string[] = []
    args.push('-c', `mcp_servers.orchestron.command=${q('node')}`)
    args.push('-c', `mcp_servers.orchestron.args=[${q(this.mcpAutoInject.mcpServerPath)}]`)
    args.push('-c', `mcp_servers.orchestron.env.ORCHESTRON_API_URL=${q(this.mcpAutoInject.apiUrl)}`)
    args.push('-c', `mcp_servers.orchestron.env.ORCHESTRON_TOKEN=${q(this.mcpAutoInject.token)}`)
    args.push('-c', `mcp_servers.orchestron.env.ORCHESTRON_SESSION_ID=${q(sessionId)}`)
    return args
  }

  /** Write a per-session MCP config that exposes the orchestron server to
   *  the child agent. Returns the file path, or undefined if auto-inject
   *  is not configured. Currently CLAUDE-only — Codex uses buildCodexMcpArgs()
   *  above which returns inline `-c` flags instead. */
  private async ensureSessionMcpConfig(sessionId: string, agentType?: import('@agent-hq-orchestron/shared').AgentType): Promise<string | undefined> {
    if (!this.mcpAutoInject) return undefined
    if (agentType && agentType !== 'claude') return undefined
    const cfg = {
      mcpServers: {
        orchestron: {
          command: 'node',
          args: [this.mcpAutoInject.mcpServerPath],
          env: {
            ORCHESTRON_API_URL: this.mcpAutoInject.apiUrl,
            ORCHESTRON_TOKEN: this.mcpAutoInject.token,
            ORCHESTRON_SESSION_ID: sessionId,
          },
        },
      },
    }
    const p = this.mcpConfigPath(sessionId)
    await writeJson(p, cfg)
    return p
  }

  private sessionPath(uuid: string): string {
    return path.join(this.sessionsDir, `${uuid}.json`)
  }

  async spawn(spawnConfig: SpawnConfig): Promise<SessionMetadata> {
    const active = await this.countActiveSessions()
    if (active >= this.maxConcurrent) {
      throw new PoolFullError(this.maxConcurrent)
    }

    // Delegation guardrails: prevent infinite child-of-child spawning and
    // per-parent spam.
    if (spawnConfig.parentSessionId) {
      const MAX_DEPTH = 5           // grandparent → parent → ... → self, max chain
      const MAX_CHILDREN = 10        // per parent
      const RATE_LIMIT_WINDOW_MS = 60_000
      const RATE_LIMIT_MAX = 5       // spawns/minute per parent

      // Walk parent chain to compute depth
      let depth = 1
      let cur = spawnConfig.parentSessionId
      while (cur && depth < MAX_DEPTH + 1) {
        const rec = await readJson<SessionMetadata | null>(this.sessionPath(cur), null)
        if (!rec || !rec.parentSessionId) break
        cur = rec.parentSessionId
        depth += 1
      }
      if (depth > MAX_DEPTH) {
        throw new Error(`Delegation depth limit reached (${MAX_DEPTH}). Parent chain too long.`)
      }

      // Count existing children of this parent
      const all = await this.list()
      const children = all.filter((s) => s.parentSessionId === spawnConfig.parentSessionId)
      if (children.length >= MAX_CHILDREN) {
        throw new Error(`Parent ${spawnConfig.parentSessionId.slice(0, 8)} already has ${children.length} children (max ${MAX_CHILDREN})`)
      }

      // Rate limit: how many children spawned in the last window
      const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS
      const recent = children.filter((s) => new Date(s.startedAt).getTime() > cutoff)
      if (recent.length >= RATE_LIMIT_MAX) {
        throw new Error(`Parent ${spawnConfig.parentSessionId.slice(0, 8)} spawn rate limit: ${RATE_LIMIT_MAX} per minute`)
      }
    }

    const uuid = crypto.randomUUID()
    const adapter = this.registry.getOrThrow(spawnConfig.agentType)
    const mcpConfigPath = await this.ensureSessionMcpConfig(uuid, spawnConfig.agentType)
    const mcpConfigInline = spawnConfig.agentType === 'codex'
      ? this.buildCodexMcpArgs(uuid)
      : undefined
    // Effective config dir: harness-specific. Route layer resolves the
    // right env-var per harness (CLAUDE_CONFIG_DIR for claude, CODEX_HOME
    // for codex). For claude we also cascade to CLAUDE_CONFIG_DIR env and
    // ~/.claude default via effectiveClaudeConfigDir. Codex adapter reads
    // CODEX_HOME env internally when passed undefined.
    const { effectiveClaudeConfigDir } = await import('../adapters/claude.js')
    const effectiveConfigDir = spawnConfig.agentType === 'claude'
      ? effectiveClaudeConfigDir(spawnConfig.configDir)
      : spawnConfig.configDir
    // Same-harness model check: project defaults might carry a Claude model
    // that Codex would reject at spawn. Drop the model if it looks like the
    // wrong family; adapter will fall back to its own default (gpt-6-astra
    // for codex, sonnet for claude).
    const effectiveModel = filterModelForHarness(spawnConfig.model, spawnConfig.agentType)
    await this.ensureMemorySymlink(spawnConfig.agentType, effectiveConfigDir, spawnConfig.workspace)
    const spawnedAt = Date.now()
    let handle = await adapter.spawn({ ...spawnConfig, model: effectiveModel, configDir: effectiveConfigDir, mcpConfigPath, mcpConfigInline })

    // Codex path: adapter returns handle with empty claudeUuid + jsonlPath
    // because codex assigns its own session UUID (UUID v7) — capture happens
    // after TUI is ready by scanning the rollout dir. Wait for TUI first,
    // then invoke the adapter's captureNewSessionId() method.
    //
    // spawnedAt is passed so captureNewSessionId ignores pre-existing rollout
    // files (e.g. a stale `codex exec` rollout from an earlier session). If no
    // rollout appears (interactive TUI doesn't write JSONL), it returns empty ids
    // and we rely on the idle-timeout sweeper for session lifecycle management.
    if (spawnConfig.agentType === 'codex' && handle.claudeUuid === '') {
      try {
        await adapter.waitTuiReady(handle, 30_000)
        const maybeCodex = adapter as unknown as {
          captureNewSessionId?: (h: typeof handle, cd?: string, t?: number, spawnedAfter?: number) => Promise<{ sessionId: string; jsonlPath: string }>
        }
        if (typeof maybeCodex.captureNewSessionId === 'function') {
          const captured = await maybeCodex.captureNewSessionId(handle, effectiveConfigDir, 10_000, spawnedAt)
          // Only update handle when a real session was captured — empty means interactive
          // TUI (no JSONL rollout); leave handle ids empty and fall through.
          if (captured.sessionId) {
            handle = { ...handle, claudeUuid: captured.sessionId, jsonlPath: captured.jsonlPath }
          }
        }
      } catch (err) {
        console.warn(`[session-manager] codex session-id capture failed for ${uuid}: ${(err as Error).message}`)
        // Persist with empty ids — session unusable but at least record exists for cleanup
      }
    }

    const now = new Date().toISOString()
    const session: SessionMetadata = {
      id: uuid,
      projectId: spawnConfig.projectId,
      agentType: spawnConfig.agentType,
      model: spawnConfig.model,
      effort: spawnConfig.effort,
      status: 'spawning',
      parentSessionId: spawnConfig.parentSessionId ?? null,
      detached: spawnConfig.detached ?? false,
      claudeSessionUuid: handle.claudeUuid,
      tmuxName: handle.tmuxName,
      jsonlPath: handle.jsonlPath,
      configDir: effectiveConfigDir,
      initialPrompt: spawnConfig.initialPrompt,
      finalResponse: null,
      tokenUsage: null,
      costUsd: null,
      startedAt: now,
      endedAt: null,
      metadata: {},
    }

    await writeJson(this.sessionPath(uuid), session)

    // Fire-and-forget: complete the spawn lifecycle async so the HTTP response is fast.
    // Dismisses trust folder / theme picker, waits for TUI ready, pastes prompt, then transitions.
    // Passes spawnConfig so completeSpawn can re-spawn on transient tmux/claude-boot failure.
    this.completeSpawn(uuid, adapter, handle, spawnConfig.initialPrompt, spawnConfig).catch(async (err: unknown) => {
      const msg = (err as Error).message ?? String(err)
      console.error(`[session-manager] completeSpawn failed for ${uuid}: ${msg}`)
      try {
        const rec = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
        if (rec && rec.status === 'spawning') {
          await this.transition(uuid, 'failed').catch(() => {})
          const failed = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
          if (failed) {
            failed.failureReason = msg
            await writeJson(this.sessionPath(uuid), failed)
          }
        }
      } catch { /* ignore */ }
    })

    return session
  }

  private async completeSpawn(
    uuid: string,
    adapter: import('@agent-hq-orchestron/shared').AgentAdapter,
    handle: import('@agent-hq-orchestron/shared').TmuxHandle,
    prompt: string,
    spawnConfig?: SpawnConfig,
  ): Promise<void> {
    let currentHandle = handle
    let attempt = 0
    const MAX_ATTEMPTS = 2

    while (true) {
      try {
        // TUI ready (auto-dismisses trust/menu interstitials) — 30s timeout for cold start
        await adapter.waitTuiReady(currentHandle, 30_000)
        break
      } catch (err: unknown) {
        const msg = (err as Error).message ?? ''
        // Only retry when the tmux pane vanished early (Claude subprocess died
        // at boot — usually a transient auth/subscription glitch). Other errors
        // (timeouts on interstitials etc.) propagate.
        const paneDied = msg.includes('can\'t find pane') || msg.includes('no such pane')
        attempt += 1
        if (!paneDied || attempt >= MAX_ATTEMPTS || !spawnConfig) {
          throw err
        }
        console.warn(`[session-manager] tmux pane died for ${uuid}, respawning (attempt ${attempt + 1}/${MAX_ATTEMPTS})`)
        // Clean up dead tmux (best-effort) and respawn with fresh claude UUID.
        await adapter.kill(currentHandle).catch(() => {})
        const newHandle = await adapter.spawn(spawnConfig)
        currentHandle = newHandle

        // Update the session record with the new tmux/claude handles.
        const rec = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
        if (rec) {
          rec.tmuxName = newHandle.tmuxName
          rec.claudeSessionUuid = newHandle.claudeUuid
          rec.jsonlPath = newHandle.jsonlPath
          await writeJson(this.sessionPath(uuid), rec)
        }
      }
    }

    await this.transition(uuid, 'waiting')

    // Paste initial prompt + Enter
    await adapter.sendPrompt(currentHandle, prompt)
    await this.transition(uuid, 'running')
    if (currentHandle.jsonlPath) {
      this.watchForTurnEnd(uuid, currentHandle.jsonlPath)
    }
  }

  async sendInput(uuid: string, prompt: string): Promise<SessionMetadata> {
    let session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    // Wake-up path: session is sleeping → cold-start tmux with --resume,
    // wait for TUI ready, then fall through to the normal paste flow.
    if (session.status === 'sleeping') {
      if (!this.projectResolver) {
        throw new Error('Cannot wake sleeping session: project resolver not wired')
      }
      const proj = await this.projectResolver(session.projectId)
      const adapter = this.registry.getOrThrow(session.agentType)
      await this.ensureMemorySymlink(session.agentType, session.configDir, proj.path)

      // Claude subprocess sometimes dies within a few seconds of boot
      // (transient auth / quota / MCP-connect flakiness). Same retry pattern
      // as completeSpawn — attempt twice with a fresh mcp config each time,
      // then surface a clean error so the client can retry.
      let handle: import('@agent-hq-orchestron/shared').TmuxHandle | null = null
      let lastErr: Error | null = null
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const mcpConfigPath = await this.ensureSessionMcpConfig(uuid)
          handle = await adapter.resume(session.claudeSessionUuid, {
            workspace: proj.path,
            configDir: session.configDir,   // wake-up must use SAME configDir as spawn
            model: session.model ?? proj.defaultModel,
            effort: session.effort ?? proj.defaultEffort,
            mcpConfigPath,
          })
          await adapter.waitTuiReady(handle, 15_000)
          break
        } catch (err) {
          lastErr = err as Error
          // Tear down the failed tmux if it exists, then retry once.
          if (handle) {
            await adapter.kill(handle).catch(() => {})
            handle = null
          }
          if (attempt === 2) break
          await new Promise((r) => setTimeout(r, 500))
        }
      }

      if (!handle) {
        // Leave the session in 'sleeping' so a subsequent send can retry.
        // Don't drag it into 'failed' — that'd hide the resumable state.
        throw new Error(
          `Wake-up failed after 2 attempts: ${lastErr?.message ?? 'unknown'}. Session stays sleeping — try sending again.`,
        )
      }

      // Persist new tmux + jsonl path only after TUI is confirmed ready.
      await writeJson(this.sessionPath(uuid), {
        ...session,
        tmuxName: handle.tmuxName,
        jsonlPath: handle.jsonlPath,
        status: 'spawning',
        endedAt: null,
        idleSince: null,
      })
      await this.transition(uuid, 'waiting')
      // Re-read after wake-up so downstream sees fresh tmux name.
      session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
      if (!session) throw new Error(`Session vanished during wake-up: ${uuid}`)
    }

    // Allow queue-during-run: Claude TUI buffers the pasted input and sends
    // it as the next turn after the current one finishes. Only reject when
    // the session is terminal or still initializing.
    const INPUT_ALLOWED: SessionStatus[] = ['needs_input', 'idle', 'waiting', 'running']
    if (!INPUT_ALLOWED.includes(session.status)) {
      throw new Error(`Cannot send input while session is ${session.status}`)
    }

    const adapter = this.registry.getOrThrow(session.agentType)
    const handle = { tmuxName: session.tmuxName, claudeUuid: session.claudeSessionUuid, jsonlPath: session.jsonlPath }

    // Dismiss any stale interstitial (e.g. "Teach auto mode?" modal that Claude
    // may pop up between turns) before pasting the prompt. Short timeout — if
    // the TUI is already ready this returns immediately.
    await adapter.waitTuiReady(handle, 10_000).catch(() => { /* proceed anyway */ })

    await adapter.sendPrompt(handle, prompt)
    // If session was already running, don't force a transition — the current
    // turn's watcher will still handle turn_duration → idle/needs_input.
    // The queued prompt becomes the next turn and a fresh watcher then arms.
    if (session.status === 'running') {
      // Just re-arm watcher (safe: idempotent — old watcher closed on next fire)
      this.watchForTurnEnd(uuid, session.jsonlPath)
      return session
    }
    const updated = await this.transition(uuid, 'running')
    this.watchForTurnEnd(uuid, session.jsonlPath)
    return updated
  }

  /**
   * Safety-net reconciliation: forces a running→idle/needs_input transition
   * based on the last assistant text, when the tailer's fs.watch missed the
   * turn_duration event (known Linux inotify quirk for appends). Called by
   * the transcript polling endpoint.
   */
  async reconcileTurnEnd(uuid: string, lastAssistantText: string): Promise<void> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session || session.status !== 'running') return
    const next: SessionStatus = textAsksQuestion(lastAssistantText) ? 'needs_input' : 'idle'
    if (ALLOWED_TRANSITIONS[session.status].includes(next)) {
      await this.transition(uuid, next).catch(() => {})
    }
    // Close any dangling watcher for cleanliness
    const w = this.turnWatchers.get(uuid)
    if (w) {
      w.close()
      this.turnWatchers.delete(uuid)
    }
  }

  /**
   * Interrupt the current turn — send Escape to the Claude TUI which aborts
   * the API call in progress without killing the session. Session transitions
   * back to `idle` once tailer sees `turn_duration` or timeout.
   */
  async interrupt(uuid: string): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    if (session.status !== 'running' && session.status !== 'needs_input' && session.status !== 'idle') {
      throw new Error(`Cannot interrupt session in ${session.status} state`)
    }

    const handle = { tmuxName: session.tmuxName, claudeUuid: session.claudeSessionUuid, jsonlPath: session.jsonlPath }

    // Send Escape via tmux — Claude TUI interprets as interrupt-turn.
    // Fallback silently if tmux is dead.
    try {
      const tmux = await import('../adapters/tmux.js')
      await tmux.sendKeys(handle.tmuxName, 'Escape')
    } catch { /* ignore */ }

    // Interrupted turns write '[Request interrupted by user]' but NO
    // `turn_duration` event, so the tailer/safety-net won't auto-transition.
    // Proactively flip running → idle here since we know the user chose to
    // stop. Close any active watcher for cleanliness.
    if (session.status === 'running') {
      const w = this.turnWatchers.get(uuid)
      if (w) {
        w.close()
        this.turnWatchers.delete(uuid)
      }
      const updated = await this.transition(uuid, 'idle').catch(() => session)
      return updated
    }
    return session
  }

  /**
   * Tail the JSONL for one `system.turn_duration` event and auto-transition to
   * `awaiting_input`. Fire-and-forget; watcher closes itself once triggered.
   * Default starts at current file size (only new events). Pass fromStart=true
   * to replay from the beginning — used on resume to catch an already-ended turn.
   */
  private watchForTurnEnd(uuid: string, jsonlPath: string, opts?: { fromStart?: boolean }): void {
    // Close any prior watcher for this session first
    const prior = this.turnWatchers.get(uuid)
    if (prior) {
      prior.close()
      this.turnWatchers.delete(uuid)
    }

    let startOffset = 0
    if (!opts?.fromStart) {
      try {
        startOffset = fs.statSync(jsonlPath).size
      } catch { /* file may not exist yet */ }
    }

    const tailer = new TranscriptTailer(uuid, jsonlPath, this.dataDir, {
      startOffset,
      persistOffset: false,
    })
    this.turnWatchers.set(uuid, tailer)

    // Track the last assistant text so we can heuristically decide whether the
    // agent asked a question (→ needs_input) or the turn just ended (→ idle).
    let lastAssistantText = ''

    tailer.on('event', async (ev: { event: unknown }) => {
      const obj = ev.event as {
        type?: string
        subtype?: string
        message?: { content?: Array<{ type?: string; text?: string }> }
      } | null
      if (!obj) return

      // Buffer the most recent assistant text block seen in this stream.
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const b of obj.message!.content!) {
          if (b.type === 'text' && b.text) lastAssistantText = b.text
        }
        return
      }

      if (obj.type !== 'system' || obj.subtype !== 'turn_duration') return
      const current = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
      if (current && (current.status === 'running' || current.status === 'idle' || current.status === 'needs_input')) {
        const next: SessionStatus = textAsksQuestion(lastAssistantText) ? 'needs_input' : 'idle'
        // Only transition if it's a legal move from current state.
        if (ALLOWED_TRANSITIONS[current.status].includes(next)) {
          await this.transition(uuid, next).catch(() => {})
        }
      }
      tailer.close()
      this.turnWatchers.delete(uuid)
    })

    tailer.start().catch(() => {
      this.turnWatchers.delete(uuid)
    })
  }

  /**
   * Mark a session as succeeded — user says "task done". Kills the tmux
   * session to free resources, then transitions to `succeeded` (terminal,
   * read-only). Session file + transcript stay for review.
   */
  async archive(uuid: string): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    // Sleeping sessions can also be archived — no tmux to kill, straight
    // path to 'succeeded'. The state machine already allows sleeping →
    // succeeded; this guard was the only thing rejecting the flow.
    const ARCHIVABLE: SessionStatus[] = ['needs_input', 'idle', 'waiting', 'running', 'sleeping']
    if (!ARCHIVABLE.includes(session.status)) {
      throw new Error(`Cannot archive session in ${session.status} state`)
    }

    // Close watcher
    const watcher = this.turnWatchers.get(uuid)
    if (watcher) {
      watcher.close()
      this.turnWatchers.delete(uuid)
    }

    // Kill tmux — session archived means we don't need the process anymore
    const adapter = this.registry.getOrThrow(session.agentType)
    await adapter.kill({
      tmuxName: session.tmuxName,
      claudeUuid: session.claudeSessionUuid,
      jsonlPath: session.jsonlPath,
    }).catch(() => { /* tmux may already be gone */ })

    // Direct terminal transition. Every allowed pre-state (idle,
    // needs_input, running, sleeping) goes straight to 'succeeded'.
    const succeeded = await this.transition(uuid, 'succeeded')

    // Terminal-report callback: if this session had a parent, deliver a
    // sanitized summary to the parent's input (tycho-style). Fire-and-forget.
    if (session.parentSessionId) {
      this.deliverTerminalReport(session.parentSessionId, session).catch((err) =>
        console.warn(`[session-manager] terminal-report to parent failed: ${(err as Error).message}`),
      )
    }
    return succeeded
  }

  /** Read last assistant text from a session's JSONL (best-effort summary). */
  private async readLastAssistantText(jsonlPath: string): Promise<string> {
    try {
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(jsonlPath, 'utf8')
      let last = ''
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const o = JSON.parse(line) as {
            type?: string
            message?: { content?: Array<{ type?: string; text?: string }> }
          }
          if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
            for (const b of o.message!.content!) {
              if (b.type === 'text' && b.text) last = b.text
            }
          }
        } catch { /* skip */ }
      }
      return last
    } catch { return '' }
  }

  /**
   * Deliver a terminal report to the parent session — sanitized summary
   * queued as a user turn. Uses sendInput which handles all statuses.
   */
  private async deliverTerminalReport(parentId: string, child: SessionMetadata): Promise<void> {
    const parent = await readJson<SessionMetadata | null>(this.sessionPath(parentId), null)
    if (!parent) return
    // Only deliver if parent is alive (not terminal).
    const TERMINAL: SessionStatus[] = ['succeeded', 'failed', 'killed']
    if (TERMINAL.includes(parent.status)) return

    const summary = (await this.readLastAssistantText(child.jsonlPath)).slice(0, 800)
    const report = [
      `[Child session ${child.id.slice(0, 8)} archived — status: ${child.status}]`,
      child.initialPrompt ? `Original prompt: ${child.initialPrompt.slice(0, 200)}` : '',
      summary ? `Final response: ${summary}` : '(no assistant output)',
    ].filter(Boolean).join('\n')

    await this.sendInput(parentId, report).catch(() => { /* parent might be busy */ })
  }

  async transition(uuid: string, newStatus: SessionStatus): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    const allowed = ALLOWED_TRANSITIONS[session.status]
    if (!allowed.includes(newStatus)) {
      throw new InvalidTransitionError(session.status, newStatus)
    }

    const terminal: SessionStatus[] = ['succeeded', 'failed', 'killed']
    const now = new Date().toISOString()
    const IDLE_STATES: SessionStatus[] = ['idle', 'needs_input']
    // Track idleSince: set when entering an idle-ish state, clear when leaving.
    let nextIdleSince: string | null | undefined = session.idleSince ?? null
    if (IDLE_STATES.includes(newStatus) && !IDLE_STATES.includes(session.status)) {
      nextIdleSince = now
    } else if (!IDLE_STATES.includes(newStatus)) {
      nextIdleSince = null
    }
    const updated: SessionMetadata = {
      ...session,
      status: newStatus,
      endedAt: terminal.includes(newStatus) ? now : session.endedAt,
      idleSince: nextIdleSince,
    }

    await writeJson(this.sessionPath(uuid), updated)

    // Sweeper arming based on target state.
    if (IDLE_STATES.includes(newStatus)) {
      this.armIdleSweeper(uuid)
    } else {
      this.clearIdleSweeper(uuid)
    }

    return updated
  }

  // ── Idle sweeper (warm-shutdown after inactivity) ─────────────────

  /** Arm a per-session warm-shutdown timer. No-op when idleTimeoutMs = 0. */
  private armIdleSweeper(uuid: string): void {
    if (this.idleTimeoutMs <= 0) return
    // Cancel any existing timer so we don't accumulate.
    this.clearIdleSweeper(uuid)
    const t = setTimeout(() => {
      this.warmShutdown(uuid).catch((err) => {
        console.warn(`[session-manager] warmShutdown ${uuid.slice(0, 8)} failed: ${(err as Error).message}`)
      })
    }, this.idleTimeoutMs)
    // Node timers hold the event loop open — unref so the process can exit
    // cleanly on shutdown without waiting for them.
    if (typeof t.unref === 'function') t.unref()
    this.idleSweepers.set(uuid, t)
  }

  private clearIdleSweeper(uuid: string): void {
    const t = this.idleSweepers.get(uuid)
    if (t) {
      clearTimeout(t)
      this.idleSweepers.delete(uuid)
    }
  }

  /**
   * Kill the tmux window and transition the session to 'sleeping'. Called
   * by the idle timer and by the safety-net sweep. Idempotent — a session
   * already sleeping (or terminal) is a no-op.
   */
  async warmShutdown(uuid: string): Promise<void> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) return
    const IDLE_STATES: SessionStatus[] = ['idle', 'needs_input']
    if (!IDLE_STATES.includes(session.status)) return
    const adapter = this.registry.getOrThrow(session.agentType)
    await adapter.kill({
      tmuxName: session.tmuxName,
      claudeUuid: session.claudeSessionUuid,
      jsonlPath: session.jsonlPath,
    }).catch(() => { /* tmux may already be dead */ })
    // Close any dangling watcher.
    const w = this.turnWatchers.get(uuid)
    if (w) { w.close(); this.turnWatchers.delete(uuid) }
    await this.transition(uuid, 'sleeping').catch(() => { /* race with kill */ })
  }

  /** Called from server boot — reconcile in-memory timers with disk state. */
  async resumeIdleSweepers(): Promise<void> {
    if (this.idleTimeoutMs <= 0) return
    const sessions = await this.list()
    const IDLE_STATES: SessionStatus[] = ['idle', 'needs_input']
    const now = Date.now()
    for (const s of sessions) {
      if (!IDLE_STATES.includes(s.status)) continue
      const since = s.idleSince ? Date.parse(s.idleSince) : Date.parse(s.endedAt ?? s.startedAt)
      const idleFor = now - since
      if (idleFor >= this.idleTimeoutMs) {
        // Already past threshold — warm-shutdown immediately.
        this.warmShutdown(s.id).catch(() => {})
      } else {
        // Arm a shortened timer for the remaining time.
        const remaining = this.idleTimeoutMs - idleFor
        this.clearIdleSweeper(s.id)
        const t = setTimeout(() => {
          this.warmShutdown(s.id).catch(() => {})
        }, remaining)
        if (typeof t.unref === 'function') t.unref()
        this.idleSweepers.set(s.id, t)
      }
    }
    // Safety-net sweep — every 10 minutes, catch orphans whose timer got lost.
    if (!this.safetyNetSweep) {
      this.safetyNetSweep = setInterval(() => {
        this.sweepOrphans().catch(() => {})
      }, 10 * 60 * 1000)
      if (typeof this.safetyNetSweep.unref === 'function') this.safetyNetSweep.unref()
    }
  }

  private async sweepOrphans(): Promise<void> {
    if (this.idleTimeoutMs <= 0) return
    const sessions = await this.list()
    const IDLE_STATES: SessionStatus[] = ['idle', 'needs_input']
    const now = Date.now()
    for (const s of sessions) {
      if (!IDLE_STATES.includes(s.status)) continue
      if (this.idleSweepers.has(s.id)) continue    // covered by primary timer
      const since = s.idleSince ? Date.parse(s.idleSince) : Date.parse(s.endedAt ?? s.startedAt)
      if (now - since >= this.idleTimeoutMs) {
        console.warn(`[session-manager] safety-net sweep: warm-shutdown orphan ${s.id.slice(0, 8)}`)
        this.warmShutdown(s.id).catch(() => {})
      } else {
        // Re-arm primary timer.
        this.armIdleSweeper(s.id)
      }
    }
  }

  async resume(uuid: string, workspace: string): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    const adapter = this.registry.getOrThrow(session.agentType)
    await adapter.resume(session.claudeSessionUuid, { workspace })
    return session
  }

  /**
   * Reopen a terminal (succeeded/killed/failed) session — bring it back to
   * `idle` state by spawning a fresh tmux + claude with --resume so the same
   * Claude session continues. Same orchestron UUID, same claudeSessionUuid,
   * new tmux name.
   */
  /**
   * Respawn a terminal session IN-PLACE — reuses the same orchestron session
   * id + record, but starts a fresh Claude conversation (new claudeSessionUuid,
   * new tmux, new JSONL). initialPrompt / model / effort / project all
   * preserved. Old Claude JSONL is left on disk untouched (Claude CLI owns
   * that directory).
   *
   * Contrast with reopen(): reopen keeps the same claudeSessionUuid and
   * resumes the prior conversation. Respawn discards the prior conversation
   * and starts over from the initialPrompt.
   */
  async respawn(uuid: string, workspace: string, configDir?: string, fallbackModel?: string, fallbackEffort?: import('@agent-hq-orchestron/shared').EffortLevel, overrides?: { model?: string; effort?: import('@agent-hq-orchestron/shared').EffortLevel }): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    const TERMINAL: SessionStatus[] = ['succeeded', 'killed', 'failed']
    if (!TERMINAL.includes(session.status)) {
      throw new Error(`Cannot respawn session in ${session.status} state — only terminal states are supported`)
    }

    // Spawn a fresh Claude conversation. adapter.spawn() generates a new
    // claudeSessionUuid internally + returns handle with new tmuxName + jsonlPath.
    const adapter = this.registry.getOrThrow(session.agentType)
    const mcpConfigPath = await this.ensureSessionMcpConfig(uuid)
    const { effectiveClaudeConfigDir } = await import('../adapters/claude.js')
    const effectiveConfigDir = session.agentType === 'claude'
      ? effectiveClaudeConfigDir(configDir ?? session.configDir)
      : (configDir ?? session.configDir)
    await this.ensureMemorySymlink(session.agentType, effectiveConfigDir, workspace)
    const effectiveModel = overrides?.model ?? session.model ?? fallbackModel
    const effectiveEffort = overrides?.effort ?? session.effort ?? fallbackEffort

    const handle = await adapter.spawn({
      projectId: session.projectId,
      agentType: session.agentType,
      initialPrompt: session.initialPrompt,
      workspace,
      configDir: effectiveConfigDir,
      model: effectiveModel,
      effort: effectiveEffort,
      detached: session.detached,
      mcpConfigPath,
    })

    // Transition terminal → spawning first (state machine now allows this),
    // then overwrite the mutable identity fields with the new Claude session.
    await this.transition(uuid, 'spawning')
    const updated: SessionMetadata = {
      ...session,
      status: 'spawning',
      claudeSessionUuid: handle.claudeUuid,
      tmuxName: handle.tmuxName,
      jsonlPath: handle.jsonlPath,
      configDir: effectiveConfigDir,
      model: effectiveModel,
      effort: effectiveEffort,
      endedAt: null,
      idleSince: null,
      finalResponse: null,
      tokenUsage: null,
      costUsd: null,
      failureReason: undefined,
    }
    await writeJson(this.sessionPath(uuid), updated)

    // Kick off the async completion — waitTuiReady → paste → running.
    this.completeSpawn(uuid, adapter, handle, session.initialPrompt, {
      projectId: session.projectId,
      agentType: session.agentType,
      initialPrompt: session.initialPrompt,
      workspace,
      configDir: effectiveConfigDir,
      model: effectiveModel,
      effort: effectiveEffort,
      detached: session.detached,
    }).catch(async (err: unknown) => {
      const msg = (err as Error).message ?? String(err)
      console.error(`[session-manager] completeSpawn during respawn failed for ${uuid}: ${msg}`)
      try {
        const rec = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
        if (rec && rec.status !== 'failed') {
          await this.transition(uuid, 'failed').catch(() => {})
        }
      } catch { /* ignore */ }
    })

    return updated
  }

  async reopen(uuid: string, workspace: string, configDir?: string, fallbackModel?: string, fallbackEffort?: import('@agent-hq-orchestron/shared').EffortLevel, overrides?: { model?: string; effort?: import('@agent-hq-orchestron/shared').EffortLevel }): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    const REOPENABLE: SessionStatus[] = ['succeeded', 'killed', 'failed']
    if (!REOPENABLE.includes(session.status)) {
      throw new Error(`Cannot reopen session in ${session.status} state`)
    }

    // Refuse when the underlying Claude JSONL doesn't exist — happens when
    // the original spawn failed before Claude wrote its first turn. `claude
    // --resume <uuid>` would just say "No conversation found" and die.
    const { existsSync } = await import('node:fs')
    if (!existsSync(session.jsonlPath)) {
      throw new Error(
        `Cannot reopen: original Claude conversation has no transcript on disk (${session.claudeSessionUuid}). ` +
        `The initial spawn likely failed before writing any turn. Start a fresh session with the same prompt instead.`,
      )
    }

    // Precedence for model/effort: caller override > session's own value >
    // project default. Overrides let the user pick a different model/effort
    // just for this reopen without permanently mutating the record.
    const effectiveModel = overrides?.model ?? session.model ?? fallbackModel
    const effectiveEffort = overrides?.effort ?? session.effort ?? fallbackEffort

    const adapter = this.registry.getOrThrow(session.agentType)
    await this.ensureMemorySymlink(session.agentType, configDir ?? session.configDir, workspace)
    // Regenerate MCP config on every reopen so token/URL updates take effect.
    const mcpConfigPath = await this.ensureSessionMcpConfig(uuid)
    const handle = await adapter.resume(session.claudeSessionUuid, {
      workspace,
      configDir,
      model: effectiveModel,
      effort: effectiveEffort,
      mcpConfigPath,
    })

    // Manually rewrite session record — reopen changes tmuxName + jsonlPath
    // + endedAt (cleared) but keeps id, claudeSessionUuid, initialPrompt, etc.
    // Persist the effective model/effort so the UI shows them going forward.
    const updated: SessionMetadata = {
      ...session,
      model: effectiveModel,
      effort: effectiveEffort,
      status: 'spawning',
      tmuxName: handle.tmuxName,
      jsonlPath: handle.jsonlPath,
      endedAt: null,
    }
    await writeJson(this.sessionPath(uuid), updated)

    // Complete the spawn lifecycle (wait TUI ready → transition to idle/waiting).
    // We DON'T re-send the initial prompt on reopen — the resumed session
    // already has all history; user drives via /input for new turns.
    this.completeReopen(uuid, adapter, handle, {
      claudeSessionUuid: session.claudeSessionUuid,
      workspace,
      configDir: configDir ?? session.configDir,
      model: effectiveModel,
      effort: effectiveEffort,
    }).catch(async (err: unknown) => {
      const msg = (err as Error).message ?? String(err)
      console.error(`[session-manager] completeReopen failed for ${uuid}: ${msg}`)
      try {
        await this.transition(uuid, 'failed').catch(() => {})
        const failed = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
        if (failed) {
          failed.failureReason = msg
          await writeJson(this.sessionPath(uuid), failed)
        }
      } catch { /* ignore */ }
    })

    return updated
  }

  private async completeReopen(
    uuid: string,
    adapter: import('@agent-hq-orchestron/shared').AgentAdapter,
    handle: import('@agent-hq-orchestron/shared').TmuxHandle,
    resumeCtx?: {
      claudeSessionUuid: string
      workspace: string
      configDir?: string
      model?: string
      effort?: import('@agent-hq-orchestron/shared').EffortLevel
    },
  ): Promise<void> {
    let currentHandle = handle
    let attempt = 0
    const MAX_ATTEMPTS = 2

    while (true) {
      try {
        await adapter.waitTuiReady(currentHandle, 30_000)
        break
      } catch (err: unknown) {
        const msg = (err as Error).message ?? ''
        const paneDied = msg.includes('can\'t find pane') || msg.includes('no such pane')
        attempt += 1
        if (!paneDied || attempt >= MAX_ATTEMPTS || !resumeCtx) throw err
        console.warn(`[session-manager] tmux pane died during reopen for ${uuid}, retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})`)
        await adapter.kill(currentHandle).catch(() => {})
        const mcpConfigPath = await this.ensureSessionMcpConfig(uuid)
        const fresh = await adapter.resume(resumeCtx.claudeSessionUuid, {
          workspace: resumeCtx.workspace,
          configDir: resumeCtx.configDir,
          model: resumeCtx.model,
          effort: resumeCtx.effort,
          mcpConfigPath,
        })
        currentHandle = fresh
        // Update the session record with the new tmux/jsonl handle.
        const rec = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
        if (rec) {
          await writeJson(this.sessionPath(uuid), {
            ...rec,
            tmuxName: fresh.tmuxName,
            jsonlPath: fresh.jsonlPath,
          })
        }
      }
    }
    // Reopen goes STRAIGHT to idle — no fresh prompt to send.
    await this.transition(uuid, 'waiting')
    await this.transition(uuid, 'running')
    await this.transition(uuid, 'idle')
  }

  /**
   * Clone/fork a session — spawn a NEW orchestron session that inherits the
   * original's Claude conversation (via --resume). Creates a new orchestron
   * UUID + new tmux; original session record is untouched.
   */
  async clone(uuid: string, spawnConfig: Pick<SpawnConfig, 'workspace' | 'configDir'>, extraPrompt?: string, fallbackModel?: string, fallbackEffort?: import('@agent-hq-orchestron/shared').EffortLevel, overrides?: { model?: string; effort?: import('@agent-hq-orchestron/shared').EffortLevel }): Promise<SessionMetadata> {
    const active = await this.countActiveSessions()
    if (active >= this.maxConcurrent) {
      throw new PoolFullError(this.maxConcurrent)
    }

    const original = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!original) throw new Error(`Session not found: ${uuid}`)

    // Refuse when the source has no Claude transcript to fork from.
    const { existsSync } = await import('node:fs')
    if (!existsSync(original.jsonlPath)) {
      throw new Error(
        `Cannot fork: original Claude conversation has no transcript on disk (${original.claudeSessionUuid}). ` +
        `Nothing to inherit. Start a fresh session instead.`,
      )
    }

    // Overrides let the user pick different model/effort for the fork
    // without touching the original. Falls back to original's, then project.
    const effectiveModel = overrides?.model ?? original.model ?? fallbackModel
    const effectiveEffort = overrides?.effort ?? original.effort ?? fallbackEffort

    const newUuid = crypto.randomUUID()
    const adapter = this.registry.getOrThrow(original.agentType)
    await this.ensureMemorySymlink(original.agentType, spawnConfig.configDir ?? original.configDir, spawnConfig.workspace)
    // Fresh MCP config keyed to the CLONE's uuid so its ORCHESTRON_SESSION_ID
    // reflects the child, not the parent.
    const mcpConfigPath = await this.ensureSessionMcpConfig(newUuid)
    // Spawn via adapter.resume — reuses the ORIGINAL claudeSessionUuid so
    // Claude loads that context. Fresh tmux name.
    const handle = await adapter.resume(original.claudeSessionUuid, {
      workspace: spawnConfig.workspace,
      configDir: spawnConfig.configDir,
      model: effectiveModel,
      effort: effectiveEffort,
      mcpConfigPath,
    })

    const now = new Date().toISOString()
    const session: SessionMetadata = {
      id: newUuid,
      projectId: original.projectId,
      agentType: original.agentType,
      model: effectiveModel,
      effort: effectiveEffort,
      status: 'spawning',
      parentSessionId: original.id,   // record fork lineage
      detached: original.detached,
      claudeSessionUuid: original.claudeSessionUuid,   // share Claude session
      tmuxName: handle.tmuxName,
      jsonlPath: handle.jsonlPath,
      initialPrompt: extraPrompt ? extraPrompt : `(fork of ${original.id.slice(0, 8)})`,
      finalResponse: null,
      tokenUsage: null,
      costUsd: null,
      startedAt: now,
      endedAt: null,
      metadata: { forkedFrom: original.id },
    }

    await writeJson(this.sessionPath(newUuid), session)

    // Complete lifecycle: wait TUI ready, optionally send extraPrompt, transition
    this.completeReopen(newUuid, adapter, handle, {
      claudeSessionUuid: original.claudeSessionUuid,
      workspace: spawnConfig.workspace,
      configDir: spawnConfig.configDir ?? original.configDir,
      model: effectiveModel,
      effort: effectiveEffort,
    })
      .then(async () => {
        if (extraPrompt) {
          // Send the fork's optional new prompt after resume settles
          const inputAllowed: SessionStatus[] = ['idle', 'needs_input', 'waiting']
          const cur = await readJson<SessionMetadata | null>(this.sessionPath(newUuid), null)
          if (cur && inputAllowed.includes(cur.status)) {
            await adapter.sendPrompt(handle, extraPrompt)
            await this.transition(newUuid, 'running').catch(() => {})
            this.watchForTurnEnd(newUuid, handle.jsonlPath)
          }
        }
      })
      .catch(async (err: unknown) => {
        const msg = (err as Error).message ?? String(err)
        console.error(`[session-manager] clone completion failed for ${newUuid}: ${msg}`)
        try {
          await this.transition(newUuid, 'failed').catch(() => {})
          const failed = await readJson<SessionMetadata | null>(this.sessionPath(newUuid), null)
          if (failed) {
            failed.failureReason = msg
            await writeJson(this.sessionPath(newUuid), failed)
          }
        } catch { /* ignore */ }
      })

    return session
  }

  async kill(uuid: string): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    const watcher = this.turnWatchers.get(uuid)
    if (watcher) {
      watcher.close()
      this.turnWatchers.delete(uuid)
    }

    const adapter = this.registry.getOrThrow(session.agentType)
    await adapter.kill({
      tmuxName: session.tmuxName,
      claudeUuid: session.claudeSessionUuid,
      jsonlPath: session.jsonlPath,
    })

    return this.transition(uuid, 'killed')
  }

  /**
   * On boot, resume turn-end watchers for any session still marked `running`.
   * Watchers are in-memory only; without this, a server restart leaves
   * previously-running sessions unable to auto-transition to `awaiting_input`.
   * Uses startOffset=0 so a turn already ended in the JSONL still triggers.
   */
  async resumeWatchers(): Promise<void> {
    const sessions = await this.list()
    // One-time migration: legacy `awaiting_input` sessions become `idle` under
    // the new state model (backward-compat). If we later detect a question in
    // their last assistant text, the next watcher will bump them to needs_input.
    for (const s of sessions) {
      const legacyStatus = s.status as unknown as string
      if (legacyStatus === 'awaiting_input') {
        const migrated: SessionMetadata = { ...s, status: 'idle' }
        await writeJson(this.sessionPath(s.id), migrated).catch(() => {})
      }
    }
    // Re-read after migration
    const fresh = await this.list()
    for (const s of fresh) {
      if (s.status === 'running') {
        this.watchForTurnEnd(s.id, s.jsonlPath, { fromStart: true })
      }
    }
  }

  async list(filter?: { status?: string; projectId?: string; from?: string; to?: string }): Promise<SessionMetadata[]> {
    const files = await listDir(this.sessionsDir)
    const sessions: SessionMetadata[] = []
    const { existsSync } = await import('node:fs')

    await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => {
          const uuid = f.replace(/\.json$/, '')
          const record = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
          if (!record) return
          // Runtime hint: does the Claude JSONL still exist on disk? Consumed
          // by the UI to decide if Reopen/Fork are viable (they need the
          // conversation to resume from). Cheap stat, batched here so callers
          // don't have to check per-session.
          record.hasTranscript = existsSync(record.jsonlPath)
          sessions.push(record)
        }),
    )

    const filtered = sessions.filter(s => {
      if (filter?.status && s.status !== filter.status) return false
      if (filter?.projectId && s.projectId !== filter.projectId) return false
      if (filter?.from && s.startedAt < filter.from) return false
      if (filter?.to && s.startedAt > filter.to) return false
      return true
    })

    // Order by "last activity" — endedAt when the session has one, else
    // startedAt (matches Tycho: `finished_at || started_at || created_at`,
    // desc). Keeps the "loudest right now" session at the top and reflects
    // recent input/interrupt/archive events naturally.
    return filtered.sort((a, b) => {
      const at = a.endedAt ?? a.startedAt
      const bt = b.endedAt ?? b.startedAt
      return at < bt ? 1 : at > bt ? -1 : 0
    })
  }

  private async countActiveSessions(): Promise<number> {
    const all = await this.list()
    const terminal: SessionStatus[] = ['succeeded', 'failed', 'killed']
    return all.filter((s) => !terminal.includes(s.status)).length
  }
}
