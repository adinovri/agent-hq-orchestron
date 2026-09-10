import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SessionManager } from '../src/domain/session-manager.js'
import { AdapterRegistry } from '../src/adapters/registry.js'
import type { AgentAdapter, TmuxHandle, HeadlessResult, SessionMetadata } from '@agent-hq-orchestron/shared'

let tmpDir: string

/** Adapter whose every headless run is gated, so a test can hold a turn open
 *  and inspect the session mid-flight. One gate per run, resolved in order. */
function makeTurnAdapter(agentType: 'claude' | 'codex' = 'claude') {
  // Gates are created up front rather than inside awaitHeadlessExit, so a
  // test can finish a turn before the manager has got around to awaiting it
  // — otherwise every fast test races the fire-and-forget completion.
  const MAX_TURNS = 6
  const release: Array<() => void> = []
  const gate: Array<Promise<void>> = []
  for (let i = 0; i < MAX_TURNS; i++) {
    gate.push(new Promise<void>((r) => { release.push(r) }))
  }
  const results: HeadlessResult[] = []
  let n = 0

  const nextHandle = (): TmuxHandle => ({
    tmuxName: `headless-turn-${++n}`,
    claudeUuid: agentType === 'codex' ? '' : 'harness-uuid',
    jsonlPath: agentType === 'codex' ? '' : '/tmp/harness-uuid.jsonl',
    headless: true,
  })

  const adapter: AgentAdapter & Record<string, ReturnType<typeof vi.fn>> = {
    name: agentType,
    spawn: vi.fn(async () => nextHandle()),
    resume: vi.fn(async (uuid: string, cfg: { useTmux?: boolean; prompt?: string }) => {
      if (cfg.useTmux === false && !cfg.prompt) throw new Error('needs a prompt')
      return { ...nextHandle(), claudeUuid: uuid }
    }),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitTuiReady: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    awaitHeadlessExit: vi.fn(async (h: TmuxHandle) => {
      const idx = Number(h.tmuxName.split('-').pop()) - 1
      await gate[idx]
      return results[idx] ?? { exitCode: 0 }
    }),
  } as never

  return {
    adapter,
    /** Finish turn `i` (1-based) with `result`. Safe to call before the
     *  manager awaits it. */
    finish(i: number, result: HeadlessResult = { exitCode: 0 }) {
      results[i - 1] = result
      release[i - 1]!()
    },
  }
}

function makeManager(adapter: AgentAdapter, opts: { idleTimeoutMs?: number } = {}) {
  const registry = new AdapterRegistry()
  registry.register('claude', adapter)
  registry.register('codex', adapter)
  const mgr = new SessionManager(
    { dataDir: tmpDir, maxConcurrent: 5, idleTimeoutMs: opts.idleTimeoutMs ?? 0 },
    registry,
  )
  mgr.setProjectResolver(async () => ({ path: '/tmp/ws', defaultModel: 'm', defaultEffort: 'high' }))
  return mgr
}

const baseSpawn = {
  projectId: 'proj-1',
  agentType: 'claude' as const,
  initialPrompt: 'turn one',
  workspace: '/tmp/ws',
  useTmux: false,
}

async function waitFor(mgr: SessionManager, id: string, pred: (s: SessionMetadata) => boolean, label: string) {
  const deadline = Date.now() + 3_000
  let last: SessionMetadata | undefined
  while (Date.now() < deadline) {
    last = (await mgr.list()).find((s) => s.id === id)
    if (last && pred(last)) return last
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`timed out waiting for ${label}; last status=${last?.status}`)
}

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-multiturn-')) })
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

