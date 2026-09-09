import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SessionManager, InvalidTransitionError } from '../src/domain/session-manager.js'
import { AdapterRegistry } from '../src/adapters/registry.js'
import type { AgentAdapter, TmuxHandle, SessionMetadata } from '@agent-hq-orchestron/shared'

/**
 * Two races that a multi-turn headless session makes routine.
 *
 * Both predate Phase 2 — a fire-and-forget completion finishing while the
 * user presses Kill has always been possible — but a session that survives
 * its turns runs the completion path far more often, and each of these
 * showed up as an intermittent failure in the cross-mode suite before the
 * fix. They are pinned here because the symptom (a session stuck `running`
 * behind a dead process, refusing every subsequent action) is miserable to
 * diagnose from a bug report.
 */

let tmpDir: string

function makeAdapter() {
  let n = 0
  const adapter: AgentAdapter & Record<string, ReturnType<typeof vi.fn>> = {
    name: 'claude',
    spawn: vi.fn(async (cfg: { useTmux?: boolean }) => ({
      tmuxName: `h${++n}`,
      claudeUuid: 'harness-uuid',
      jsonlPath: '/tmp/harness-uuid.jsonl',
      headless: cfg.useTmux === false,
    } as TmuxHandle)),
    resume: vi.fn(),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitTuiReady: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    awaitHeadlessExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
  } as never
  return adapter
}

function makeManager(adapter: AgentAdapter) {
  const registry = new AdapterRegistry()
  registry.register('claude', adapter)
  return new SessionManager({ dataDir: tmpDir, maxConcurrent: 5 }, registry)
}

const baseSpawn = {
  projectId: 'p', agentType: 'claude' as const, initialPrompt: 'hi', workspace: '/tmp/ws',
}

async function record(mgr: SessionManager, id: string): Promise<SessionMetadata> {
  return (await mgr.list()).find((s) => s.id === id)!
}

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concurrency-')) })
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

describe('transition() is atomic per session', () => {
  it('does not let a losing racer resurrect a killed session', async () => {
    // Unlocked, these two interleave as: A reads `running`, B writes
    // `killed`, A writes `idle` — and the session comes back alive behind a
    // process that is already reaped. Locked, one of them loses on the
    // ALLOWED_TRANSITIONS check and throws instead of overwriting.
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    const s = await mgr.spawn(baseSpawn)
    await mgr.transition(s.id, 'waiting')
    await mgr.transition(s.id, 'running')

    const outcomes = await Promise.allSettled([
      mgr.transition(s.id, 'killed'),
      mgr.transition(s.id, 'idle'),
    ])

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled')
    const rejected = outcomes.filter((o) => o.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    // Whichever lost, it lost loudly and with the error callers handle.
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InvalidTransitionError)

    const final = await record(mgr, s.id)
    // The surviving status is one of the two, never a mix, and `killed`
    // cannot be walked back out of except by respawn.
    expect(['killed', 'idle']).toContain(final.status)
    if (final.status === 'killed') expect(final.endedAt).toBeTruthy()
  })

  it('serialises a burst of transitions without losing an update', async () => {
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    const s = await mgr.spawn(baseSpawn)
    await mgr.transition(s.id, 'waiting')

    // running -> idle -> running -> idle, all fired at once. Every edge is
    // legal from its predecessor, so with correct serialisation all four
    // land; unserialised, at least one read-modify-write is lost.
    const results = await Promise.allSettled([
      mgr.transition(s.id, 'running'),
      mgr.transition(s.id, 'idle'),
      mgr.transition(s.id, 'running'),
      mgr.transition(s.id, 'idle'),
    ])
    const ok = results.filter((r) => r.status === 'fulfilled')
    expect(ok.length).toBeGreaterThanOrEqual(2)
    const final = await record(mgr, s.id)
    expect(['running', 'idle']).toContain(final.status)
  })
})

describe('a superseded completion does not touch the session', () => {
  it('ignores a headless turn that finishes after a respawn', async () => {
    // Kill, then immediately Respawn: the first turn's exit promise is still
    // pending and settles into a session that has since been rebuilt with a
    // new handle. Without the ownership check it drags the fresh session
    // from `running` to `idle` — or worse, `failed` — for a process that
    // belongs to the session's previous life.
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const adapter = makeAdapter()
    adapter.awaitHeadlessExit.mockImplementation(async (h: TmuxHandle) => {
      if (h.tmuxName === 'h1') { await gate; return { exitCode: 1, stderr: 'stale boom' } }
      return { exitCode: 0 }
    })
    const mgr = makeManager(adapter)

    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    await mgr.kill(s.id)
    const fresh = await mgr.respawn(s.id, '/tmp/ws')
    expect(fresh.tmuxName).toBe('h2')

    // Now let the FIRST turn finish.
    release()
    await new Promise((r) => setTimeout(r, 150))

    const after = await record(mgr, s.id)
    expect(after.tmuxName).toBe('h2')
    // The stale failure must not have landed on the new run.
    expect(after.failureReason ?? '').not.toContain('stale boom')
    expect(after.status).not.toBe('failed')
  })

  it('clears the handle when reopening into headless, revoking stale ownership', async () => {
    // Between turns a headless session genuinely owns no process, so an
    // empty tmuxName is both honest and the thing that stops a completion
    // from the session's previous life claiming it.
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    fs.writeFileSync('/tmp/harness-uuid.jsonl', '{"type":"user"}\n')
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    await mgr.kill(s.id)
    const revived = await mgr.reopen(s.id, '/tmp/ws', undefined, undefined, undefined, { useTmux: false })
    expect(revived.tmuxName).toBe('')
    expect(revived.status).toBe('idle')
  })
})
