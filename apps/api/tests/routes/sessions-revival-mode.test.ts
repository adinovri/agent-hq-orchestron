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
import { HEADLESS_DISABLED_ERROR } from '@agent-hq-orchestron/shared'
import type { AgentAdapter, TmuxHandle } from '@agent-hq-orchestron/shared'

/**
 * `useTmux` on the three revival routes — reopen, respawn, clone.
 *
 * The field is a genuine tri-state at this layer: absent means "keep the
 * session's mode", which is not the same as `true`. Each route is asserted
 * for all three values, plus the kill-switch behaviour, because a guard that
 * refuses everything would pass a deny-only suite.
 */

let tmpDir: string
let transcript: string
let workspace: string

function makeAdapter(): AgentAdapter {
  let n = 0
  return {
    name: 'claude',
    spawn: vi.fn(async (cfg) => ({
      tmuxName: `s${++n}`,
      claudeUuid: 'harness-uuid',
      jsonlPath: transcript,
      headless: cfg.useTmux === false,
    } as TmuxHandle)),
    resume: vi.fn(async (uuid, cfg) => ({
      tmuxName: `r${++n}`,
      claudeUuid: uuid,
      jsonlPath: transcript,
      headless: cfg.useTmux === false,
    } as TmuxHandle)),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitTuiReady: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    awaitHeadlessExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
  }
}

interface Harness {
  app: ReturnType<typeof Fastify>
  projectId: string
  /** A terminal session in the given mode, transcript present on disk. */
  seed(useTmux: boolean): Promise<string>
}

async function makeApp(enableHeadlessMode = true): Promise<Harness> {
  const adapterRegistry = new AdapterRegistry()
  adapterRegistry.register('claude', makeAdapter())
  const manager = new SessionManager({ dataDir: tmpDir, maxConcurrent: 10 }, adapterRegistry)
  manager.setProjectResolver(async () => ({ path: workspace }))
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

  const project = await registry.create({ name: 'Test', path: workspace, agentType: 'claude' })

  return {
    app,
    projectId: project.id,
    async seed(useTmux: boolean) {
      const res = await app.inject({
        method: 'POST', url: '/api/sessions',
        payload: { projectId: project.id, prompt: 'seed', useTmux },
      })
      const id = res.json().id as string
      // Settle out of `spawning`, then kill so the session is terminal —
      // reopen and fork are terminal-only operations.
      const deadline = Date.now() + 3_000
      while (Date.now() < deadline) {
        const cur = await app.inject({ method: 'GET', url: `/api/sessions/${id}` })
        if (cur.json().status !== 'spawning') break
        await new Promise((r) => setTimeout(r, 20))
      }
      await app.inject({ method: 'DELETE', url: `/api/sessions/${id}` })
      return id
    },
  }
}

let harness: Harness | null = null

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-revival-mode-'))
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'revival-ws-'))
  transcript = path.join(tmpDir, 'harness-uuid.jsonl')
  fs.writeFileSync(transcript, '{"type":"user"}\n')
})

afterEach(async () => {
  if (harness) await harness.app.close()
  harness = null
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(workspace, { recursive: true, force: true })
})

describe('POST /api/sessions/:uuid/reopen — useTmux', () => {
  it('converts a headless session to tmux when asked', async () => {
    harness = await makeApp()
    const id = await harness.seed(false)
    const res = await harness.app.inject({
      method: 'POST', url: `/api/sessions/${id}/reopen`, payload: { useTmux: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().useTmux).toBe(true)
  })

  it('converts a tmux session to headless when asked', async () => {
    harness = await makeApp()
    const id = await harness.seed(true)
    const res = await harness.app.inject({
      method: 'POST', url: `/api/sessions/${id}/reopen`, payload: { useTmux: false },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().useTmux).toBe(false)
    expect(res.json().status).toBe('idle')
  })

  it('keeps the session mode when the field is absent', async () => {
    harness = await makeApp()
    const id = await harness.seed(false)
    const res = await harness.app.inject({
      method: 'POST', url: `/api/sessions/${id}/reopen`, payload: {},
    })
    expect(res.json().useTmux).toBe(false)
  })

  it('rejects a non-boolean useTmux', async () => {
    harness = await makeApp()
    const id = await harness.seed(true)
    const res = await harness.app.inject({
      method: 'POST', url: `/api/sessions/${id}/reopen`, payload: { useTmux: 'yes' },
    })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/sessions/:uuid/respawn — useTmux', () => {
  it('respawns into tmux when asked', async () => {
    harness = await makeApp()
    const id = await harness.seed(false)
    const res = await harness.app.inject({
      method: 'POST', url: `/api/sessions/${id}/respawn`, payload: { useTmux: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().useTmux).toBe(true)
    expect(res.json().id).toBe(id)   // in-place
  })

  it('respawns headless-as-headless rather than steering to tmux', async () => {
    harness = await makeApp()
    const id = await harness.seed(false)
    const res = await harness.app.inject({
      method: 'POST', url: `/api/sessions/${id}/respawn`, payload: { useTmux: false },
    })
    expect(res.json().useTmux).toBe(false)
  })
})

describe('POST /api/sessions/:uuid/clone — useTmux', () => {
  it('forks into headless when asked, keeping the prompt field', async () => {
    harness = await makeApp()
    const id = await harness.seed(true)
    const res = await harness.app.inject({
      method: 'POST', url: `/api/sessions/${id}/clone`,
      payload: { useTmux: false, prompt: 'diverge' },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(false)
    expect(res.json().initialPrompt).toBe('diverge')
    expect(res.json().id).not.toBe(id)
  })

  it('forks a headless source into tmux when asked', async () => {
    harness = await makeApp()
    const id = await harness.seed(false)
    const res = await harness.app.inject({
      method: 'POST', url: `/api/sessions/${id}/clone`, payload: { useTmux: true },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
  })
})

describe('the kill switch still applies to the revival routes', () => {
  it('refuses an explicit useTmux:false on each of them', async () => {
    harness = await makeApp(false)
    const id = await harness.seed(true)
    for (const route of ['reopen', 'respawn', 'clone']) {
      const res = await harness.app.inject({
        method: 'POST', url: `/api/sessions/${id}/${route}`, payload: { useTmux: false },
      })
      expect(res.statusCode, route).toBe(400)
      expect(res.json().error, route).toBe(HEADLESS_DISABLED_ERROR)
    }
  })

  it('still allows moving a session back TO tmux while the switch is off', async () => {
    // Unwinding must stay possible, or a headless session spawned before the
    // switch was flipped has no way home. Seeding needs a flag-ON server —
    // with the switch off the spawn itself would be refused — so this is the
    // real-world sequence: session created, operator then flips the switch.
    const before = await makeApp(true)
    const id = await before.seed(false)
    await before.app.close()

    // Same dataDir, so the flag-off server sees the same records.
    harness = await makeApp(false)
    const res = await harness.app.inject({
      method: 'POST', url: `/api/sessions/${id}/reopen`, payload: { useTmux: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().useTmux).toBe(true)
  })

  it('leaves a request with no useTmux alone', async () => {
    harness = await makeApp(false)
    const id = await harness.seed(true)
    const res = await harness.app.inject({
      method: 'POST', url: `/api/sessions/${id}/respawn`, payload: {},
    })
    expect(res.statusCode).toBe(200)
  })
})
