import crypto from 'node:crypto'
import path from 'node:path'
import { writeJson, readJson, listDir } from '@agent-hq-orchestron/file-store'
import type { SessionMetadata, SessionStatus, SpawnConfig } from '@agent-hq-orchestron/shared'
import type { AdapterRegistry } from '../adapters/registry.js'

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

// Legal transitions per the 7-state machine
const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  spawning: ['waiting', 'failed', 'killed'],
  waiting: ['running', 'killed'],
  running: ['running', 'completing', 'killed'],
  completing: ['completed', 'failed'],
  completed: [],
  failed: [],
  killed: [],
}

export interface SessionManagerConfig {
  dataDir: string
  maxConcurrent: number
}

export class SessionManager {
  private readonly sessionsDir: string
  private readonly maxConcurrent: number
  private readonly registry: AdapterRegistry

  constructor(config: SessionManagerConfig, registry: AdapterRegistry) {
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
    return session
  }

  async transition(uuid: string, newStatus: SessionStatus): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    const allowed = ALLOWED_TRANSITIONS[session.status]
    if (!allowed.includes(newStatus)) {
      throw new InvalidTransitionError(session.status, newStatus)
    }

    const terminal: SessionStatus[] = ['completed', 'failed', 'killed']
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

    const adapter = this.registry.getOrThrow(session.agentType)
    await adapter.kill({
      tmuxName: session.tmuxName,
      claudeUuid: session.claudeSessionUuid,
      jsonlPath: session.jsonlPath,
    })

    return this.transition(uuid, 'killed')
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
    const terminal: SessionStatus[] = ['completed', 'failed', 'killed']
    return all.filter((s) => !terminal.includes(s.status)).length
  }
}
