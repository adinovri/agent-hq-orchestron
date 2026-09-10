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
import type { AgentAdapter, TmuxHandle } from '@agent-hq-orchestron/shared'

/**
 * `useTmux` on POST /api/sessions/adopt.
 *
 * Adopt is not a revival: it creates the record, so an absent field falls
 * to the project's `defaultUseTmux` the way spawn does, rather than to a
 * previous mode the way reopen/fork/respawn do. What earns a suite of its own is the
 * headless branch launching NOTHING — the assertions below pin that the
 * adapter is never asked to resume, because "adopted headless" quietly
 * spawning a tmux would look identical from the record alone.
 */

let tmpDir: string
let configDir: string
let workspace: string
let harnessUuid: string

/** Where the claude adapter expects the transcript for our fixture. */
function transcriptPath(uuid: string): string {
  return path.join(configDir, 'projects', workspace.replace(/\//g, '-'), `${uuid}.jsonl`)
}

interface Harness {
  app: ReturnType<typeof Fastify>
  projectId: string
  adapter: AgentAdapter
}

function makeAdapter(): AgentAdapter {
  let n = 0
  return {
    name: 'claude',
    spawn: vi.fn(async (cfg) => ({
      tmuxName: `s${++n}`, claudeUuid: 'spawned', jsonlPath: transcriptPath('spawned'),
      headless: cfg.useTmux === false,
    } as TmuxHandle)),
    resume: vi.fn(async (uuid, cfg) => ({
      tmuxName: `r${++n}`, claudeUuid: uuid, jsonlPath: transcriptPath(uuid),
      headless: cfg.useTmux === false,
    } as TmuxHandle)),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitTuiReady: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    awaitHeadlessExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
  }
}

async function makeApp(
  enableHeadlessMode = true,
  projectDefaultUseTmux?: boolean,
): Promise<Harness> {
  const adapter = makeAdapter()
  const adapterRegistry = new AdapterRegistry()
  adapterRegistry.register('claude', adapter)
  const manager = new SessionManager(
    { dataDir: tmpDir, maxConcurrent: 10, enableHeadlessMode }, adapterRegistry,
  )
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

  const project = await registry.create({
    name: 'Adopt', path: workspace, agentType: 'claude',
    agentConfig: { env: { CLAUDE_CONFIG_DIR: configDir } },
    // Left undefined by default — a project that expresses no preference,
    // which is what every test written before the default was sourced from
    // the project assumes.
    ...(projectDefaultUseTmux === undefined ? {} : { defaultUseTmux: projectDefaultUseTmux }),
  })
  return { app, projectId: project.id, adapter }
}

let harness: Harness | null = null

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-mode-'))
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-cfg-'))
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-ws-'))
  // A random uuid per test so the /proc live-process scan cannot match a
  // real command line on the host running the suite.
  harnessUuid = crypto.randomUUID()
  const p = transcriptPath(harnessUuid)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({
    type: 'user', sessionId: harnessUuid,
    message: { role: 'user', content: 'adopted prompt' },
  }) + '\n')
})

afterEach(async () => {
  if (harness) await harness.app.close()
  harness = null
  for (const d of [tmpDir, configDir, workspace]) fs.rmSync(d, { recursive: true, force: true })
})

async function adopt(payload: Record<string, unknown>) {
  return harness!.app.inject({
    method: 'POST', url: '/api/sessions/adopt',
    payload: { projectId: harness!.projectId, harnessSessionId: harnessUuid, ...payload },
  })
}

