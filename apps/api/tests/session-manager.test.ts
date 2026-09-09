import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SessionManager, PoolFullError, InvalidTransitionError } from '../src/domain/session-manager.js'
import { AdapterRegistry } from '../src/adapters/registry.js'
import type { AgentAdapter, TmuxHandle } from '@agent-hq-orchestron/shared'

let tmpDir: string

function makeAdapter(overrides?: Partial<AgentAdapter>): AgentAdapter {
  return {
    name: 'mock',
    spawn: vi.fn().mockResolvedValue({
      tmuxName: 'mock-session',
      claudeUuid: 'mock-claude-uuid',
      jsonlPath: '/tmp/mock.jsonl',
    } satisfies TmuxHandle),
    resume: vi.fn().mockResolvedValue({
      tmuxName: 'mock-resume',
      claudeUuid: 'mock-claude-uuid',
      jsonlPath: '/tmp/mock.jsonl',
    } satisfies TmuxHandle),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitTuiReady: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeManager(adapter: AgentAdapter, maxConcurrent = 3) {
  const registry = new AdapterRegistry()
  registry.register('claude', adapter)
  registry.register('mock', adapter)
  return new SessionManager({ dataDir: tmpDir, maxConcurrent }, registry)
}

const baseSpawn = {
  projectId: 'proj-1',
  agentType: 'claude' as const,
  initialPrompt: 'hello',
  workspace: '/tmp/ws',
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-mgr-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('SessionManager — spawn', () => {
  it('returns SessionMetadata with status spawning', async () => {
    const mgr = makeManager(makeAdapter())
    const session = await mgr.spawn(baseSpawn)
    expect(session.status).toBe('spawning')
    expect(session.projectId).toBe('proj-1')
    expect(session.id).toBeTruthy()
  })

  it('persists session to disk', async () => {
    const mgr = makeManager(makeAdapter())
    const session = await mgr.spawn(baseSpawn)
    const sessionsDir = path.join(tmpDir, 'sessions')
    const files = fs.readdirSync(sessionsDir)
    expect(files).toContain(`${session.id}.json`)
  })

  it('throws PoolFullError when pool is full', async () => {
    const adapter = makeAdapter()
    const mgr = makeManager(adapter, 2)

    await mgr.spawn(baseSpawn)
    await mgr.spawn(baseSpawn)

    await expect(mgr.spawn(baseSpawn)).rejects.toThrow(PoolFullError)
  })

  it('pool count excludes terminal sessions', async () => {
    const adapter = makeAdapter()
    const mgr = makeManager(adapter, 1)

    const s = await mgr.spawn(baseSpawn)
    await mgr.transition(s.id, 'waiting')
    await mgr.transition(s.id, 'killed')

    // Now pool is empty again — should succeed
    await expect(mgr.spawn(baseSpawn)).resolves.toBeTruthy()
  })
})

describe('SessionManager — transition', () => {
  it('valid transition: spawning → waiting', async () => {
    const mgr = makeManager(makeAdapter())
    const s = await mgr.spawn(baseSpawn)
    const updated = await mgr.transition(s.id, 'waiting')
    expect(updated.status).toBe('waiting')
  })

  it('valid chain: spawning → waiting → running → idle → succeeded', async () => {
    // State machine v2 (2026-09-05): `completing`/`completed` were removed
    // in favor of `idle` + terminal `succeeded`. Terminal is entered via
    // archive() or directly from a running/idle transition.
    const mgr = makeManager(makeAdapter())
    const s = await mgr.spawn(baseSpawn)
    await mgr.transition(s.id, 'waiting')
    await mgr.transition(s.id, 'running')
    await mgr.transition(s.id, 'idle')
    const final = await mgr.transition(s.id, 'succeeded')
    expect(final.status).toBe('succeeded')
    expect(final.endedAt).toBeTruthy()
  })

  it('invalid transition throws InvalidTransitionError', async () => {
    const mgr = makeManager(makeAdapter())
    const s = await mgr.spawn(baseSpawn)
    // spawning → succeeded is not allowed; must go through waiting/running/idle
    await expect(mgr.transition(s.id, 'succeeded')).rejects.toThrow(InvalidTransitionError)
  })

  it('terminal → any throws InvalidTransitionError (except respawn → spawning)', async () => {
    // State machine v2: terminal states (succeeded/failed/killed) allow ONE
    // exit — → spawning — for in-place respawn (same session id, fresh
    // Claude conversation). Any other target is rejected.
    const mgr = makeManager(makeAdapter())
    const s = await mgr.spawn(baseSpawn)
    await mgr.transition(s.id, 'failed')
    await expect(mgr.transition(s.id, 'running')).rejects.toThrow(InvalidTransitionError)
  })

  it('running → running is valid (self-loop)', async () => {
    const mgr = makeManager(makeAdapter())
    const s = await mgr.spawn(baseSpawn)
    await mgr.transition(s.id, 'waiting')
    await mgr.transition(s.id, 'running')
    const updated = await mgr.transition(s.id, 'running')
    expect(updated.status).toBe('running')
  })
})

describe('SessionManager — kill', () => {
  it('calls adapter.kill and transitions to killed', async () => {
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    const s = await mgr.spawn(baseSpawn)
    await mgr.transition(s.id, 'waiting')
    const killed = await mgr.kill(s.id)
    expect(killed.status).toBe('killed')
    expect(adapter.kill).toHaveBeenCalled()
  })
})

describe('SessionManager — list', () => {
  it('returns all persisted sessions', async () => {
    const mgr = makeManager(makeAdapter())
    await mgr.spawn(baseSpawn)
    await mgr.spawn(baseSpawn)
    const sessions = await mgr.list()
    expect(sessions).toHaveLength(2)
  })
})
