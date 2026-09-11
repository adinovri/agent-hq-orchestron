import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { schedulesPlugin } from '../../src/routes/schedules.js'
import { ProjectRegistry } from '../../src/domain/project-registry.js'
import { Scheduler, type ScheduleEntry } from '../../src/domain/scheduler.js'

/**
 * NEW-3 — a schedule may not name a project that does not exist.
 *
 * `POST /api/schedules` took any non-empty string as `projectId` and answered
 * **201**. A typo, a stale id copied from another host, or a freshly minted
 * uuid naming nothing all produced a stored schedule that cron would wake for
 * and that could never run. Nothing said so at the point of the mistake: the
 * caller got a success document with the phantom id echoed back in it, and the
 * truth arrived at the first fire, in a log the caller was not reading.
 *
 * Both write verbs are covered. The finding was filed against create, but a
 * PATCH that repoints a working schedule at a missing project breaks it the
 * same way, so the guard has to hold under both or it is only half closed.
 */

let tmpDir: string
let scheduler: Scheduler
let app: ReturnType<typeof Fastify>

const CRON = '0 9 * * 1'
const REAL = '11111111-1111-4111-8111-111111111111'
const PHANTOM = '99999999-9999-4999-8999-999999999999'

function seedProject(dataDir: string, id: string): ProjectRegistry {
  const dir = path.join(dataDir, 'projects')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      name: 'fixture',
      path: dataDir,
      agentType: 'claude',
      group: null,
      tags: [],
      createdAt: new Date().toISOString(),
      config: {},
    }),
  )
  return new ProjectRegistry(dataDir)
}

function storedIds(): string[] {
  const dir = path.join(tmpDir, 'schedules')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''))
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sched-guard-'))
  scheduler = new Scheduler(tmpDir, 'http://api.test', null)
  app = Fastify()
  await app.register(schedulesPlugin(scheduler, seedProject(tmpDir, REAL), { enableHeadlessMode: true }))
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const create = (projectId: string) =>
  app.inject({
    method: 'POST',
    url: '/api/schedules',
    payload: { cron: CRON, projectId, prompt: 'go', enabled: false },
  })

describe('POST /api/schedules — the project has to exist', () => {
  it('refuses a projectId that names nothing, and names it in the message', async () => {
    const res = await create(PHANTOM)
    expect(res.statusCode).toBe(404)
    // The id goes in the message: the whole failure mode is a caller who does
    // not yet know which of the ids they are holding is the dead one.
    expect(res.json().error).toBe(`Project not found: ${PHANTOM}`)
  })

  it('writes nothing when it refuses', async () => {
    // A 404 that still left the record on disk would be the same bug with a
    // different status code.
    await create(PHANTOM)
    expect(storedIds()).toHaveLength(0)
  })

  it('still creates against a project that does exist', async () => {
    // The regression guard. A check that refuses everything passes the two
    // assertions above and breaks every schedule anybody has.
    const res = await create(REAL)
    expect(res.statusCode).toBe(201)
    expect(res.json().projectId).toBe(REAL)
    expect(storedIds()).toHaveLength(1)
  })

  it('checks the project before the overrides, not after', async () => {
    // Order matters for the coercion notice: a phantom project must not come
    // back as a 201-with-`coerced` or log a useTmux decision for a project
    // that is not there to have a default.
    const res = await app.inject({
      method: 'POST',
      url: '/api/schedules',
      payload: { cron: CRON, projectId: PHANTOM, prompt: 'go', useTmux: false },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().coerced).toBeUndefined()
  })
})

describe('PATCH /api/schedules/:id — the same guard under the other verb', () => {
  async function seedSchedule(): Promise<string> {
    const res = await create(REAL)
    return (res.json() as ScheduleEntry).id
  }

  it('refuses to repoint a live schedule at a missing project', async () => {
    const id = await seedSchedule()
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/schedules/${id}`,
      payload: { projectId: PHANTOM },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe(`Project not found: ${PHANTOM}`)
  })

  it('leaves the schedule pointing where it was', async () => {
    const id = await seedSchedule()
    await app.inject({ method: 'PATCH', url: `/api/schedules/${id}`, payload: { projectId: PHANTOM } })
    const after = await app.inject({ method: 'GET', url: `/api/schedules/${id}` })
    expect(after.json().projectId).toBe(REAL)
  })

  it('still allows a PATCH that does not touch projectId', async () => {
    const id = await seedSchedule()
    const res = await app.inject({ method: 'PATCH', url: `/api/schedules/${id}`, payload: { enabled: true } })
    expect(res.statusCode).toBe(200)
    expect(res.json().enabled).toBe(true)
    expect(res.json().projectId).toBe(REAL)
  })
})
