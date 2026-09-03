/**
 * E2E: Parent + 2 children + 1 grandchild — DELETE root kills all descendants.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { SessionManager } from '../../apps/api/src/domain/session-manager.js'
import { ProjectRegistry } from '../../apps/api/src/domain/project-registry.js'
import { DelegationTracker } from '../../apps/api/src/domain/delegation-tracker.js'
import { HookRunner } from '../../apps/api/src/domain/hook-runner.js'
import { TemplateResolver } from '../../apps/api/src/domain/template-resolver.js'
import { sessionsPlugin } from '../../apps/api/src/routes/sessions.js'
import { projectsPlugin } from '../../apps/api/src/routes/projects.js'
import { delegationPlugin } from '../../apps/api/src/routes/delegation.js'
import type { AgentAdapter, TmuxHandle } from '@agent-hq-orchestron/shared'

let tmpDir: string
let app: FastifyInstance

function makeMockAdapter(): AgentAdapter {
  return {
    name: 'mock',
    spawn: vi.fn().mockResolvedValue({
      tmuxName: 'mock-tmux',
      claudeUuid: '00000000-0000-0000-0000-000000000099',
      jsonlPath: '/tmp/mock.jsonl',
    } satisfies TmuxHandle),
    resume: vi.fn().mockResolvedValue({
      tmuxName: 'mock-tmux-r',
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
  const sessionManager = new SessionManager({ dataDir: dir, maxConcurrent: 10 }, adapter)
  const projectRegistry = new ProjectRegistry(dir)
  const delegationTracker = new DelegationTracker(dir)
  const hookRunner = new HookRunner({ dataDir: dir })
  const templateResolver = new TemplateResolver(dir)

  await fastify.register(projectsPlugin(projectRegistry))
  await fastify.register(sessionsPlugin(sessionManager, hookRunner, templateResolver, delegationTracker, projectRegistry))
  await fastify.register(delegationPlugin(delegationTracker, sessionManager))
  await fastify.ready()

  return fastify
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-delegation-'))
  app = await buildApp(tmpDir)
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('delegation-cascade', () => {
  it('DELETE root kills all descendants', async () => {
    // Register project
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'cascade-test', path: tmpDir, agentType: 'claude' },
    })
    const project = projRes.json<{ id: string }>()

    // Spawn parent
    const parentRes = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { projectId: project.id, agentType: 'claude', prompt: 'parent task' },
    })
    const parent = parentRes.json<{ id: string }>()
    expect(parentRes.statusCode).toBe(201)

    // Spawn child-1 with parentSessionId
    const child1Res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        projectId: project.id,
        agentType: 'claude',
        prompt: 'child 1 task',
        parentSessionId: parent.id,
      },
    })
    const child1 = child1Res.json<{ id: string }>()
    expect(child1Res.statusCode).toBe(201)

    // Spawn child-2 with parentSessionId
    const child2Res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        projectId: project.id,
        agentType: 'claude',
        prompt: 'child 2 task',
        parentSessionId: parent.id,
      },
    })
    const child2 = child2Res.json<{ id: string }>()
    expect(child2Res.statusCode).toBe(201)

    // Spawn grandchild under child-1
    const grandchildRes = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {
        projectId: project.id,
        agentType: 'claude',
        prompt: 'grandchild task',
        parentSessionId: child1.id,
      },
    })
    const grandchild = grandchildRes.json<{ id: string }>()
    expect(grandchildRes.statusCode).toBe(201)

    // DELETE root
    const killRes = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${parent.id}`,
    })
    expect(killRes.statusCode).toBe(200)
    expect(killRes.json<{ status: string }>().status).toBe('killed')

    // Verify all descendants are killed
    const listRes = await app.inject({ method: 'GET', url: '/api/sessions' })
    const { sessions } = listRes.json<{ sessions: Array<{ id: string; status: string }> }>()

    const allIds = [parent.id, child1.id, child2.id, grandchild.id]
    for (const id of allIds) {
      const s = sessions.find((x) => x.id === id)
      expect(s, `Session ${id} should exist`).toBeDefined()
      expect(s?.status, `Session ${id} should be killed`).toBe('killed')
    }
  })
})
