import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SessionManager } from '../src/domain/session-manager.js'
import { AdapterRegistry } from '../src/adapters/registry.js'
import type { AgentAdapter, TmuxHandle, SessionMetadata } from '@agent-hq-orchestron/shared'

/**
 * Reopen / Fork / Respawn across the tmux<->headless boundary.
 *
 * Phase 1 refused all of these when the SOURCE was headless, on the theory
 * that resuming across modes might not work. It does, in both directions and
 * on both harnesses (measured — see
 * scratchpad/headless-phase2-verification.md), so what these tests pin is
 * that each action honours the mode the caller asked for and leaves the
 * record telling the truth about it afterwards.
 */

let tmpDir: string
let transcript: string

function makeAdapter() {
  let n = 0
  const adapter: AgentAdapter & Record<string, ReturnType<typeof vi.fn>> = {
    name: 'claude',
    spawn: vi.fn(async (cfg: { useTmux?: boolean }) => ({
      tmuxName: cfg.useTmux === false ? `headless-s${++n}` : `tmux-s${++n}`,
      claudeUuid: 'harness-uuid',
      jsonlPath: transcript,
      headless: cfg.useTmux === false,
    } as TmuxHandle)),
    resume: vi.fn(async (uuid: string, cfg: { useTmux?: boolean; prompt?: string }) => ({
      tmuxName: cfg.useTmux === false ? `headless-r${++n}` : `tmux-r${++n}`,
      claudeUuid: uuid,
      jsonlPath: transcript,
      headless: cfg.useTmux === false,
    } as TmuxHandle)),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitTuiReady: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    awaitHeadlessExit: vi.fn().mockResolvedValue({ exitCode: 0, finalResponse: 'ok' }),
  } as never
  return adapter
}

function makeManager(adapter: AgentAdapter) {
  const registry = new AdapterRegistry()
  registry.register('claude', adapter)
  const mgr = new SessionManager({ dataDir: tmpDir, maxConcurrent: 10 }, registry)
  mgr.setProjectResolver(async () => ({ path: '/tmp/ws', defaultModel: 'm', defaultEffort: 'high' }))
  return mgr
}

/** A terminal session in the given mode, with a transcript on disk so the
 *  reopen/fork existence checks pass. */
async function terminalSession(mgr: SessionManager, useTmux: boolean): Promise<SessionMetadata> {
  const s = await mgr.spawn({
    projectId: 'proj-1',
    agentType: 'claude',
    initialPrompt: 'original prompt',
    workspace: '/tmp/ws',
    useTmux,
  })
  await waitFor(mgr, s.id, (r) => r.status !== 'spawning', 'left spawning')
  await mgr.kill(s.id)
  return (await mgr.list()).find((x) => x.id === s.id)!
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

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossmode-'))
  transcript = path.join(tmpDir, 'harness-uuid.jsonl')
  fs.writeFileSync(transcript, '{"type":"user"}\n')
})
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

describe('reopen across modes', () => {
  it('headless -> tmux resumes the same conversation in a tmux window', async () => {
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    const s = await terminalSession(mgr, false)

    await mgr.reopen(s.id, '/tmp/ws', undefined, undefined, undefined, { useTmux: true })
    const [resumedId, cfg] = adapter.resume.mock.calls[0]!
    expect(resumedId).toBe('harness-uuid')
    expect(cfg.useTmux).toBeUndefined()   // tmux is the adapter's default path

    const after = await waitFor(mgr, s.id, (r) => r.status === 'idle', 'idle')
    // The conversion sticks: a later Kill + Reopen must not silently fall
    // back to headless.
    expect(after.useTmux).toBe(true)
    expect(after.claudeSessionUuid).toBe('harness-uuid')
  })

  it('tmux -> headless flips the record without running anything', async () => {
    // A headless session is only alive for the length of a turn, so there is
    // no process to bring up. Spending a `-p --resume` on an empty prompt
    // would burn a turn to accomplish nothing.
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    const s = await terminalSession(mgr, true)

    const after = await mgr.reopen(s.id, '/tmp/ws', undefined, undefined, undefined, { useTmux: false })
    expect(after.status).toBe('idle')
    expect(after.useTmux).toBe(false)
    expect(after.endedAt).toBeNull()
    expect(adapter.resume).not.toHaveBeenCalled()
    expect(adapter.spawn).toHaveBeenCalledTimes(1)   // only the original
  })

  it('reopening into headless leaves the session ready for the next turn', async () => {
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    const s = await terminalSession(mgr, true)
    await mgr.reopen(s.id, '/tmp/ws', undefined, undefined, undefined, { useTmux: false })

    await mgr.sendInput(s.id, 'first headless turn')
    expect(adapter.resume.mock.calls[0]![1].useTmux).toBe(false)
    expect(adapter.resume.mock.calls[0]![1].prompt).toBe('first headless turn')
  })

  it('keeps the session own mode when the caller sends no override', async () => {
    // Absent must mean "keep", not "true" — the tri-state is the whole point
    // of the checkbox defaulting to the session's current mode.
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    const s = await terminalSession(mgr, false)
    const after = await mgr.reopen(s.id, '/tmp/ws')
    expect(after.useTmux).toBe(false)
    expect(adapter.resume).not.toHaveBeenCalled()
  })

  it('clears a stale failureReason on the revived record', async () => {
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    const s = await terminalSession(mgr, false)
    const recPath = path.join(tmpDir, 'sessions', `${s.id}.json`)
    const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'))
    rec.failureReason = 'old boom'
    fs.writeFileSync(recPath, JSON.stringify(rec))

    const after = await mgr.reopen(s.id, '/tmp/ws', undefined, undefined, undefined, { useTmux: false })
    expect(after.failureReason).toBeUndefined()
  })
})

