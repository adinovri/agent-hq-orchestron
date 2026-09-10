import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SessionManager } from '../src/domain/session-manager.js'
import { AdapterRegistry } from '../src/adapters/registry.js'
import type { AgentAdapter, SessionMetadata, TmuxHandle, HeadlessResult } from '@agent-hq-orchestron/shared'

/**
 * E2E smoke finding F5: the idle sweeper slept sessions that were sitting in
 * `needs_input`, holding a `pendingInquiry`. The page then showed a "Sleeping"
 * pill above a live "Agent needs input" form, and the dashboard's needs-input
 * stat read 0 while two sessions were in fact waiting on an answer.
 *
 * A session blocked on a person is not ageing out, so all three sweep
 * entrances — the per-session timer, the boot reconcile, and the safety-net
 * interval — have to leave it alone, while still sweeping plain `idle`.
 */

let tmpDir: string

/** Idle timeout short enough that anything sweepable is asleep at once. Every
 *  "stays put" assertion below therefore has a live sweeper behind it. */
const TIMEOUT_MS = 1

/** Long enough for a 1ms timer, its warm-shutdown, and the record write. */
const SETTLE_MS = 200

function makeAdapter(result: HeadlessResult = { exitCode: 0 }) {
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => { release = r })
  const adapter: AgentAdapter & Record<string, ReturnType<typeof vi.fn>> = {
    name: 'claude',
    spawn: vi.fn(async (): Promise<TmuxHandle> => ({
      tmuxName: 'headless-abc12345',
      claudeUuid: 'claude-uuid-1',
      jsonlPath: '/tmp/claude-uuid-1.jsonl',
      headless: true,
    })),
    resume: vi.fn(),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitTuiReady: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    awaitHeadlessExit: vi.fn(async () => { await gate; return result }),
  } as never
  return { adapter, finish: () => release() }
}

function makeManager(adapter: AgentAdapter, idleTimeoutMs = TIMEOUT_MS) {
  const registry = new AdapterRegistry()
  registry.register('claude', adapter)
  return new SessionManager({ dataDir: tmpDir, maxConcurrent: 5, idleTimeoutMs }, registry)
}

const baseSpawn = {
  projectId: 'proj-1',
  agentType: 'claude' as const,
  initialPrompt: 'hello',
  workspace: '/tmp/ws',
}

/** A headless turn that ends by asking a question — the real route into
 *  `needs_input` with a `pendingInquiry` attached. */
const INQUIRY_RESULT: HeadlessResult = {
  exitCode: 0,
  finalResponse: JSON.stringify({
    summary: 'need input',
    inquiry: { message: 'which env?', fields: [{ name: 'env', label: 'Env', type: 'text', options: null }] },
  }),
}

async function waitFor(
  mgr: SessionManager,
  id: string,
  pred: (s: SessionMetadata) => boolean,
  label: string,
): Promise<SessionMetadata> {
  const deadline = Date.now() + 3_000
  let last: SessionMetadata | undefined
  while (Date.now() < deadline) {
    last = (await mgr.list()).find((s) => s.id === id)
    if (last && pred(last)) return last
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`timed out waiting for ${label}; last status=${last?.status}`)
}

/** Poll a predicate. The record write and the sweeper arming that follows it
 *  are separated by an await, so a test that reads the status can land in
 *  between the two. */
async function waitUntil(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function read(mgr: SessionManager, id: string): Promise<SessionMetadata | undefined> {
  return (await mgr.list()).find((s) => s.id === id)
}

/** Write a record straight to disk, so the boot and safety-net sweeps can be
 *  handed a session that has already been idle-ish far past the threshold. */
function seed(id: string, over: Partial<SessionMetadata>): string {
  const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const rec = {
    id,
    projectId: 'p1',
    agentType: 'claude',
    status: 'needs_input',
    useTmux: false,
    tmuxName: 'headless-spent',
    claudeSessionUuid: '00000000-0000-0000-0000-000000000001',
    jsonlPath: '/tmp/mock.jsonl',
    initialPrompt: 'hi',
    startedAt: stale,
    endedAt: null,
    idleSince: stale,
    lastActivityAt: stale,
    ...over,
  } as SessionMetadata
  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'sessions', `${id}.json`), JSON.stringify(rec))
  return id
}

const ASKING = '11111111-1111-1111-1111-111111111111'
const IDLING = '22222222-2222-2222-2222-222222222222'

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'needs-input-sweep-')) })
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

