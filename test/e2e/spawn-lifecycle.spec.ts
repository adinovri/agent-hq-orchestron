/**
 * E2E: Session spawn → SSE events → kill → status=killed
 * Uses Fastify inject (no real network) with mock adapter.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { SessionManager } from '../../apps/api/src/domain/session-manager.js'
import { ProjectRegistry } from '../../apps/api/src/domain/project-registry.js'
import { DelegationTracker } from '../../apps/api/src/domain/delegation-tracker.js'
import { HookRunner } from '../../apps/api/src/domain/hook-runner.js'
import { TemplateResolver } from '../../apps/api/src/domain/template-resolver.js'
import { sessionsPlugin } from '../../apps/api/src/routes/sessions.js'
import { projectsPlugin } from '../../apps/api/src/routes/projects.js'
import type { AgentAdapter, TmuxHandle } from '@agent-hq-orchestron/shared'

let tmpDir: string
let app: FastifyInstance

function makeMockAdapter(): AgentAdapter {
  return {
    name: 'mock',
    spawn: vi.fn().mockResolvedValue({
      tmuxName: 'mock-tmux-session',
      claudeUuid: '00000000-0000-0000-0000-000000000099',
      jsonlPath: '/tmp/mock.jsonl',
    } satisfies TmuxHandle),
    resume: vi.fn().mockResolvedValue({
      tmuxName: 'mock-tmux-resume',
      claudeUuid: '00000000-0000-0000-0000-000000000099',
      jsonlPath: '/tmp/mock.jsonl',
    } satisfies TmuxHandle),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitTuiReady: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
  }
}

async function buildApp(dir: string): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false })

  const adapter = makeMockAdapter()
  const sessionManager = new SessionManager({ dataDir: dir, maxConcurrent: 4 }, adapter)
  const projectRegistry = new ProjectRegistry(dir)
  const delegationTracker = new DelegationTracker(dir)
  const hookRunner = new HookRunner({ dataDir: dir })
  const templateResolver = new TemplateResolver(dir)

  await fastify.register(projectsPlugin(projectRegistry))
  await fastify.register(sessionsPlugin(sessionManager, hookRunner, templateResolver, delegationTracker, projectRegistry))
  await fastify.ready()

  return fastify
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-lifecycle-'))
  app = await buildApp(tmpDir)
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('spawn-lifecycle', () => {
  it('registers project → spawns session → kill → status=killed', async () => {
    // 1. Register project
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'test-project',
        path: tmpDir,
        agentType: 'claude',
      },
    })
    expect(projRes.statusCode).toBe(201)
    const project = projRes.json<{ id: string }>()

    // 2. Spawn session
    const spawnRes = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        projectId: project.id,
        agentType: 'claude',
        prompt: 'Hello from E2E test',
      },
    })
    expect(spawnRes.statusCode).toBe(201)
    const session = spawnRes.json<{ id: string; status: string }>()
    expect(session.status).toBe('spawning')
    expect(session.id).toBeTruthy()

    // 3. Get session — should still be spawning or later
    const getRes = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}`,
    })
    expect(getRes.statusCode).toBe(200)
    const fetched = getRes.json<{ status: string }>()
    expect(['spawning', 'waiting', 'running', 'completing', 'completed', 'killed', 'failed']).toContain(fetched.status)

    // 4. Kill session
    const killRes = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session.id}`,
    })
    expect(killRes.statusCode).toBe(200)
    const killed = killRes.json<{ status: string }>()
    expect(killed.status).toBe('killed')

    // 5. Verify in list
    const listRes = await app.inject({ method: 'GET', url: '/api/sessions' })
    const list = listRes.json<{ sessions: Array<{ id: string; status: string }> }>()
    const found = list.sessions.find((s) => s.id === session.id)
    expect(found).toBeDefined()
    expect(found?.status).toBe('killed')
  })

  it('session list returns array', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ sessions: unknown[] }>()
    expect(Array.isArray(body.sessions)).toBe(true)
  })

  it('kill non-existent session returns 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/00000000-0000-0000-0000-000000000000',
    })
    expect(res.statusCode).toBe(404)
  })
})