describe('fork across modes', () => {
  it('headless -> tmux forks into a tmux window sharing the conversation', async () => {
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    const s = await terminalSession(mgr, false)

    const fork = await mgr.clone(s.id, { workspace: '/tmp/ws' }, undefined, undefined, undefined, { useTmux: true })
    expect(fork.id).not.toBe(s.id)
    expect(fork.useTmux).toBe(true)
    expect(fork.claudeSessionUuid).toBe('harness-uuid')   // shared conversation
    expect(fork.parentSessionId).toBe(s.id)
    expect(adapter.resume).toHaveBeenCalled()
  })

  it('tmux -> headless forks straight to idle with no child process', async () => {
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    const s = await terminalSession(mgr, true)

    const fork = await mgr.clone(s.id, { workspace: '/tmp/ws' }, undefined, undefined, undefined, { useTmux: false })
    expect(fork.status).toBe('idle')
    expect(fork.useTmux).toBe(false)
    expect(adapter.resume).not.toHaveBeenCalled()
  })

  it('runs the fork prompt as the new session first headless turn', async () => {
    // The prompt field stays Fork-only, and in headless it seeds the first
    // turn rather than being pasted into a TUI.
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    const s = await terminalSession(mgr, true)
    // The source's own spawn pasted its initial prompt; only the fork's
    // behaviour is under test here.
    adapter.sendPrompt.mockClear()

    const fork = await mgr.clone(s.id, { workspace: '/tmp/ws' }, 'diverge here', undefined, undefined, { useTmux: false })
    expect(fork.initialPrompt).toBe('diverge here')
    await waitFor(mgr, fork.id, () => adapter.resume.mock.calls.length > 0, 'seed turn started')
    const [, cfg] = adapter.resume.mock.calls[0]!
    expect(cfg.useTmux).toBe(false)
    expect(cfg.prompt).toBe('diverge here')
    expect(adapter.sendPrompt).not.toHaveBeenCalled()
  })

  it('leaves the source record untouched', async () => {
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    const s = await terminalSession(mgr, false)
    await mgr.clone(s.id, { workspace: '/tmp/ws' }, undefined, undefined, undefined, { useTmux: true })
    const source = (await mgr.list()).find((x) => x.id === s.id)!
    expect(source.useTmux).toBe(false)
    expect(source.status).toBe('killed')
  })
})

describe('respawn across modes', () => {
  it('respawns into the mode the caller asked for and persists it', async () => {
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    const s = await terminalSession(mgr, false)

    const fresh = await mgr.respawn(s.id, '/tmp/ws', undefined, undefined, undefined, { useTmux: true })
    expect(fresh.id).toBe(s.id)          // in-place
    expect(fresh.useTmux).toBe(true)
    expect(adapter.spawn.mock.calls.at(-1)![0].useTmux).toBe(true)
    // Fresh conversation from the original prompt — that is what respawn is.
    expect(adapter.spawn.mock.calls.at(-1)![0].initialPrompt).toBe('original prompt')
  })

  it('respawns headless-as-headless when asked, rather than steering to tmux', async () => {
    // A headless respawn is a real operation now that the session lands in
    // idle and accepts follow-ups. No auto-conversion.
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    const s = await terminalSession(mgr, true)

    const fresh = await mgr.respawn(s.id, '/tmp/ws', undefined, undefined, undefined, { useTmux: false })
    expect(fresh.useTmux).toBe(false)
    expect(adapter.spawn.mock.calls.at(-1)![0].useTmux).toBe(false)
    await waitFor(mgr, s.id, (r) => r.status === 'idle', 'idle after headless respawn')
  })

  it('keeps the session own mode with no override', async () => {
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    const s = await terminalSession(mgr, false)
    const fresh = await mgr.respawn(s.id, '/tmp/ws')
    expect(fresh.useTmux).toBe(false)
    expect(adapter.spawn.mock.calls.at(-1)![0].useTmux).toBe(false)
  })
})
