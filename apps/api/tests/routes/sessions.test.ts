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
import type { AgentAdapter, TmuxHandle } from '@agent-hq-orchestron/shared'

let tmpDir: string
let app: ReturnType<typeof Fastify>
let projectId: string

function makeAdapter(): AgentAdapter {
  return {
    name: 'mock',
    spawn: vi.fn().mockResolvedValue({
      tmuxName: 'mock-session',
      claudeUuid: '00000000-0000-0000-0000-000000000001',
      jsonlPath: '/tmp/mock.jsonl',
    } satisfies TmuxHandle),
    resume: vi.fn().mockResolvedValue({ tmuxName: 'r', claudeUuid: '00000000-0000-0000-0000-000000000002', jsonlPath: '/tmp/r.jsonl' }),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitTuiReady: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-sessions-test-'))
  const adapter = makeAdapter()
  const adapterRegistry = new AdapterRegistry()
  adapterRegistry.register('claude', adapter)
  const manager = new SessionManager({ dataDir: tmpDir, maxConcurrent: 10 }, adapterRegistry)
  const registry = new ProjectRegistry(tmpDir)
  const tracker = new DelegationTracker(tmpDir)
  const hookRunner = new HookRunner({ dataDir: tmpDir })
  const templateResolver = new TemplateResolver(tmpDir)

  // Pre-create a project
  const project = await registry.create({ name: 'Test', path: os.tmpdir(), agentType: 'claude' })
  projectId = project.id

  app = Fastify({ logger: false })
  await app.register(sessionsPlugin(manager, hookRunner, templateResolver, tracker, registry))
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('POST /api/sessions', () => {
  it('creates session and returns 201', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { projectId, prompt: 'hello world' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.id).toBeDefined()
    expect(body.status).toBe('spawning')
  })

  it('returns 400 on missing projectId', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { prompt: 'hi' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 404 for unknown projectId', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { projectId: '00000000-0000-0000-0000-000000000099', prompt: 'hi' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('returns 422 when no prompt or template provided', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { projectId },
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('GET /api/sessions', () => {
  it('returns empty list initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions' })
    expect(res.statusCode).toBe(200)
    expect(res.json().sessions).toHaveLength(0)
  })

  it('returns sessions after creation', async () => {
    await app.inject({ method: 'POST', url: '/api/sessions', payload: { projectId, prompt: 'test' } })
    const res = await app.inject({ method: 'GET', url: '/api/sessions' })
    expect(res.json().sessions).toHaveLength(1)
  })

  it('filters by status', async () => {
    await app.inject({ method: 'POST', url: '/api/sessions', payload: { projectId, prompt: 'test' } })
    const res = await app.inject({ method: 'GET', url: '/api/sessions?status=running' })
    expect(res.json().sessions).toHaveLength(0)
  })
})

describe('GET /api/sessions/:uuid', () => {
  it('returns the session', async () => {
    const create = await app.inject({ method: 'POST', url: '/api/sessions', payload: { projectId, prompt: 'test' } })
    const { id } = create.json()
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe(id)
  })

  it('returns 404 for unknown uuid', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sessions/00000000-0000-0000-0000-000000000099` })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /api/sessions/:uuid', () => {
  it('kills session', async () => {
    const create = await app.inject({ method: 'POST', url: '/api/sessions', payload: { projectId, prompt: 'test' } })
    const { id } = create.json()
    const res = await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('killed')
  })

  it('returns 404 for unknown uuid', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/sessions/00000000-0000-0000-0000-000000000099` })
    expect(res.statusCode).toBe(404)
  })
})
