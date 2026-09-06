/**
 * Codex CLI adapter — interactive tmux mode, mirrors ClaudeAdapter architecture.
 *
 * DESIGN DECISIONS (2026-09-06):
 * - Interactive TUI (not `codex exec`) — live mid-turn streaming + no cold-
 *   start latency per turn. Same rationale as Claude adapter.
 * - Fork + Archive are orchestron-level concepts only. Do NOT invoke codex's
 *   native `codex fork` / `codex archive` — those touch codex's own session
 *   registry, which we don't want to disturb. Fork orchestron-side spawns
 *   another tmux against the SAME codexSessionId (mirror of Claude sharing
 *   claudeSessionUuid across forks).
 * - Codex assigns its own session UUID (v7, timestamp-prefixed). Adapter
 *   MUST capture it from the TUI/rollout after spawn — cannot pre-assign.
 *
 * VERIFIED (probed 2026-09-06):
 * - Rollout path: <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<iso-ts>-<uuid>.jsonl
 * - Rollout format: JSONL {timestamp, ordinal, type, payload}
 *   types: session_meta | event_msg | response_item | token_usage_record
 *          | turn_context | world_state
 * - Trust prompt on first workspace: numbered menu, default on "Yes, continue",
 *   Enter accepts. Persists in ~/.codex/config.toml.
 * - Default model: gpt-6-astra
 * - Sandbox flags: --sandbox danger-full-access + --ask-for-approval never
 *   ≈ Claude's --permission-mode bypassPermissions.
 *
 * STILL TODO(probe):
 * - Session ID capture strategy — regex from initial TUI banner? Watch rollout dir?
 * - MCP config surface — config.toml [mcp_servers] section, per-session dir
 * - Turn boundary detection in rollout — analog of Claude's turn_duration event
 */
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import type { AgentAdapter, SpawnConfig, ResumeConfig, TmuxHandle } from '@agent-hq-orchestron/shared'
import * as tmux from './tmux.js'

