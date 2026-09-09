import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SessionManager } from '../src/domain/session-manager.js'
import { AdapterRegistry } from '../src/adapters/registry.js'
import type { AgentAdapter, TmuxHandle, HeadlessResult, SessionMetadata } from '@agent-hq-orchestron/shared'

let tmpDir: string

/** Adapter that returns a headless handle and lets the test control when —
 *  and with what — the run finishes. */
function makeHeadlessAdapter(result: HeadlessResult, opts?: { agentType?: 'claude' | 'codex' }) {
  let releaseExit: () => void = () => {}
  const gate = new Promise<void>((r) => { releaseExit = r })
  const adapter: AgentAdapter & {
    spawn: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
    sendPrompt: ReturnType<typeof vi.fn>
    waitTuiReady: ReturnType<typeof vi.fn>
    awaitHeadlessExit: ReturnType<typeof vi.fn>
  } = {
    name: opts?.agentType ?? 'claude',
    spawn: vi.fn(async (): Promise<TmuxHandle> => ({
      tmuxName: 'headless-abc12345',
      claudeUuid: opts?.agentType === 'codex' ? '' : 'claude-uuid-1',
      jsonlPath: opts?.agentType === 'codex' ? '' : '/tmp/claude-uuid-1.jsonl',
      headless: true,
    })),
    resume: vi.fn(),
    sendPrompt: vi.fn(),
    waitTuiReady: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    awaitHeadlessExit: vi.fn(async () => { await gate; return result }),
  }
  return { adapter, releaseExit: () => releaseExit() }
}

function makeManager(adapter: AgentAdapter, maxConcurrent = 3) {
  const registry = new AdapterRegistry()
  registry.register('claude', adapter)
  registry.register('codex', adapter)
  return new SessionManager({ dataDir: tmpDir, maxConcurrent }, registry)
}

const baseSpawn = {
  projectId: 'proj-1',
  agentType: 'claude' as const,
  initialPrompt: 'hello',
  workspace: '/tmp/ws',
}

/** Poll the record until `pred` holds, so tests don't race the fire-and-forget
 *  completeSpawn. Fails loudly rather than hanging. */
async function waitForRecord(
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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-mgr-headless-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('SessionManager — useTmux resolution', () => {
  it('records useTmux true and spawns tmux when the field is absent', async () => {
    // The defensive default. A payload with no field must never become
    // headless, or every legacy caller silently changes behaviour.
    const { adapter } = makeHeadlessAdapter({ exitCode: 0 })
    adapter.spawn.mockResolvedValue({ tmuxName: 't', claudeUuid: 'u', jsonlPath: '/tmp/u.jsonl' })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn(baseSpawn)
    expect(s.useTmux).toBe(true)
    expect(adapter.spawn.mock.calls[0]![0]!.useTmux).toBe(true)
  })

  it('passes useTmux false straight through to the adapter', async () => {
    const { adapter, releaseExit } = makeHeadlessAdapter({ exitCode: 0 })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    expect(s.useTmux).toBe(false)
    expect(adapter.spawn.mock.calls[0]![0]!.useTmux).toBe(false)
    releaseExit()
  })

  it('persists cwdSlug so the transcript path can be rebuilt later', async () => {
    const { adapter } = makeHeadlessAdapter({ exitCode: 0 })
    adapter.spawn.mockResolvedValue({ tmuxName: 't', claudeUuid: 'u', jsonlPath: '/tmp/u.jsonl' })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, workspace: '/home/me/repo' })
    expect(s.cwdSlug).toBe('-home-me-repo')
  })
})

