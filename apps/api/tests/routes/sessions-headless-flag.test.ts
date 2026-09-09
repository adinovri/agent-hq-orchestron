import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sessionsPlugin } from '../../src/routes/sessions.js'
import { SessionManager } from '../../src/domain/session-manager.js'
import { AdapterRegistry } from '../../src/adapters/registry.js'
import { ProjectRegistry } from '../../src/domain/project-registry.js'
import { DelegationTracker } from '../../src/domain/delegation-tracker.js'
import { HookRunner } from '../../src/domain/hook-runner.js'
import { TemplateResolver } from '../../src/domain/template-resolver.js'
import { HEADLESS_COERCED_REASON } from '@agent-hq-orchestron/shared'
import type { AgentAdapter, SpawnConfig } from '@agent-hq-orchestron/shared'

/**
 * The global `enableHeadlessMode` switch in its masking shape: with it off
 * nothing 400s, every headless request comes back as tmux, and the response
 * advertises the override in `coerced` so the UI can say so.
 *
 * Each case is asserted against a flag-on and a flag-off server, because
 * "coerced" and "left alone" are both load-bearing — a rule that coerced
 * everything would sail through a coerce-only suite.
 */

let tmpDir: string
let spawnSpy: ReturnType<typeof vi.fn>

/** Stays in tmux shape so completeSpawn settles predictably — this suite
 *  is about what the route does with the request, not the headless
 *  lifecycle. */
function makeAdapter(): AgentAdapter {
  spawnSpy = vi.fn().mockResolvedValue({
    tmuxName: 'mock-session',
    claudeUuid: '00000000-0000-0000-0000-000000000001',
    jsonlPath: '/tmp/mock.jsonl',
  })
  return {
    name: 'mock',
    spawn: spawnSpy,
    resume: vi.fn(),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitTuiReady: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
  }
}

interface Harness {
  app: ReturnType<typeof Fastify>
  registry: ProjectRegistry
  manager: SessionManager
}

async function makeApp(enableHeadlessMode: boolean): Promise<Harness> {
  const adapterRegistry = new AdapterRegistry()
  adapterRegistry.register('claude', makeAdapter())
  // The manager gets the flag too — the route coerces bodies, the manager
  // coerces spawn decisions that never came from one (respawn).
  const manager = new SessionManager(
    { dataDir: tmpDir, maxConcurrent: 10, enableHeadlessMode },
    adapterRegistry,
  )
  const registry = new ProjectRegistry(tmpDir)

  const app = Fastify({ logger: false })
  await app.register(sessionsPlugin(
    manager,
    new HookRunner({ dataDir: tmpDir }),
    new TemplateResolver(tmpDir),
    new DelegationTracker(tmpDir),
    registry,
    { enableHeadlessMode },
  ))
  await app.ready()
  return { app, registry, manager }
}

async function makeProject(registry: ProjectRegistry, defaultUseTmux?: boolean) {
  const p = await registry.create({
    name: 'Test', path: os.tmpdir(), agentType: 'claude',
    ...(defaultUseTmux === undefined ? {} : { defaultUseTmux }),
  })
  return p.id
}

function spawnedWith(nth = 0): SpawnConfig {
  return spawnSpy.mock.calls[nth]![0] as SpawnConfig
}

/**
 * Wait for the async post-spawn work to finish.
 *
 * spawn() returns as soon as the record is written and lets completeSpawn
 * (waitTuiReady → sendPrompt → running) run detached. Killing before that
 * settles leaves an in-flight transition that flips the session back out of
 * `killed`, which then fails the terminal-state gate on whatever the test
 * does next. Polling for a settled status makes the sequence deterministic
 * instead of a race the mock adapter usually wins.
 */
async function settle(h: Harness, id: string): Promise<void> {
  const SETTLED = ['running', 'idle', 'needs_input', 'succeeded', 'failed', 'killed']
  for (let i = 0; i < 100; i++) {
    const rec = (await h.manager.list()).find(x => x.id === id)
    if (rec && SETTLED.includes(rec.status)) return
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error(`session ${id} never settled`)
}

/**
 * Build a terminal session record with a given mode, then hand back an app
 * running under `enableHeadlessMode: flagAfter` over the same dataDir.
 *
 * The record has to be created while the switch is ON — with it off the
 * spawn route would coerce it and there would be no headless record left to
 * test against. So: spawn under the permissive app, settle, kill, close,
 * reopen under the app whose flag the test actually cares about. spawnSpy is
 * rebuilt by makeApp, so call index 0 afterwards belongs to the second app.
 */
async function terminalRecordThen(
  useTmux: boolean,
  flagAfter: boolean,
): Promise<{ h: Harness; id: string; projectId: string }> {
  const setup = await makeApp(true)
  const projectId = await makeProject(setup.registry)
  const created = (await setup.app.inject({
    method: 'POST', url: '/api/sessions',
    payload: { projectId, prompt: 'hi', useTmux },
  })).json()
  expect(created.useTmux).toBe(useTmux)
  await settle(setup, created.id)
  await setup.app.inject({ method: 'DELETE', url: `/api/sessions/${created.id}` })
  await setup.app.close()

  const h = await makeApp(flagAfter)
  return { h, id: created.id as string, projectId }
}

/** The exact shape a client keys off. Spelled out once so a change to it
 *  has to be deliberate. */
const COERCED = { useTmux: true, reason: HEADLESS_COERCED_REASON }

let harness: Harness | null = null

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-headless-flag-test-'))
})

