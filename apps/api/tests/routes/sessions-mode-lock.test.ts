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
import type { AgentAdapter, SessionMetadata } from '@agent-hq-orchestron/shared'

/**
 * PATCH /api/sessions/:uuid, on the one state Phase 2 opened up: a headless
 * session at rest. Model and effort go through — that gate is what made the
 * pencil reachable on a multi-turn headless session at all. The mode does
 * not, because the next turn there is delivered by sendInput rather than by
 * a spawn, and sendInput reading a freshly-flipped `useTmux: true` drives the
 * tmux path against a spent headless handle.
 *
 * 400 rather than 409 is the contract this pins: the record is editable, the
 * request is not.
 */

let tmpDir: string
let app: ReturnType<typeof Fastify>
let manager: SessionManager
let registry: ProjectRegistry

function makeAdapter(): AgentAdapter {
  return {
    name: 'mock',
    spawn: vi.fn().mockResolvedValue({
      tmuxName: 'mock-session',
      claudeUuid: '00000000-0000-0000-0000-000000000001',
      jsonlPath: '/tmp/mock.jsonl',
    }),
    resume: vi.fn(),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitTuiReady: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-mode-lock-test-'))
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

/** Write a session record straight to disk in the shape we want to test.
 *  Going through spawn() would drag the whole headless lifecycle in; this
 *  suite only cares which patches the route accepts on which status. */
async function seed(status: SessionMetadata['status'], useTmux: boolean): Promise<string> {
  const project = await registry.create({ name: 'Test', path: os.tmpdir(), agentType: 'claude' })
  const id = '11111111-2222-3333-4444-555555555555'
  const now = new Date().toISOString()
  const rec: SessionMetadata = {
    id,
    projectId: project.id,
    agentType: 'claude',
    status,
    useTmux,
    tmuxName: useTmux ? 'live-tmux' : '',
    claudeSessionUuid: '00000000-0000-0000-0000-000000000001',
    jsonlPath: '/tmp/mock.jsonl',
    initialPrompt: 'hi',
    startedAt: now,
    endedAt: null,
    lastActivityAt: now,
  } as SessionMetadata
  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'sessions', `${id}.json`), JSON.stringify(rec))
  return id
}

async function patch(id: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'PATCH', url: `/api/sessions/${id}`, payload })
}

describe('PATCH /api/sessions/:uuid — mode lock at rest', () => {
  it.each(['idle', 'needs_input'] as const)('refuses a useTmux flip at %s with 400', async (status) => {
    const id = await seed(status, false)
    const res = await patch(id, { useTmux: true })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/Reopen\/Fork\/Respawn/)
  })

  it.each(['idle', 'needs_input'] as const)('still takes model and effort at %s', async (status) => {
    const id = await seed(status, false)
    const res = await patch(id, { model: 'claude-opus-5', effort: 'high' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ model: 'claude-opus-5', effort: 'high', useTmux: false })
  })

  it('leaves the record untouched when it refuses', async () => {
    const id = await seed('idle', false)
    // Model rides along in the same patch. The whole thing is refused, so it
    // must not land either — a half-applied patch would be worse than none.
    const res = await patch(id, { model: 'claude-opus-5', useTmux: true })
    expect(res.statusCode).toBe(400)
    const after = (await manager.list()).find((s) => s.id === id)
    expect(after?.useTmux).toBe(false)
    expect(after?.model).toBeUndefined()
  })

  it('still allows a useTmux edit on a terminal session', async () => {
    // The state the change is meant to be made from: a terminal record goes
    // through a real spawn before anything reads useTmux again.
    const id = await seed('killed', true)
    const res = await patch(id, { useTmux: false })
    expect(res.statusCode).toBe(200)
    expect(res.json().useTmux).toBe(false)
  })

  it('still allows a useTmux edit on a sleeping session', async () => {
    const id = await seed('sleeping', true)
    const res = await patch(id, { useTmux: false })
    expect(res.statusCode).toBe(200)
    expect(res.json().useTmux).toBe(false)
  })

  it('keeps refusing everything on an idle TMUX session, with 409', async () => {
    // Unchanged by this work: an idle tmux session has claude bound to its
    // model right now, so no field is editable and the reason is a lifecycle
    // one — hence 409, not 400.
    const id = await seed('idle', true)
    const res = await patch(id, { model: 'claude-opus-5' })
    expect(res.statusCode).toBe(409)
  })
})