describe('POST /api/sessions/adopt — useTmux', () => {
  it('adopts into tmux when the field is absent, as every adopt did before it', async () => {
    harness = await makeApp()
    const res = await adopt({})
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
    expect(harness.adapter.resume).toHaveBeenCalledTimes(1)
  })

  it('adopts into tmux on an explicit true', async () => {
    harness = await makeApp()
    const res = await adopt({ useTmux: true })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
  })

  it('adopts into headless without launching anything', async () => {
    harness = await makeApp()
    const res = await adopt({ useTmux: false })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.useTmux).toBe(false)
    // The whole point of the branch: a headless session holds no process
    // between turns, so adopting one starts none.
    expect(harness.adapter.resume).not.toHaveBeenCalled()
    expect(body.tmuxName).toBe('')
    // Ready for the first `-p --resume`, which is the next send.
    expect(body.status).toBe('idle')
  })

  it('points a headless record at the existing transcript', async () => {
    harness = await makeApp()
    const res = await adopt({ useTmux: false })
    expect(res.json().jsonlPath).toBe(transcriptPath(harnessUuid))
    expect(res.json().claudeSessionUuid).toBe(harnessUuid)
  })

  it('still reads the first prompt off the transcript in headless', async () => {
    harness = await makeApp()
    const res = await adopt({ useTmux: false })
    expect(res.json().initialPrompt).toBe('adopted prompt')
  })

  it('rejects a non-boolean useTmux', async () => {
    harness = await makeApp()
    const res = await adopt({ useTmux: 'headless' })
    expect(res.statusCode).toBe(400)
  })

  it('keeps validating the transcript in headless mode', async () => {
    harness = await makeApp()
    const res = await harness.app.inject({
      method: 'POST', url: '/api/sessions/adopt',
      payload: { projectId: harness.projectId, harnessSessionId: crypto.randomUUID(), useTmux: false },
    })
    // The record is created from a conversation that must exist — skipping
    // the launch does not mean skipping the check.
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/sessions/adopt — the project default fills the absent field', () => {
  it('adopts headless when the project runs headless', async () => {
    harness = await makeApp(true, false)
    const res = await adopt({})
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(false)
    // Really headless, not just labelled: nothing was launched.
    expect(harness.adapter.resume).not.toHaveBeenCalled()
  })

  it('adopts into tmux when the project says tmux', async () => {
    harness = await makeApp(true, true)
    const res = await adopt({})
    expect(res.json().useTmux).toBe(true)
    expect(harness.adapter.resume).toHaveBeenCalledTimes(1)
  })

  it('lets an explicit tmux beat a headless project', async () => {
    harness = await makeApp(true, false)
    const res = await adopt({ useTmux: true })
    expect(res.json().useTmux).toBe(true)
    expect(harness.adapter.resume).toHaveBeenCalledTimes(1)
  })

  it('lets an explicit headless beat a tmux project', async () => {
    harness = await makeApp(true, true)
    const res = await adopt({ useTmux: false })
    expect(res.json().useTmux).toBe(false)
    expect(harness.adapter.resume).not.toHaveBeenCalled()
  })
})

describe('POST /api/sessions/adopt — the kill switch', () => {
  it('coerces a headless project default too, and says so', async () => {
    // The switch masks what the project configured exactly as it masks a
    // typed request — otherwise flipping it off would leave every adopt in
    // a headless project running headless.
    harness = await makeApp(false, false)
    const res = await adopt({})
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
    expect(res.json().coerced).toEqual({ useTmux: true, reason: HEADLESS_COERCED_REASON })
    expect(harness.adapter.resume).toHaveBeenCalledTimes(1)
  })


  it('coerces a headless adopt to tmux and says so', async () => {
    harness = await makeApp(false)
    const res = await adopt({ useTmux: false })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
    expect(res.json().coerced).toEqual({ useTmux: true, reason: HEADLESS_COERCED_REASON })
    // Coerced means it really is a tmux adopt, not a headless one relabelled.
    expect(harness.adapter.resume).toHaveBeenCalledTimes(1)
  })

  it('does not call an ordinary adopt a coercion', async () => {
    harness = await makeApp(false)
    const res = await adopt({})
    expect(res.statusCode).toBe(201)
    expect(res.json().coerced).toBeUndefined()
  })

  it('leaves an explicit tmux adopt unremarked', async () => {
    harness = await makeApp(false)
    const res = await adopt({ useTmux: true })
    expect(res.json().coerced).toBeUndefined()
  })
})