describe('SessionManager — headless lifecycle', () => {
  it('goes spawning -> running -> succeeded without waiting for a TUI', async () => {
    const { adapter, releaseExit } = makeHeadlessAdapter({
      exitCode: 0,
      finalResponse: 'done',
      costUsd: 0.5,
      tokenUsage: { input: 1, output: 2 },
    })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    expect(s.status).toBe('spawning')

    await waitForRecord(mgr, s.id, (r) => r.status === 'running', 'running')
    releaseExit()
    const done = await waitForRecord(mgr, s.id, (r) => r.status === 'succeeded', 'succeeded')

    // Never went through 'waiting', and neither TUI step was invoked.
    expect(adapter.waitTuiReady).not.toHaveBeenCalled()
    expect(adapter.sendPrompt).not.toHaveBeenCalled()
    expect(done.finalResponse).toBe('done')
    expect(done.costUsd).toBe(0.5)
    expect(done.tokenUsage).toEqual({ input: 1, output: 2 })
    expect(done.endedAt).toBeTruthy()
  })

  it('marks a non-zero exit failed and keeps the stderr as the reason', async () => {
    const { adapter, releaseExit } = makeHeadlessAdapter({ exitCode: 1, stderr: 'Invalid API key' })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    releaseExit()
    const failed = await waitForRecord(mgr, s.id, (r) => r.status === 'failed', 'failed')
    expect(failed.failureReason).toContain('Invalid API key')
  })

  it('treats a signal kill (null exit code) as a failure', async () => {
    const { adapter, releaseExit } = makeHeadlessAdapter({ exitCode: null })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    releaseExit()
    const failed = await waitForRecord(mgr, s.id, (r) => r.status === 'failed', 'failed')
    expect(failed.failureReason).toContain('signal')
  })

  it('adopts the codex thread id reported by the run', async () => {
    // codex exec mints the id itself; without this the record has no
    // resumable id and no way to locate the rollout file.
    const { adapter, releaseExit } = makeHeadlessAdapter(
      { exitCode: 0, sessionId: 'thread-xyz' },
      { agentType: 'codex' },
    )
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, agentType: 'codex', useTmux: false })
    expect(s.claudeSessionUuid).toBe('')
    releaseExit()
    const done = await waitForRecord(mgr, s.id, (r) => r.status === 'succeeded', 'succeeded')
    expect(done.claudeSessionUuid).toBe('thread-xyz')
  })

  it('leaves a killed session killed instead of overwriting it on exit', async () => {
    // Kill lands while the child is still running. The exit handler must not
    // then attempt killed -> failed, which the state machine rejects.
    const { adapter, releaseExit } = makeHeadlessAdapter({ exitCode: null })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    await waitForRecord(mgr, s.id, (r) => r.status === 'running', 'running')

    const killed = await mgr.kill(s.id)
    expect(killed.status).toBe('killed')
    // adapter.kill must receive a headless handle, or a tmux kill is sent at
    // a process that then never gets reaped.
    expect(adapter.kill.mock.calls[0]![0]!.headless).toBe(true)

    releaseExit()
    await new Promise((r) => setTimeout(r, 100))
    const after = (await mgr.list()).find((x) => x.id === s.id)!
    expect(after.status).toBe('killed')
  })

  it('never arms the idle sweeper — headless has no idle state to sleep from', async () => {
    const { adapter, releaseExit } = makeHeadlessAdapter({ exitCode: 0 })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    releaseExit()
    const done = await waitForRecord(mgr, s.id, (r) => r.status === 'succeeded', 'succeeded')
    expect(done.idleSince).toBeFalsy()
  })

  it('releases its pool slot once the run reaches a terminal state', async () => {
    const { adapter, releaseExit } = makeHeadlessAdapter({ exitCode: 0 })
    const mgr = makeManager(adapter, 1)
    const first = await mgr.spawn({ ...baseSpawn, useTmux: false })
    // Cap of 1 — a second spawn is refused while the first still runs.
    await expect(mgr.spawn({ ...baseSpawn, useTmux: false })).rejects.toThrow(/pool is full/i)

    releaseExit()
    await waitForRecord(mgr, first.id, (r) => r.status === 'succeeded', 'succeeded')
    // Slot freed by the terminal transition, no sweeper needed.
    await expect(mgr.spawn({ ...baseSpawn, useTmux: false })).resolves.toBeTruthy()
  })
})

describe('SessionManager — headless guards', () => {
  async function runToTerminal() {
    const { adapter, releaseExit } = makeHeadlessAdapter({ exitCode: 0 })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    releaseExit()
    await waitForRecord(mgr, s.id, (r) => r.status === 'succeeded', 'succeeded')
    return { mgr, id: s.id }
  }

  it('refuses follow-up input and says what to do instead', async () => {
    const { mgr, id } = await runToTerminal()
    await expect(mgr.sendInput(id, 'more')).rejects.toThrow(/one-shot|Respawn/i)
  })

  it('refuses reopen and points at Respawn', async () => {
    const { mgr, id } = await runToTerminal()
    await expect(mgr.reopen(id, '/tmp/ws')).rejects.toThrow(/headless|Respawn/i)
  })

  it('refuses fork and points at Respawn', async () => {
    const { mgr, id } = await runToTerminal()
    await expect(mgr.clone(id, { workspace: '/tmp/ws' })).rejects.toThrow(/headless|Respawn/i)
  })

  it('refuses interrupt while the run is live and points at Kill', async () => {
    const { adapter, releaseExit } = makeHeadlessAdapter({ exitCode: 0 })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    await waitForRecord(mgr, s.id, (r) => r.status === 'running', 'running')
    await expect(mgr.interrupt(s.id)).rejects.toThrow(/headless|Kill/i)
    releaseExit()
  })

  it('allows editing useTmux on a terminal session but not a running one', async () => {
    const { adapter, releaseExit } = makeHeadlessAdapter({ exitCode: 0 })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    await waitForRecord(mgr, s.id, (r) => r.status === 'running', 'running')
    // Baked into argv at spawn — flipping it mid-flight would desync the
    // record from the live process.
    await expect(mgr.updateMetadata(s.id, { useTmux: true })).rejects.toThrow(/Cannot edit/i)

    releaseExit()
    await waitForRecord(mgr, s.id, (r) => r.status === 'succeeded', 'succeeded')
    const patched = await mgr.updateMetadata(s.id, { useTmux: true })
    expect(patched.useTmux).toBe(true)
  })
})