describe('headless multi-turn', () => {
  it('runs a follow-up turn as a fresh --resume child and returns to idle', async () => {
    const { adapter, finish } = makeTurnAdapter()
    const mgr = makeManager(adapter)
    const s = await mgr.spawn(baseSpawn)
    await waitFor(mgr, s.id, (r) => r.status === 'running', 'turn 1 running')
    finish(1, { exitCode: 0, finalResponse: 'first' })
    await waitFor(mgr, s.id, (r) => r.status === 'idle', 'idle after turn 1')

    const after = await mgr.sendInput(s.id, 'turn two')
    expect(after.status).toBe('running')

    // The follow-up went through resume, not spawn, and asked for headless.
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    expect(adapter.resume).toHaveBeenCalledTimes(1)
    const [resumedId, cfg] = adapter.resume.mock.calls[0]!
    expect(resumedId).toBe('harness-uuid')
    expect(cfg.useTmux).toBe(false)
    expect(cfg.prompt).toBe('turn two')
    // A headless follow-up must never be pasted into a TUI.
    expect(adapter.sendPrompt).not.toHaveBeenCalled()

    finish(2, { exitCode: 0, finalResponse: 'second' })
    const done = await waitFor(mgr, s.id, (r) => r.status === 'idle', 'idle after turn 2')
    expect(done.finalResponse).toBe('second')
    // Same conversation throughout — the id and transcript never move.
    expect(done.claudeSessionUuid).toBe('harness-uuid')
    expect(done.endedAt).toBeNull()
  })

  it('resumes with the session own configDir, not the project default', async () => {
    // The harness locates a conversation by scanning exactly one config dir.
    // Resuming with a different one means "No conversation found" on an id
    // that is perfectly valid — the single sharpest edge in this whole path.
    const { adapter, finish } = makeTurnAdapter()
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, configDir: '/custom/config' })
    finish(1)
    await waitFor(mgr, s.id, (r) => r.status === 'idle', 'idle')
    await mgr.sendInput(s.id, 'again')
    expect(adapter.resume.mock.calls[0]![1].configDir).toBe('/custom/config')
    finish(2)
  })

  it('points a follow-up at the new child, so a kill reaps the live turn', async () => {
    const { adapter, finish } = makeTurnAdapter()
    const mgr = makeManager(adapter)
    const s = await mgr.spawn(baseSpawn)
    finish(1)
    const idle = await waitFor(mgr, s.id, (r) => r.status === 'idle', 'idle')
    const firstHandleName = idle.tmuxName

    await mgr.sendInput(s.id, 'turn two')
    const running = (await mgr.list()).find((x) => x.id === s.id)!
    expect(running.tmuxName).not.toBe(firstHandleName)

    await mgr.kill(s.id)
    expect(adapter.kill.mock.calls.at(-1)![0].tmuxName).toBe(running.tmuxName)
    finish(2)
  })

  it('refuses a second turn while one is still running', async () => {
    // No input queue exists: a tmux TUI buffers a paste, a headless child has
    // no stdin at all. Two concurrent --resume children would both append to
    // the same JSONL.
    const { adapter, finish } = makeTurnAdapter()
    const mgr = makeManager(adapter)
    const s = await mgr.spawn(baseSpawn)
    await waitFor(mgr, s.id, (r) => r.status === 'running', 'running')
    await expect(mgr.sendInput(s.id, 'impatient')).rejects.toThrow(/still running|no input queue|interrupt/i)
    finish(1)
  })

  it('answers an inquiry by starting the next turn and clearing it', async () => {
    const { adapter, finish } = makeTurnAdapter()
    const mgr = makeManager(adapter)
    const s = await mgr.spawn(baseSpawn)
    finish(1, {
      exitCode: 0,
      finalResponse: JSON.stringify({
        summary: 'need input',
        inquiry: { message: 'which env?', fields: [{ name: 'env', label: 'Env', type: 'text', options: null }] },
      }),
    })
    const asked = await waitFor(mgr, s.id, (r) => r.status === 'needs_input', 'needs_input')
    expect(asked.pendingInquiry?.message).toBe('which env?')

    await mgr.sendInput(s.id, 'env: prod')
    const running = (await mgr.list()).find((x) => x.id === s.id)!
    expect(running.status).toBe('running')
    expect(running.pendingInquiry).toBeNull()
    finish(2)
  })

  it('clears a stale failureReason once a later turn succeeds', async () => {
    // A reason can sit on a non-terminal record — the boot-orphan scan puts
    // one on an `idle` session whose turn was never observed to completion.
    // A subsequent healthy turn has to wipe it, or the session shows a
    // permanent red reason it has long since recovered from.
    const { adapter, finish } = makeTurnAdapter()
    const mgr = makeManager(adapter)
    const s = await mgr.spawn(baseSpawn)
    finish(1)
    await waitFor(mgr, s.id, (r) => r.status === 'idle', 'idle')

    const recPath = path.join(tmpDir, 'sessions', `${s.id}.json`)
    const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'))
    rec.failureReason = 'orchestron API restarted while a headless turn was in flight'
    fs.writeFileSync(recPath, JSON.stringify(rec))

    await mgr.sendInput(s.id, 'carry on')
    finish(2)
    const done = await waitFor(mgr, s.id, (r) => r.status === 'idle', 'idle after turn 2')
    expect(done.failureReason).toBeUndefined()
  })

  it('refuses a follow-up when the harness never reported a session id', async () => {
    // codex mints its thread id at runtime; a first run that dies before
    // announcing one leaves nothing to --resume.
    const { adapter, finish } = makeTurnAdapter('codex')
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, agentType: 'codex' })
    finish(1, { exitCode: 0 })
    await waitFor(mgr, s.id, (r) => r.status === 'idle', 'idle')
    await expect(mgr.sendInput(s.id, 'again')).rejects.toThrow(/no harness session id|Respawn/i)
  })

  it('adopts the codex thread id on turn one and reuses it on turn two', async () => {
    const { adapter, finish } = makeTurnAdapter('codex')
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, agentType: 'codex' })
    finish(1, { exitCode: 0, sessionId: 'thread-abc' })
    await waitFor(
      mgr, s.id,
      (r) => r.claudeSessionUuid === 'thread-abc' && r.status === 'idle',
      'thread id captured and turn landed',
    )
    await mgr.sendInput(s.id, 'turn two')
    expect(adapter.resume.mock.calls[0]![0]).toBe('thread-abc')
    finish(2)
  })

  it('wakes a sleeping session into the next turn with no cold start', async () => {
    // Headless sleep is symbolic — nothing was released — so waking is a
    // record write and then the ordinary --resume turn. No second spawn, and
    // above all no waitTuiReady: there is no TUI, and the tmux wake branch
    // would be aimed at a spent synthetic handle.
    const { adapter, finish } = makeTurnAdapter()
    const mgr = makeManager(adapter)
    const s = await mgr.spawn(baseSpawn)
    finish(1, { exitCode: 0 })
    await waitFor(mgr, s.id, (r) => r.status === 'idle', 'idle after turn 1')
    await mgr.transition(s.id, 'sleeping')

    const after = await mgr.sendInput(s.id, 'turn two')
    expect(after.status).toBe('running')
    expect(adapter.spawn).toHaveBeenCalledTimes(1)
    expect(adapter.resume).toHaveBeenCalledTimes(1)
    const [, cfg] = adapter.resume.mock.calls[0]!
    expect(cfg.useTmux).toBe(false)
    expect(cfg.prompt).toBe('turn two')
    expect(adapter.waitTuiReady).not.toHaveBeenCalled()

    finish(2, { exitCode: 0 })
    await waitFor(mgr, s.id, (r) => r.status === 'idle', 'idle after turn 2')
  })

  it('sweeps to sleeping and back through a full second turn', async () => {
    // End to end on the real sweeper rather than a hand-written transition:
    // turn lands idle, the 1ms timer sleeps it, a send wakes it, turn two runs.
    const { adapter, finish } = makeTurnAdapter()
    const mgr = makeManager(adapter, { idleTimeoutMs: 1 })
    const s = await mgr.spawn(baseSpawn)
    finish(1, { exitCode: 0 })
    await waitFor(mgr, s.id, (r) => r.status === 'sleeping', 'swept to sleeping')
    expect(adapter.kill).not.toHaveBeenCalled()

    await mgr.sendInput(s.id, 'turn two')
    finish(2, { exitCode: 0 })
    await waitFor(mgr, s.id, (r) => r.status === 'idle', 'idle after turn 2')
    // ...and straight back to sleep, since the sweeper re-arms on every idle.
    await waitFor(mgr, s.id, (r) => r.status === 'sleeping', 'asleep again')
  })

  it('leaves a session asleep when the wake cannot be honoured', async () => {
    // The guards run before the symbolic wake, so a refused send must not
    // leave the record half-woken in `idle` with a fresh sweeper armed.
    const { adapter, finish } = makeTurnAdapter('codex')
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, agentType: 'codex' })
    finish(1, { exitCode: 0 })   // no sessionId — nothing to resume
    await waitFor(mgr, s.id, (r) => r.status === 'idle', 'idle')
    await mgr.transition(s.id, 'sleeping')

    await expect(mgr.sendInput(s.id, 'again')).rejects.toThrow(/no harness session id|Respawn/i)
    const still = (await mgr.list()).find((r) => r.id === s.id)
    expect(still?.status).toBe('sleeping')
  })

  it('still cold-starts a tmux session on wake', async () => {
    // The tmux wake is unchanged: its sleep really did release the window, so
    // waking spawns, waits for the TUI, and pastes.
    const { adapter } = makeTurnAdapter()
    adapter.spawn.mockResolvedValue({ tmuxName: 't1', claudeUuid: 'u1', jsonlPath: '/tmp/u1.jsonl' })
    adapter.resume.mockResolvedValue({ tmuxName: 't2', claudeUuid: 'u1', jsonlPath: '/tmp/u1.jsonl' })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: true })
    await waitFor(mgr, s.id, (r) => r.status === 'running', 'running')
    await mgr.transition(s.id, 'idle')
    await mgr.transition(s.id, 'sleeping')

    await mgr.sendInput(s.id, 'hello again')
    const [, cfg] = adapter.resume.mock.calls[0]!
    expect(cfg.useTmux).toBeUndefined()   // tmux resume, not a headless one
    expect(adapter.waitTuiReady).toHaveBeenCalled()
    expect(adapter.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ tmuxName: 't2' }), 'hello again',
    )
  })

  it('leaves the tmux send path untouched', async () => {
    // Regression guard: the headless branch must not swallow tmux sends.
    const { adapter } = makeTurnAdapter()
    adapter.spawn.mockResolvedValue({ tmuxName: 't1', claudeUuid: 'u1', jsonlPath: '/tmp/u1.jsonl' })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: true })
    await waitFor(mgr, s.id, (r) => r.status === 'running', 'running')
    await mgr.transition(s.id, 'idle')
    await mgr.sendInput(s.id, 'hello tmux')
    expect(adapter.sendPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ tmuxName: 't1' }), 'hello tmux',
    )
    expect(adapter.resume).not.toHaveBeenCalled()
  })
})