// Ready marker: codex TUI banner shows `>_ OpenAI Codex (v0.x.y)` in a box
// with a `› Ask Codex to do anything` prompt row underneath. Match on either.
const TUI_READY_RE = /OpenAI Codex \(v[0-9]|Ask Codex to do anything/

// Trust folder: numbered menu, default on "Yes, continue". Enter accepts.
// Persisted in ~/.codex/config.toml [projects."<workspace>"] trust_level.
const TRUST_PROMPT_RE = /Do you trust the contents|1\.\s*Yes,\s*continue/

// TODO(probe): sandbox approval prompt shape when user runs shell commands
// that exceed sandbox mode. Placeholder — may only appear with
// --ask-for-approval on-request (we pass 'never').
const SANDBOX_PROMPT_RE = /Approve this command|allow.*shell|Confirm sandbox/i

// Generic esc-dismissable modal.
const ESC_DISMISS_RE = /Esc to (cancel|dismiss|close)/i

// Extract the codex-assigned session UUID from the TUI banner or rollout
// header. Codex prints it in `codex exec` header ("session id: <uuid>");
// for interactive TUI we may need to watch the rollout directory instead.
// UUID v7 pattern (timestamp-prefixed) — match anywhere in pane text.
const SESSION_ID_RE = /session id:\s*([0-9a-f-]{36})/i

/** Effective CODEX_HOME — falls back to env var, then default ~/.codex.
 *  Analog of effectiveClaudeConfigDir. Exported for session-manager to
 *  persist in SessionMetadata.configDir at spawn time. */
export function effectiveCodexHome(explicit?: string): string {
  return expandHome(explicit ?? process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex'))
}

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  if (p === '~') return os.homedir()
  return p
}

/**
 * Compute the rollout JSONL file path codex writes to.
 * VERIFIED path pattern:
 *   <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
 *
 * Since the ISO timestamp is unknown until codex writes the file, this
 * helper GLOBS by suffix (session uuid). Returns null if not found yet —
 * caller should retry or wait after spawn.
 */
async function findCodexRolloutPath(codexHome: string | undefined, sessionId: string): Promise<string | null> {
  const baseDir = effectiveCodexHome(codexHome)
  const sessionsDir = path.join(baseDir, 'sessions')
  const { readdir, stat } = await import('node:fs/promises')

  // Walk YYYY/MM/DD tree — small (few dirs per year) so cheap.
  // Fast path: most recent activity is today, walk newest-first.
  async function walk(dir: string, depth: number): Promise<string | null> {
    let entries: string[]
    try { entries = (await readdir(dir)).sort().reverse() } catch { return null }
    for (const entry of entries) {
      const full = path.join(dir, entry)
      if (depth < 3) {
        const s = await stat(full).catch(() => null)
        if (s?.isDirectory()) {
          const found = await walk(full, depth + 1)
          if (found) return found
        }
      } else if (entry.endsWith(`-${sessionId}.jsonl`)) {
        return full
      }
    }
    return null
  }
  return walk(sessionsDir, 0)
}

function buildArgv(opts: {
  model?: string
  workspace: string
  sessionMode: { type: 'new' } | { type: 'resume'; sessionId: string }
  bypassApprovals?: boolean
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  mcpConfigInline?: string[]
}): string[] {
  // Root command vs `codex resume` subcommand. Interactive TUI = root
  // command with prompt-less start; resume = `codex resume <uuid>`.
  const argv: string[] = ['codex']
  if (opts.sessionMode.type === 'resume') {
    argv.push('resume', opts.sessionMode.sessionId)
  }

  // MCP inline config overrides (`-c mcp_servers.NAME.*=VALUE`) — must come
  // BEFORE other flags so codex sees them at config-parse time.
  if (opts.mcpConfigInline && opts.mcpConfigInline.length > 0) {
    argv.push(...opts.mcpConfigInline)
  }

  if (opts.model) argv.push('--model', opts.model)

  // Interactive TUI in tmux — inline mode preserves scrollback for orchestron
  // pane capture. Root command doesn't accept --skip-git-repo-check (that's
  // only under `exec` subcommand); we rely on trust-prompt auto-dismiss.
  argv.push('--no-alt-screen')

  // Sandbox + approval: YOLO mode = bypass everything, analog of Claude's
  // --permission-mode bypassPermissions. Otherwise use sandbox flag +
  // ask-for-approval never so codex doesn't block on shell prompts.
  if (opts.bypassApprovals) {
    argv.push('--dangerously-bypass-approvals-and-sandbox')
  } else {
    argv.push('--sandbox', opts.sandbox ?? 'workspace-write')
    argv.push('--ask-for-approval', 'never')
  }

  return argv
}

export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex'

  async spawn(config: SpawnConfig): Promise<TmuxHandle> {
    // Codex assigns the session UUID (v7 timestamp-prefixed). We generate a
    // temporary tmux name using a random tag, then reconcile the real
    // codexSessionId after TUI is ready by scanning the rollout directory.
    const tmpTag = crypto.randomBytes(4).toString('hex')
    const tmuxName = `orchestron-codex-${tmpTag}`

    const argv = buildArgv({
      model: config.model,
      workspace: config.workspace,
      sessionMode: { type: 'new' },
      bypassApprovals: true,
      mcpConfigInline: config.mcpConfigInline,
    })

    const env: NodeJS.ProcessEnv | undefined = config.configDir
      ? { CODEX_HOME: expandHome(config.configDir) }
      : undefined

    const [cmd, ...args] = argv
    await tmux.newSession(tmuxName, [cmd!, ...args], config.workspace, env)

    // Placeholder handle — caller must call captureSessionId() after
    // waitTuiReady to populate the real claudeUuid + jsonlPath. Placeholder
    // values here are best-effort; downstream code should treat as pending.
    return { tmuxName, claudeUuid: '', jsonlPath: '' }
  }

  /**
   * After a fresh spawn, capture the codex-assigned session UUID by scanning
   * the rollout directory for the newest rollout file. Called by session-
   * manager between waitTuiReady and status transition to 'waiting'.
   *
   * TODO(probe): confirm codex also prints session id in interactive TUI
   * header — if yes, parse from tmux.capturePane instead of dir scan.
   */
  async captureNewSessionId(handle: TmuxHandle, codexHome?: string, timeoutMs = 10_000, spawnedAfter?: number): Promise<{ sessionId: string; jsonlPath: string }> {
    // First try pane capture for `session id: <uuid>` line
    const pane = await tmux.capturePane(handle.tmuxName).catch(() => '')
    const paneMatch = SESSION_ID_RE.exec(pane)
    if (paneMatch?.[1]) {
      const sid = paneMatch[1]
      const jsonlPath = await findCodexRolloutPath(codexHome, sid) ?? ''
      if (jsonlPath) return { sessionId: sid, jsonlPath }
    }

    // Fallback: watch rollout dir for a NEW file that appeared after this spawn.
    // Interactive TUI (codex --no-alt-screen) does NOT write JSONL rollout files —
    // those are only created by `codex exec`. When spawnedAfter is set we filter out
    // pre-existing files so a stale exec-mode rollout is not mistaken for this session.
    // If no matching file appears within timeoutMs, return empty (caller keeps empty
    // ids and relies on idle-timeout for session lifecycle management).
    const baseDir = effectiveCodexHome(codexHome)
    const sessionsDir = path.join(baseDir, 'sessions')
    const { readdir } = await import('node:fs/promises')

    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      // Newest rollout file across YYYY/MM/DD tree, optionally newer than spawnedAfter
      async function newestRollout(dir: string, depth: number): Promise<{ path: string; mtime: number } | null> {
        let entries: string[]
        try { entries = (await readdir(dir)).sort().reverse() } catch { return null }
        for (const entry of entries) {
          const full = path.join(dir, entry)
          if (depth < 3) {
            const found = await newestRollout(full, depth + 1)
            if (found) return found
          } else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) {
            const { stat } = await import('node:fs/promises')
            const s = await stat(full).catch(() => null)
            if (s && (spawnedAfter === undefined || s.mtimeMs > spawnedAfter)) {
              return { path: full, mtime: s.mtimeMs }
            }
          }
        }
        return null
      }
      const newest = await newestRollout(sessionsDir, 0)
      if (newest) {
        // Extract UUID from filename: rollout-<iso>-<uuid>.jsonl
        const m = /-([0-9a-f-]{36})\.jsonl$/i.exec(newest.path)
        if (m?.[1]) return { sessionId: m[1], jsonlPath: newest.path }
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    // No rollout found within timeout. Interactive TUI sessions don't create rollout
    // JSONL — return empty so caller can manage lifecycle via idle-timeout instead.
    return { sessionId: '', jsonlPath: '' }
  }

  async resume(sessionUuid: string, config: ResumeConfig): Promise<TmuxHandle> {
    const tmuxName = `orchestron-codex-${sessionUuid.slice(0, 8)}-${crypto.randomBytes(3).toString('hex')}`

    const argv = buildArgv({
      model: config.model,
      workspace: config.workspace,
      sessionMode: { type: 'resume', sessionId: sessionUuid },
      bypassApprovals: true,
      mcpConfigInline: config.mcpConfigInline,
    })

    const env: NodeJS.ProcessEnv | undefined = config.configDir
      ? { CODEX_HOME: expandHome(config.configDir) }
      : undefined

    const [cmd, ...args] = argv
    await tmux.newSession(tmuxName, [cmd!, ...args], config.workspace, env)

    // On resume, jsonlPath is the ORIGINAL rollout file (codex appends).
    // Look it up by glob — the file already exists from prior activity.
    const jsonlPath = await findCodexRolloutPath(config.configDir, sessionUuid) ?? ''
    return { tmuxName, claudeUuid: sessionUuid, jsonlPath }
  }

  async waitTuiReady(handle: TmuxHandle, timeoutMs: number): Promise<void> {
    // Same skeleton as ClaudeAdapter.waitTuiReady — regexes TBD per codex TUI.
    const deadline = Date.now() + timeoutMs
    let lastDismissAt = 0
    while (Date.now() < deadline) {
      const pane = await tmux.capturePane(handle.tmuxName)

      const hasTrust = TRUST_PROMPT_RE.test(pane)
      const hasSandbox = SANDBOX_PROMPT_RE.test(pane)
      const hasEscDismissable = ESC_DISMISS_RE.test(pane)
      const canDismiss = Date.now() - lastDismissAt > 1500

      if (hasTrust && canDismiss) {
        // Codex trust: numbered menu, default cursor already on "Yes,
        // continue" (marked with ›). Enter accepts.
        await tmux.sendKeys(handle.tmuxName, 'Enter')
        lastDismissAt = Date.now()
      } else if (hasSandbox && canDismiss) {
        // TODO(probe): sandbox approvals may be y/n or Enter-to-approve.
        await tmux.sendKeys(handle.tmuxName, 'Enter')
        lastDismissAt = Date.now()
      } else if (hasEscDismissable && canDismiss) {
        await tmux.sendKeys(handle.tmuxName, 'Escape')
        lastDismissAt = Date.now()
      } else if (TUI_READY_RE.test(pane) && !hasTrust && !hasSandbox && !hasEscDismissable) {
        return
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 400))
    }
    throw new Error(`[codex] waitTuiReady timeout after ${timeoutMs}ms for ${handle.tmuxName}`)
  }

  async sendPrompt(handle: TmuxHandle, prompt: string): Promise<void> {
    // Same paste-buffer + wait-for-echo + Enter pattern as Claude adapter.
    await tmux.setBuffer(handle.tmuxName, prompt)
    await tmux.pasteBuffer(handle.tmuxName)

    const marker = prompt.trim().slice(0, 40)
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      const pane = await tmux.capturePane(handle.tmuxName)
      if (marker && pane.includes(marker)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    await new Promise((r) => setTimeout(r, 250))
    await tmux.sendKeys(handle.tmuxName, 'Enter')
  }

  async kill(handle: TmuxHandle): Promise<void> {
    await tmux.killSession(handle.tmuxName)
  }
}
