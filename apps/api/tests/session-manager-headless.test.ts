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
  it('goes spawning -> running -> idle without waiting for a TUI', async () => {
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
    const done = await waitForRecord(mgr, s.id, (r) => r.status === 'idle', 'idle')

    // Never went through 'waiting', and neither TUI step was invoked.
    expect(adapter.waitTuiReady).not.toHaveBeenCalled()
    expect(adapter.sendPrompt).not.toHaveBeenCalled()
    expect(done.finalResponse).toBe('done')
    expect(done.costUsd).toBe(0.5)
    expect(done.tokenUsage).toEqual({ input: 1, output: 2 })
    // `idle` is not terminal, so endedAt stays null — the session is alive
    // and waiting for the next turn. Phase 1 landed on `succeeded` here and
    // stamped endedAt; that conflated process exit with user-done.
    expect(done.endedAt).toBeNull()
  })

  it('lands needs_input when the turn returns a structured inquiry', async () => {
    const { adapter, releaseExit } = makeHeadlessAdapter({
      exitCode: 0,
      finalResponse: JSON.stringify({
        summary: 'Blocked on the target environment.',
        inquiry: {
          message: 'Which environment?',
          fields: [{ name: 'env', label: 'Environment', type: 'choice', options: ['dev', 'prod'] }],
        },
      }),
    })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    releaseExit()
    const asked = await waitForRecord(mgr, s.id, (r) => r.status === 'needs_input', 'needs_input')
    expect(asked.pendingInquiry?.message).toBe('Which environment?')
    expect(asked.pendingInquiry?.fields[0]?.options).toEqual(['dev', 'prod'])
    // finalResponse carries the summary, not the raw JSON envelope.
    expect(asked.finalResponse).toBe('Blocked on the target environment.')
  })

  it('lands idle when the structured result carries no inquiry', async () => {
    const { adapter, releaseExit } = makeHeadlessAdapter({
      exitCode: 0,
      finalResponse: JSON.stringify({ summary: 'All done.', inquiry: null }),
    })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    releaseExit()
    const done = await waitForRecord(mgr, s.id, (r) => r.status === 'idle', 'idle')
    expect(done.finalResponse).toBe('All done.')
    expect(done.pendingInquiry).toBeNull()
  })

  it('keeps a plain-text final response intact when the model ignores the schema', async () => {
    // Structured output is a request, not a guarantee. Prose must survive.
    const { adapter, releaseExit } = makeHeadlessAdapter({ exitCode: 0, finalResponse: 'just prose' })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    releaseExit()
    const done = await waitForRecord(mgr, s.id, (r) => r.status === 'idle', 'idle')
    expect(done.finalResponse).toBe('just prose')
    expect(done.pendingInquiry).toBeNull()
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
    const done = await waitForRecord(mgr, s.id, (r) => r.status === 'idle', 'idle')
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

  it('rests in idle without ever being swept to sleeping', async () => {
    // Headless DOES have an idle state now, but nothing to warm-shutdown:
    // between turns there is no tmux and no child. A sweeper firing here
    // would push it to `sleeping`, a state whose only exit is a tmux resume.
    const { adapter, releaseExit } = makeHeadlessAdapter({ exitCode: 0 })
    // idleTimeoutMs of 1ms — a tmux session would be asleep almost at once.
    const registry = new AdapterRegistry()
    registry.register('claude', adapter)
    const mgr = new SessionManager({ dataDir: tmpDir, maxConcurrent: 3, idleTimeoutMs: 1 }, registry)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    releaseExit()
    await waitForRecord(mgr, s.id, (r) => r.status === 'idle', 'idle')
    await new Promise((r) => setTimeout(r, 120))
    const after = (await mgr.list()).find((x) => x.id === s.id)!
    expect(after.status).toBe('idle')
    expect(adapter.kill).not.toHaveBeenCalled()
  })

  it('releases its pool slot as soon as the turn ends, without going terminal', async () => {
    const { adapter, releaseExit } = makeHeadlessAdapter({ exitCode: 0 })
    const mgr = makeManager(adapter, 1)
    const first = await mgr.spawn({ ...baseSpawn, useTmux: false })
    // Cap of 1 — a second spawn is refused while the first is mid-turn.
    await expect(mgr.spawn({ ...baseSpawn, useTmux: false })).rejects.toThrow(/pool is full/i)

    releaseExit()
    await waitForRecord(mgr, first.id, (r) => r.status === 'idle', 'idle')
    // An idle headless session holds no process, so it must not keep
    // occupying the slot the way an idle tmux session does.
    await expect(mgr.spawn({ ...baseSpawn, useTmux: false })).resolves.toBeTruthy()
  })

  it('still counts an idle TMUX session against the pool cap', async () => {
    // The counterpart to the test above — the exemption must be scoped to
    // headless, not applied to every idle session.
    const { adapter } = makeHeadlessAdapter({ exitCode: 0 })
    adapter.spawn.mockResolvedValue({ tmuxName: 't1', claudeUuid: 'u1', jsonlPath: '/tmp/u1.jsonl' })
    const mgr = makeManager(adapter, 1)
    const first = await mgr.spawn(baseSpawn)
    await mgr.transition(first.id, 'waiting')
    await mgr.transition(first.id, 'running')
    await mgr.transition(first.id, 'idle')
    await expect(mgr.spawn(baseSpawn)).rejects.toThrow(/pool is full/i)
  })
})

