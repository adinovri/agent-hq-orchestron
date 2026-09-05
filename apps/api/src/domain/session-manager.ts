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

    const uuid = crypto.randomUUID()
    const adapter = this.registry.getOrThrow(spawnConfig.agentType)
    const handle = await adapter.spawn(spawnConfig)

    const now = new Date().toISOString()
    const session: SessionMetadata = {
      id: uuid,
      projectId: spawnConfig.projectId,
      agentType: spawnConfig.agentType,
      model: spawnConfig.model,
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
    this.completeSpawn(uuid, adapter, handle, spawnConfig.initialPrompt).catch(async (err: unknown) => {
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
  ): Promise<void> {
    // TUI ready (auto-dismisses trust/menu interstitials) — 30s timeout for cold start
    await adapter.waitTuiReady(handle, 30_000)
    await this.transition(uuid, 'waiting')

    // Paste initial prompt + Enter
    await adapter.sendPrompt(handle, prompt)
    await this.transition(uuid, 'running')
    this.watchForTurnEnd(uuid, handle.jsonlPath)
  }

  async sendInput(uuid: string, prompt: string): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    const INPUT_ALLOWED: SessionStatus[] = ['needs_input', 'idle', 'waiting']
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
    const updated = await this.transition(uuid, 'running')
    this.watchForTurnEnd(uuid, session.jsonlPath)
    return updated
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
    return this.transition(uuid, 'succeeded')
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