describe('idle sweeper — needs_input is exempt', () => {
  it('leaves a headless session that asked a question in needs_input', async () => {
    const { adapter, finish } = makeAdapter(INQUIRY_RESULT)
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    finish()
    const asked = await waitFor(mgr, s.id, (r) => r.status === 'needs_input', 'needs_input')
    expect(asked.pendingInquiry?.message).toBe('which env?')

    await new Promise((r) => setTimeout(r, SETTLE_MS))
    const after = (await read(mgr, s.id))!
    expect(after.status).toBe('needs_input')
    // The amber state is the whole finding: the question must still be on the
    // record, not stranded behind a "Sleeping" pill.
    expect(after.pendingInquiry?.message).toBe('which env?')
  })

  it('still sweeps the same session once the question is answered', async () => {
    // The control for the test above — proves the sweeper was armed and alive,
    // and that the exemption is scoped to the one state.
    const { adapter, finish } = makeAdapter(INQUIRY_RESULT)
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    finish()
    await waitFor(mgr, s.id, (r) => r.status === 'needs_input', 'needs_input')
    await new Promise((r) => setTimeout(r, SETTLE_MS))

    await mgr.transition(s.id, 'idle')
    const slept = await waitFor(mgr, s.id, (r) => r.status === 'sleeping', 'swept once idle')
    expect(slept.status).toBe('sleeping')
  })

  it('keeps a tmux session waiting on input, window and all', async () => {
    // For tmux the sleep releases the window — which is where the answer would
    // have been typed. Holding it is the deliberate cost of the exemption.
    const { adapter } = makeAdapter()
    adapter.spawn.mockResolvedValue({ tmuxName: 't1', claudeUuid: 'u1', jsonlPath: '/tmp/u1.jsonl' })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn(baseSpawn)
    await mgr.transition(s.id, 'waiting')
    await mgr.transition(s.id, 'running')
    await mgr.transition(s.id, 'needs_input')

    await new Promise((r) => setTimeout(r, SETTLE_MS))
    expect((await read(mgr, s.id))!.status).toBe('needs_input')
    expect(adapter.kill).not.toHaveBeenCalled()
  })

  it('disarms the timer the preceding idle state armed', async () => {
    // idle → needs_input cancels the sweep idle armed, rather than leaving a
    // timer to fire and be turned away by warmShutdown. A long timeout so the
    // assertion is about the map, not about winning a race with it.
    const { adapter, finish } = makeAdapter()
    const mgr = makeManager(adapter, 5_000)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    finish()
    await waitFor(mgr, s.id, (r) => r.status === 'idle', 'idle')
    const timers = (mgr as unknown as { idleSweepers: Map<string, unknown> }).idleSweepers
    await waitUntil(() => timers.has(s.id), 'idle to arm its sweeper')

    await mgr.transition(s.id, 'needs_input')
    expect(timers.has(s.id)).toBe(false)
    expect((await read(mgr, s.id))!.status).toBe('needs_input')
  })

  it('is a no-op when warmShutdown is called on it directly', async () => {
    const { adapter } = makeAdapter()
    const mgr = makeManager(adapter)
    seed(ASKING, {})
    await mgr.warmShutdown(ASKING)
    expect((await read(mgr, ASKING))!.status).toBe('needs_input')
    expect(adapter.kill).not.toHaveBeenCalled()
  })

  it('skips it at boot while sweeping a stale idle session in the same pass', async () => {
    const { adapter } = makeAdapter()
    const mgr = makeManager(adapter)
    seed(ASKING, {})
    seed(IDLING, { status: 'idle' })
    await mgr.resumeIdleSweepers()
    await waitFor(mgr, IDLING, (r) => r.status === 'sleeping', 'stale idle swept at boot')
    expect((await read(mgr, ASKING))!.status).toBe('needs_input')
  })

  it('skips it in the safety-net sweep too', async () => {
    const { adapter } = makeAdapter()
    const mgr = makeManager(adapter)
    seed(ASKING, {})
    seed(IDLING, { status: 'idle' })
    await (mgr as unknown as { sweepOrphans(): Promise<void> }).sweepOrphans()
    await waitFor(mgr, IDLING, (r) => r.status === 'sleeping', 'stale idle swept by safety net')
    expect((await read(mgr, ASKING))!.status).toBe('needs_input')
  })
})
