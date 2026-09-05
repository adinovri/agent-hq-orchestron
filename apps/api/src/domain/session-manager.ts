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
  running: ['running', 'idle', 'needs_input', 'completing', 'killed'],
  idle: ['running', 'needs_input', 'completing', 'succeeded', 'killed'],
  needs_input: ['running', 'idle', 'completing', 'succeeded', 'killed'],
  completing: ['completed', 'succeeded', 'failed'],
  completed: [],
  succeeded: [],
  failed: [],
  killed: [],
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
function textAsksQuestion(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return QUESTION_PHRASES.some((re) => re.test(t))
}

export interface SessionManagerConfig {
  dataDir: string
  maxConcurrent: number
}

export class SessionManager {
  private readonly dataDir: string
  private readonly sessionsDir: string
  private readonly maxConcurrent: number
  private readonly registry: AdapterRegistry
  // Watchers that flip running → awaiting_input on the next turn_duration event.
  // Keyed by session uuid; one active watcher per session at a time.
  private readonly turnWatchers = new Map<string, TranscriptTailer>()

  constructor(config: SessionManagerConfig, registry: AdapterRegistry) {
    this.dataDir = config.dataDir
    this.sessionsDir = path.join(config.dataDir, 'sessions')
    this.maxConcurrent = config.maxConcurrent
    this.registry = registry
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
    const handle = await adapter.spawn(spawnConfig)

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
    this.watchForTurnEnd(uuid, currentHandle.jsonlPath)
  }

  async sendInput(uuid: string, prompt: string): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

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

    const ARCHIVABLE: SessionStatus[] = ['needs_input', 'idle', 'waiting', 'running']
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

    // Direct transition via `completing` → `succeeded`
    await this.transition(uuid, 'completing').catch(() => {})
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
    const TERMINAL: SessionStatus[] = ['completed', 'succeeded', 'failed', 'killed']
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

    const terminal: SessionStatus[] = ['completed', 'succeeded', 'failed', 'killed']
    const updated: SessionMetadata = {
      ...session,
      status: newStatus,
      endedAt: terminal.includes(newStatus) ? new Date().toISOString() : session.endedAt,
    }

    await writeJson(this.sessionPath(uuid), updated)
    return updated
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
  async reopen(uuid: string, workspace: string, configDir?: string, fallbackModel?: string, fallbackEffort?: import('@agent-hq-orchestron/shared').EffortLevel): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    const REOPENABLE: SessionStatus[] = ['succeeded', 'killed', 'failed', 'completed']
    if (!REOPENABLE.includes(session.status)) {
      throw new Error(`Cannot reopen session in ${session.status} state`)
    }

    // Backfill model/effort from project defaults if the record is missing
    // them (old sessions predate the model/effort feature).
    const effectiveModel = session.model ?? fallbackModel
    const effectiveEffort = session.effort ?? fallbackEffort

    const adapter = this.registry.getOrThrow(session.agentType)
    const handle = await adapter.resume(session.claudeSessionUuid, {
      workspace,
      configDir,
      model: effectiveModel,
      effort: effectiveEffort,
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
    this.completeReopen(uuid, adapter, handle).catch(async (err: unknown) => {
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
  ): Promise<void> {
    await adapter.waitTuiReady(handle, 30_000)
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
  async clone(uuid: string, spawnConfig: Pick<SpawnConfig, 'workspace' | 'configDir'>, extraPrompt?: string, fallbackModel?: string, fallbackEffort?: import('@agent-hq-orchestron/shared').EffortLevel): Promise<SessionMetadata> {
    const active = await this.countActiveSessions()
    if (active >= this.maxConcurrent) {
      throw new PoolFullError(this.maxConcurrent)
    }

    const original = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!original) throw new Error(`Session not found: ${uuid}`)

    // Backfill model/effort from project defaults if the source lacks them
    // (old sessions predate the model/effort feature).
    const effectiveModel = original.model ?? fallbackModel
    const effectiveEffort = original.effort ?? fallbackEffort

    const newUuid = crypto.randomUUID()
    const adapter = this.registry.getOrThrow(original.agentType)
    // Spawn via adapter.resume — reuses the ORIGINAL claudeSessionUuid so
    // Claude loads that context. Fresh tmux name.
    const handle = await adapter.resume(original.claudeSessionUuid, {
      workspace: spawnConfig.workspace,
      configDir: spawnConfig.configDir,
      model: effectiveModel,
      effort: effectiveEffort,
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
    this.completeReopen(newUuid, adapter, handle)
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

    await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => {
          const uuid = f.replace(/\.json$/, '')
          const record = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
          if (record) sessions.push(record)
        }),
    )

    return sessions.filter(s => {
      if (filter?.status && s.status !== filter.status) return false
      if (filter?.projectId && s.projectId !== filter.projectId) return false
      if (filter?.from && s.startedAt < filter.from) return false
      if (filter?.to && s.startedAt > filter.to) return false
      return true
    })
  }

  private async countActiveSessions(): Promise<number> {
    const all = await this.list()
    const terminal: SessionStatus[] = ['completed', 'succeeded', 'failed', 'killed']
    return all.filter((s) => !terminal.includes(s.status)).length
  }
}
