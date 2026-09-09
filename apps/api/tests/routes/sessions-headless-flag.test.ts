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
import {
  HEADLESS_DISABLED_ERROR,
  HEADLESS_DISABLED_HINT,
} from '@agent-hq-orchestron/shared'
import type { AgentAdapter, SpawnConfig } from '@agent-hq-orchestron/shared'

/**
 * The global `enableHeadlessMode` switch, at the only two places it is
 * enforced: POST /api/sessions and PATCH /api/sessions/:uuid. Each case is
 * asserted against a flag-on and a flag-off server, because "allowed" and
 * "denied" are both load-bearing — a guard that rejects everything would
 * pass a deny-only suite.
 */

let tmpDir: string
let spawnSpy: ReturnType<typeof vi.fn>

/** Stays in tmux shape so completeSpawn settles predictably — this suite
 *  is about what the route accepts, not the headless lifecycle. */
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
}

async function makeApp(enableHeadlessMode: boolean): Promise<Harness> {
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
    { enableHeadlessMode },
  ))
  await app.ready()
  return { app, registry }
}

async function makeProject(registry: ProjectRegistry, defaultUseTmux?: boolean) {
  const p = await registry.create({
    name: 'Test', path: os.tmpdir(), agentType: 'claude',
    ...(defaultUseTmux === undefined ? {} : { defaultUseTmux }),
  })
  return p.id
}

function spawnedWith(): SpawnConfig {
  return spawnSpy.mock.calls[0]![0] as SpawnConfig
}

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
  it('allows an explicit useTmux:false', async () => {
    harness = await makeApp(true)
    const projectId = await makeProject(harness.registry)
    const res = await harness.app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { projectId, prompt: 'hi', useTmux: false },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(false)
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
  })
})

describe('POST /api/sessions — enableHeadlessMode: false', () => {
  it('rejects an explicit useTmux:false with 400 + error and hint', async () => {
    harness = await makeApp(false)
    const projectId = await makeProject(harness.registry)
    const res = await harness.app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { projectId, prompt: 'hi', useTmux: false },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: HEADLESS_DISABLED_ERROR,
      hint: HEADLESS_DISABLED_HINT,
    })
    // Nothing was launched — the guard runs before the adapter.
    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it('rejects the multipart form flavour of useTmux=false too', async () => {
    // The multipart branch builds its own body object; it must land in the
    // same guard rather than sneaking past it.
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
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe(HEADLESS_DISABLED_ERROR)
  })

  it('coerces a headless project default to tmux instead of failing', async () => {
    // A 400 here would brick every spawn in that project the moment the
    // operator flips the switch — the opposite of a kill switch's job.
    harness = await makeApp(false)
    const projectId = await makeProject(harness.registry, false)
    const res = await harness.app.inject({
      method: 'POST', url: '/api/sessions', payload: { projectId, prompt: 'hi' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
    expect(spawnedWith().useTmux).toBe(true)
  })

  it('leaves an ordinary tmux spawn completely alone', async () => {
    harness = await makeApp(false)
    const projectId = await makeProject(harness.registry)
    const res = await harness.app.inject({
      method: 'POST', url: '/api/sessions', payload: { projectId, prompt: 'hi' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
  })

  it('allows an explicit useTmux:true', async () => {
    harness = await makeApp(false)
    const projectId = await makeProject(harness.registry, false)
    const res = await harness.app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { projectId, prompt: 'hi', useTmux: true },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
  })
})

describe('PATCH /api/sessions/:uuid — enableHeadlessMode', () => {
  async function terminalSession(h: Harness, projectId: string): Promise<string> {
    const created = (await h.app.inject({
      method: 'POST', url: '/api/sessions', payload: { projectId, prompt: 'hi' },
    })).json()
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
  })

  it('rejects the flip to headless with 400 while the flag is off', async () => {
    harness = await makeApp(false)
    const projectId = await makeProject(harness.registry)
    const id = await terminalSession(harness, projectId)
    const res = await harness.app.inject({
      method: 'PATCH', url: `/api/sessions/${id}`, payload: { useTmux: false },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({
      error: HEADLESS_DISABLED_ERROR,
      hint: HEADLESS_DISABLED_HINT,
    })
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
  })

  it('leaves a model-only patch untouched while the flag is off', async () => {
    harness = await makeApp(false)
    const projectId = await makeProject(harness.registry)
    const id = await terminalSession(harness, projectId)
    const res = await harness.app.inject({
      method: 'PATCH', url: `/api/sessions/${id}`, payload: { model: 'claude-opus-5' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().model).toBe('claude-opus-5')
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
    harness = { app, registry }

    const projectId = await makeProject(registry)
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { projectId, prompt: 'hi', useTmux: false },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(false)
  })
})