describe('SessionManager — headless guards', () => {
  async function runToIdle() {
    const { adapter, releaseExit } = makeHeadlessAdapter({ exitCode: 0 })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    releaseExit()
    await waitForRecord(mgr, s.id, (r) => r.status === 'idle', 'idle')
    return { mgr, adapter, id: s.id }
  }

  it('needs a project resolver before it can run a follow-up turn', async () => {
    // A headless follow-up has to look up the workspace to spawn its child
    // in. The resolver is optional on SessionManager so unit tests need not
    // build a ProjectRegistry, which makes this reachable rather than
    // theoretical — it should say so plainly instead of failing deeper in.
    const { mgr, id } = await runToIdle()
    await expect(mgr.sendInput(id, 'more')).rejects.toThrow(/project resolver/i)
  })

  it('refuses reopen and points at Respawn', async () => {
    // Reopen only ever applied to terminal sessions, and a headless session
    // no longer reaches one on its own — kill it to get there.
    const { mgr, id } = await runToIdle()
    await mgr.kill(id)
    await expect(mgr.reopen(id, '/tmp/ws')).rejects.toThrow(/headless|Respawn/i)
  })

  it('refuses fork and points at Respawn', async () => {
    const { mgr, id } = await runToIdle()
    await expect(mgr.clone(id, { workspace: '/tmp/ws' })).rejects.toThrow(/headless|Respawn/i)
  })

  it('interrupts a live turn by signalling the child, landing idle not failed', async () => {
    // The child is SIGTERMed, so it exits by signal — which on its own reads
    // as a failure. The interrupt marker is what says "deliberate".
    const { adapter, releaseExit } = makeHeadlessAdapter({ exitCode: null })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    await waitForRecord(mgr, s.id, (r) => r.status === 'running', 'running')

    await mgr.interrupt(s.id)
    expect(adapter.kill).toHaveBeenCalled()
    expect(adapter.kill.mock.calls[0]![0]!.headless).toBe(true)

    releaseExit()
    const after = await waitForRecord(mgr, s.id, (r) => r.status === 'idle', 'idle')
    expect(after.failureReason).toBeUndefined()
    // Still alive and resumable — the session outlives the interrupted turn.
    expect(after.endedAt).toBeNull()
  })

  it('treats interrupt between turns as a no-op', async () => {
    const { adapter, releaseExit } = makeHeadlessAdapter({ exitCode: 0 })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    releaseExit()
    await waitForRecord(mgr, s.id, (r) => r.status === 'idle', 'idle')
    const same = await mgr.interrupt(s.id)
    expect(same.status).toBe('idle')
    expect(adapter.kill).not.toHaveBeenCalled()
  })

  it('allows editing useTmux between headless turns but not mid-turn', async () => {
    const { adapter, releaseExit } = makeHeadlessAdapter({ exitCode: 0 })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn({ ...baseSpawn, useTmux: false })
    await waitForRecord(mgr, s.id, (r) => r.status === 'running', 'running')
    // Baked into argv at spawn — flipping it mid-flight would desync the
    // record from the live process.
    await expect(mgr.updateMetadata(s.id, { useTmux: true })).rejects.toThrow(/Cannot edit/i)

    releaseExit()
    await waitForRecord(mgr, s.id, (r) => r.status === 'idle', 'idle')
    // Idle headless holds no process, so this is the moment a multi-turn
    // session is editable at all — refusing here would make the pencil
    // unreachable for the whole life of the session.
    const patched = await mgr.updateMetadata(s.id, { useTmux: true })
    expect(patched.useTmux).toBe(true)
  })

  it('still refuses a metadata edit on an idle TMUX session', async () => {
    const { adapter } = makeHeadlessAdapter({ exitCode: 0 })
    adapter.spawn.mockResolvedValue({ tmuxName: 't1', claudeUuid: 'u1', jsonlPath: '/tmp/u1.jsonl' })
    const mgr = makeManager(adapter)
    const s = await mgr.spawn(baseSpawn)
    await mgr.transition(s.id, 'waiting')
    await mgr.transition(s.id, 'running')
    await mgr.transition(s.id, 'idle')
    await expect(mgr.updateMetadata(s.id, { model: 'x' })).rejects.toThrow(/Cannot edit/i)
  })
})
