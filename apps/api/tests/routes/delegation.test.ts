import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { delegationPlugin } from '../../src/routes/delegation.js'
import { DelegationTracker } from '../../src/domain/delegation-tracker.js'
import { SessionManager } from '../../src/domain/session-manager.js'
import type { AgentAdapter, TmuxHandle } from '@agent-hq-orchestron/shared'

let tmpDir: string
let app: ReturnType<typeof Fastify>
let tracker: DelegationTracker
let manager: SessionManager

function makeAdapter(): AgentAdapter {
  let callCount = 0
  return {
    name: 'mock',
    spawn: vi.fn().mockImplementation(async () => ({
      tmuxName: `mock-${callCount++}`,
      claudeUuid: `00000000-0000-0000-0000-${String(callCount).padStart(12, '0')}`,
      jsonlPath: '/tmp/mock.jsonl',
    } satisfies TmuxHandle)),
    resume: vi.fn().mockResolvedValue({ tmuxName: 'r', claudeUuid: '00000000-0000-0000-0000-000000000099', jsonlPath: '/tmp/r.jsonl' }),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitTuiReady: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-delegation-test-'))
  tracker = new DelegationTracker(tmpDir)
  manager = new SessionManager({ dataDir: tmpDir, maxConcurrent: 10 }, makeAdapter())

  app = Fastify({ logger: false })
  await app.register(delegationPlugin(tracker, manager))
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function spawnSession(parentId?: string) {
  return manager.spawn({
    projectId: '00000000-0000-0000-0000-000000000001',
    agentType: 'claude',
    initialPrompt: 'test',
    workspace: os.tmpdir(),
    parentSessionId: parentId,
  })
}

describe('GET /api/delegation/:rootUuid', () => {
  it('returns 404 for unknown root', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/delegation/00000000-0000-0000-0000-000000000099' })
    expect(res.statusCode).toBe(404)
  })

  it('returns root node with no edges for leaf session', async () => {
    const s = await spawnSession()
    const res = await app.inject({ method: 'GET', url: `/api/delegation/${s.id}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.nodes).toHaveLength(1)
    expect(body.nodes[0].id).toBe(s.id)
    expect(body.edges).toHaveLength(0)
  })

  it('returns nodes and edges for tree', async () => {
    const parent = await spawnSession()
    const child = await spawnSession()
    await tracker.recordEdge(parent.id, child.id, 'spawn child')

    const res = await app.inject({ method: 'GET', url: `/api/delegation/${parent.id}` })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.nodes.map((n: { id: string }) => n.id)).toContain(parent.id)
    expect(body.nodes.map((n: { id: string }) => n.id)).toContain(child.id)
    expect(body.edges).toHaveLength(1)
    expect(body.edges[0].source).toBe(parent.id)
    expect(body.edges[0].target).toBe(child.id)
  })
})