afterEach(async () => {
  if (harness) await harness.app.close()
  harness = null
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('POST /api/sessions — enableHeadlessMode: true', () => {
  it('allows an explicit useTmux:false and says nothing about coercion', async () => {
    harness = await makeApp(true)
    const projectId = await makeProject(harness.registry)
    const res = await harness.app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { projectId, prompt: 'hi', useTmux: false },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(false)
    expect(res.json().coerced).toBeUndefined()
    expect(spawnedWith().useTmux).toBe(false)
  })

  it('still honours a headless project default', async () => {
    harness = await makeApp(true)
    const projectId = await makeProject(harness.registry, false)
    const res = await harness.app.inject({
      method: 'POST', url: '/api/sessions', payload: { projectId, prompt: 'hi' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(false)
    expect(res.json().coerced).toBeUndefined()
  })
})

describe('POST /api/sessions — enableHeadlessMode: false', () => {
  it('coerces an explicit useTmux:false to tmux and spawns it', async () => {
    // The masking contract: 201, not 400, and the session really runs.
    harness = await makeApp(false)
    const projectId = await makeProject(harness.registry)
    const res = await harness.app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { projectId, prompt: 'hi', useTmux: false },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
    expect(res.json().coerced).toEqual(COERCED)
    // Actually launched, and launched as tmux — not merely recorded as one.
    expect(spawnSpy).toHaveBeenCalled()
    expect(spawnedWith().useTmux).toBe(true)
  })

  it('coerces the multipart form flavour of useTmux=false too', async () => {
    // The multipart branch builds its own body object; it must land in the
    // same rule rather than sneaking past it.
    harness = await makeApp(false)
    const projectId = await makeProject(harness.registry)
    const boundary = '----orchestrontest'
    const part = (name: string, value: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    const body = part('projectId', projectId) + part('prompt', 'hi') +
      part('useTmux', 'false') + `--${boundary}--\r\n`
    const res = await harness.app.inject({
      method: 'POST', url: '/api/sessions',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: body,
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
    expect(res.json().coerced).toEqual(COERCED)
  })

  it('coerces a headless project default to tmux', async () => {
    harness = await makeApp(false)
    const projectId = await makeProject(harness.registry, false)
    const res = await harness.app.inject({
      method: 'POST', url: '/api/sessions', payload: { projectId, prompt: 'hi' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
    expect(res.json().coerced).toEqual(COERCED)
    expect(spawnedWith().useTmux).toBe(true)
  })

  it('does NOT claim a coercion when the project default was already tmux', async () => {
    // `coerced` present on an ordinary spawn would pop a toast on every
    // single session anyone starts while the switch is off.
    harness = await makeApp(false)
    const projectId = await makeProject(harness.registry)
    const res = await harness.app.inject({
      method: 'POST', url: '/api/sessions', payload: { projectId, prompt: 'hi' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
    expect(res.json().coerced).toBeUndefined()
  })

  it('leaves an explicit useTmux:true alone', async () => {
    harness = await makeApp(false)
    const projectId = await makeProject(harness.registry, false)
    const res = await harness.app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { projectId, prompt: 'hi', useTmux: true },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
    expect(res.json().coerced).toBeUndefined()
  })

  it('never returns 400 for any useTmux value', async () => {
    // Guarding is gone. Asserted directly so a re-introduced reject cannot
    // pass by coincidence of the other cases.
    harness = await makeApp(false)
    const projectId = await makeProject(harness.registry, false)
    for (const useTmux of [true, false, undefined]) {
      const res = await harness.app.inject({
        method: 'POST', url: '/api/sessions',
        payload: { projectId, prompt: 'hi', ...(useTmux === undefined ? {} : { useTmux }) },
      })
      expect(res.statusCode).toBe(201)
    }
  })
})

describe('PATCH /api/sessions/:uuid — enableHeadlessMode', () => {
  async function terminalSession(h: Harness, projectId: string): Promise<string> {
    const created = (await h.app.inject({
      method: 'POST', url: '/api/sessions', payload: { projectId, prompt: 'hi' },
    })).json()
    await settle(h, created.id)
    await h.app.inject({ method: 'DELETE', url: `/api/sessions/${created.id}` })
    return created.id as string
  }

  it('allows the flip to headless while the flag is on', async () => {
    harness = await makeApp(true)
    const projectId = await makeProject(harness.registry)
    const id = await terminalSession(harness, projectId)
    const res = await harness.app.inject({
      method: 'PATCH', url: `/api/sessions/${id}`, payload: { useTmux: false },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().useTmux).toBe(false)
    expect(res.json().coerced).toBeUndefined()
  })

  it('saves the flip to headless as tmux while the flag is off', async () => {
    harness = await makeApp(false)
    const projectId = await makeProject(harness.registry)
    const id = await terminalSession(harness, projectId)
    const res = await harness.app.inject({
      method: 'PATCH', url: `/api/sessions/${id}`, payload: { useTmux: false },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().useTmux).toBe(true)
    expect(res.json().coerced).toEqual(COERCED)

    // Persisted, not just echoed.
    const after = await harness.app.inject({ method: 'GET', url: `/api/sessions/${id}` })
    expect(after.json().useTmux).toBe(true)
  })

  it('still allows flipping a headless session back to tmux', async () => {
    // The unwind direction has to stay open, otherwise an operator cannot
    // clean up existing records without turning the switch back on first.
    harness = await makeApp(false)
    const projectId = await makeProject(harness.registry, false)
    const id = await terminalSession(harness, projectId)
    const res = await harness.app.inject({
      method: 'PATCH', url: `/api/sessions/${id}`, payload: { useTmux: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().useTmux).toBe(true)
    expect(res.json().coerced).toBeUndefined()
  })

  it('leaves a model-only patch untouched, mode field included', async () => {
    // A model edit during an outage must not rewrite a headless record's
    // mode behind the operator's back — the preference has to survive so it
    // re-applies when the flag goes back on.
    const { h, id } = await terminalRecordThen(false, false)
    harness = h
    const res = await h.app.inject({
      method: 'PATCH', url: `/api/sessions/${id}`, payload: { model: 'claude-opus-5' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().model).toBe('claude-opus-5')
    expect(res.json().useTmux).toBe(false)
    expect(res.json().coerced).toBeUndefined()
  })
})

describe('POST /api/sessions/:uuid/respawn — enableHeadlessMode', () => {
  it('migrates a headless record to tmux and reports the coercion', async () => {
    // Respawn is the lifecycle action that actually converts an existing
    // headless session, so it is the one that has to say it did.
    const { h, id } = await terminalRecordThen(false, false)
    harness = h
    const res = await h.app.inject({
      method: 'POST', url: `/api/sessions/${id}/respawn`, payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().useTmux).toBe(true)
    expect(res.json().coerced).toEqual(COERCED)
    // Launched as tmux — the manager's own coercion at the spawn boundary,
    // not just the route's report of it.
    expect(spawnedWith().useTmux).toBe(true)
  })

  it('says nothing when respawning an ordinary tmux session', async () => {
    const { h, id } = await terminalRecordThen(true, false)
    harness = h
    const res = await h.app.inject({
      method: 'POST', url: `/api/sessions/${id}/respawn`, payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().useTmux).toBe(true)
    expect(res.json().coerced).toBeUndefined()
  })

  it('keeps a headless respawn headless while the flag is on', async () => {
    const { h, id } = await terminalRecordThen(false, true)
    harness = h
    const res = await h.app.inject({
      method: 'POST', url: `/api/sessions/${id}/respawn`, payload: {},
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().useTmux).toBe(false)
    expect(res.json().coerced).toBeUndefined()
    expect(spawnedWith().useTmux).toBe(false)
  })
})

describe('reopen and fork are not coerce sites', () => {
  it('still refuses to reopen a headless session while the flag is off', async () => {
    // Coercing the mode flag would slip past the cross-mode resume gate
    // without making the resume any safer — turning the safety switch off
    // must not unlock a riskier path. The 409 points at Respawn instead.
    const { h, id } = await terminalRecordThen(false, false)
    harness = h
    const res = await h.app.inject({
      method: 'POST', url: `/api/sessions/${id}/reopen`, payload: {},
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/headless/i)
    expect(res.json().error).toMatch(/respawn/i)
  })

  it('still refuses to fork a headless session while the flag is off', async () => {
    const { h, id } = await terminalRecordThen(false, false)
    harness = h
    const res = await h.app.inject({
      method: 'POST', url: `/api/sessions/${id}/clone`, payload: {},
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/headless/i)
  })
})

describe('sessionsPlugin default', () => {
  it('treats an omitted config as headless-enabled', async () => {
    // Every pre-existing call site passes five arguments.
    const adapterRegistry = new AdapterRegistry()
    adapterRegistry.register('claude', makeAdapter())
    const manager = new SessionManager({ dataDir: tmpDir, maxConcurrent: 10 }, adapterRegistry)
    const registry = new ProjectRegistry(tmpDir)
    const app = Fastify({ logger: false })
    await app.register(sessionsPlugin(
      manager,
      new HookRunner({ dataDir: tmpDir }),
      new TemplateResolver(tmpDir),
      new DelegationTracker(tmpDir),
      registry,
    ))
    await app.ready()
    harness = { app, registry, manager }

    const projectId = await makeProject(registry)
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { projectId, prompt: 'hi', useTmux: false },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(false)
    expect(res.json().coerced).toBeUndefined()
  })
})
