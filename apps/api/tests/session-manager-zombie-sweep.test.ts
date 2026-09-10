import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager } from '../src/domain/session-manager.js'
import { AdapterRegistry } from '../src/adapters/registry.js'
import type { AgentAdapter, SessionMetadata, SessionStatus } from '@agent-hq-orchestron/shared'

/**
 * The zombie: a record in tmux mode, `running`, with no tmux window behind
 * it. Nothing lands it — the tmux turn watcher keys off a JSONL that is never
 * written, and there is no child process whose exit could reconcile it — so
 * it sits `running` forever, holding a pool slot and refusing every action
 * that wants a terminal state.
 *
 * The metadata mode lock closes the path that created these, but records
 * written before it are already on disk, and an unclean shutdown can strand
 * one the same way. The sweep is the recovery half.
 */

let tmpDir: string
let mgr: SessionManager

function makeAdapter(): AgentAdapter {
  return {
    name: 'mock',
    spawn: vi.fn(),
    resume: vi.fn(),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitTuiReady: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zombie-sweep-test-'))
  const registry = new AdapterRegistry()
  registry.register('claude', makeAdapter())
  mgr = new SessionManager({ dataDir: tmpDir, maxConcurrent: 10 }, registry)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Write a record straight to disk. Reaching these shapes through the real
 *  lifecycle is exactly what the mode lock now prevents, so the fixture has
 *  to state them directly. */
function seed(id: string, over: Partial<SessionMetadata>): string {
  const now = new Date().toISOString()
  const rec = {
    id,
    projectId: 'p1',
    agentType: 'claude',
    status: 'running',
    useTmux: true,
    tmuxName: '',
    claudeSessionUuid: '00000000-0000-0000-0000-000000000001',
    jsonlPath: '/tmp/mock.jsonl',
    initialPrompt: 'hi',
    startedAt: now,
    endedAt: null,
    lastActivityAt: now,
    ...over,
  } as SessionMetadata
  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'sessions', `${id}.json`), JSON.stringify(rec))
  return id
}

async function read(id: string): Promise<SessionMetadata | undefined> {
  return (await mgr.list()).find((s) => s.id === id)
}

const ID = '11111111-1111-1111-1111-111111111111'

describe('SessionManager.sweepZombies', () => {
  it('lands a tmux-mode running session with no window in failed', async () => {
    seed(ID, {})
    await mgr.sweepZombies()
    const after = await read(ID)
    expect(after?.status).toBe('failed')
    expect(after?.failureReason).toBe('cross-mode transition failed — no tmux window found')
    // Terminal, so endedAt is stamped — that is what makes Respawn reachable.
    expect(after?.endedAt).toBeTruthy()
  })

  it('warns so the reclamation is visible in the log, not silent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seed(ID, {})
    await mgr.sweepZombies()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('orphaned zombie session detected'))
    warn.mockRestore()
  })

  it('recovers the exact shape a pre-lock metadata edit produced', async () => {
    // Headless session at rest, flipped to tmux by the pencil, then sent a
    // message: sendInput took the tmux branch, waitTuiReady swallowed its own
    // failure, and the record transitioned to running behind nothing.
    seed(ID, { useTmux: true, tmuxName: '', status: 'running' })
    await mgr.sweepZombies()
    expect((await read(ID))?.status).toBe('failed')
  })

  it('leaves a live tmux session alone', async () => {
    seed(ID, { tmuxName: 'orchestron-live' })
    await mgr.sweepZombies()
    expect((await read(ID))?.status).toBe('running')
  })

  it('leaves a running headless turn alone — it holds no window by design', async () => {
    // The case that would break the product if the signature were just
    // "running with no tmuxName": every headless turn in flight looks like
    // that between handle writes.
    seed(ID, { useTmux: false, tmuxName: '' })
    await mgr.sweepZombies()
    expect((await read(ID))?.status).toBe('running')
  })

  it.each(['idle', 'needs_input', 'sleeping', 'spawning', 'waiting'] as const)(
    'leaves a windowless %s session alone — only running is stranded',
    async (status: SessionStatus) => {
      seed(ID, { status, tmuxName: '' })
      await mgr.sweepZombies()
      expect((await read(ID))?.status).toBe(status)
    },
  )

  it('treats a record with no useTmux field as tmux, like everything else does', async () => {
    // Pre-toggle records have no field at all. resolveUseTmux reads those as
    // tmux, so a stranded one is a zombie too.
    const rec = seed(ID, {})
    const p = path.join(tmpDir, 'sessions', `${rec}.json`)
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    delete parsed.useTmux
    fs.writeFileSync(p, JSON.stringify(parsed))

    await mgr.sweepZombies()
    expect((await read(ID))?.status).toBe('failed')
  })

  it('is idempotent — a second pass finds nothing left to do', async () => {
    seed(ID, {})
    await mgr.sweepZombies()
    const first = await read(ID)
    await mgr.sweepZombies()
    const second = await read(ID)
    expect(second?.status).toBe('failed')
    expect(second?.endedAt).toBe(first?.endedAt)
  })

  it('sweeps several at once and stops at the first healthy one', async () => {
    const a = '22222222-2222-2222-2222-222222222222'
    const b = '33333333-3333-3333-3333-333333333333'
    seed(a, {})
    seed(b, {})
    seed(ID, { tmuxName: 'orchestron-live' })
    await mgr.sweepZombies()
    expect((await read(a))?.status).toBe('failed')
    expect((await read(b))?.status).toBe('failed')
    expect((await read(ID))?.status).toBe('running')
  })

  it('runs at boot, so a restart reclaims rather than waiting out an interval', async () => {
    seed(ID, {})
    await mgr.resumeIdleSweepers()
    expect((await read(ID))?.status).toBe('failed')
  })

  it('runs at boot even with warm shutdowns turned off', async () => {
    // idleTimeoutMs = 0 disables the idle sweeper entirely. Zombie recovery
    // is not what that switch configures, so it must survive it.
    const registry = new AdapterRegistry()
    registry.register('claude', makeAdapter())
    const noIdle = new SessionManager({ dataDir: tmpDir, maxConcurrent: 10, idleTimeoutMs: 0 }, registry)
    seed(ID, {})
    await noIdle.resumeIdleSweepers()
    expect((await noIdle.list()).find((s) => s.id === ID)?.status).toBe('failed')
  })
})
