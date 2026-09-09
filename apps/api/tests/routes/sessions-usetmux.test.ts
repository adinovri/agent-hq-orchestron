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
import type { AgentAdapter, SpawnConfig } from '@agent-hq-orchestron/shared'

let tmpDir: string
let app: ReturnType<typeof Fastify>
let registry: ProjectRegistry
let manager: SessionManager
let spawnSpy: ReturnType<typeof vi.fn>

/** Adapter that stays in tmux shape so completeSpawn's tmux path runs and
 *  the record settles predictably — this suite is about what reaches
 *  SpawnConfig, not about the headless lifecycle. */
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

function spawnedWith(): SpawnConfig {
  return spawnSpy.mock.calls[0]![0] as SpawnConfig
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-usetmux-test-'))
  const adapterRegistry = new AdapterRegistry()
  adapterRegistry.register('claude', makeAdapter())
  manager = new SessionManager({ dataDir: tmpDir, maxConcurrent: 10 }, adapterRegistry)
  registry = new ProjectRegistry(tmpDir)

  app = Fastify({ logger: false })
  await app.register(sessionsPlugin(
    manager,
    new HookRunner({ dataDir: tmpDir }),
    new TemplateResolver(tmpDir),
    new DelegationTracker(tmpDir),
    registry,
  ))
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function makeProject(defaultUseTmux?: boolean) {
  const p = await registry.create({
    name: 'Test', path: os.tmpdir(), agentType: 'claude',
    ...(defaultUseTmux === undefined ? {} : { defaultUseTmux }),
  })
  return p.id
}

describe('POST /api/sessions — useTmux cascade', () => {
  it('defaults to tmux when neither body nor project says anything', async () => {
    const projectId = await makeProject()
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: { projectId, prompt: 'hi' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
  })

  it('inherits the project default when the body is silent', async () => {
    const projectId = await makeProject(false)
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: { projectId, prompt: 'hi' } })
    expect(res.json().useTmux).toBe(false)
    expect(spawnedWith().useTmux).toBe(false)
  })

  it('lets the body override a tmux project default with headless', async () => {
    const projectId = await makeProject(true)
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { projectId, prompt: 'hi', useTmux: false },
    })
    expect(res.json().useTmux).toBe(false)
  })

  it('lets the body override a headless project default with tmux', async () => {
    // The direction that a `||` cascade would break: body false must not be
    // treated as "unset" and fall through to the project.
    const projectId = await makeProject(false)
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { projectId, prompt: 'hi', useTmux: true },
    })
    expect(res.json().useTmux).toBe(true)
  })

  it('rejects a non-boolean useTmux', async () => {
    const projectId = await makeProject()
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { projectId, prompt: 'hi', useTmux: 'false' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('PATCH /api/sessions/:uuid — useTmux', () => {
  async function terminalSession(projectId: string) {
    const created = (await app.inject({
      method: 'POST', url: '/api/sessions', payload: { projectId, prompt: 'hi' },
    })).json()
    // Drive to a terminal state the way the UI would.
    await app.inject({ method: 'DELETE', url: `/api/sessions/${created.id}` })
    return created.id as string
  }

  it('patches useTmux on a terminal session', async () => {
    const projectId = await makeProject()
    const id = await terminalSession(projectId)
    const res = await app.inject({
      method: 'PATCH', url: `/api/sessions/${id}`, payload: { useTmux: false },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().useTmux).toBe(false)
  })

  it('refuses with 409 while the session is still active', async () => {
    // Same gate as model/effort — the mode is baked into argv at spawn.
    const projectId = await makeProject()
    const created = (await app.inject({
      method: 'POST', url: '/api/sessions', payload: { projectId, prompt: 'hi' },
    })).json()
    const res = await app.inject({
      method: 'PATCH', url: `/api/sessions/${created.id}`, payload: { useTmux: false },
    })
    expect(res.statusCode).toBe(409)
  })

  it('leaves useTmux alone when the patch omits it', async () => {
    const projectId = await makeProject(false)
    const id = await terminalSession(projectId)
    const res = await app.inject({
      method: 'PATCH', url: `/api/sessions/${id}`, payload: { model: 'claude-opus-5' },
    })
    expect(res.json().useTmux).toBe(false)
    expect(res.json().model).toBe('claude-opus-5')
  })
})
