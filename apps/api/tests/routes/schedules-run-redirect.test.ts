import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { schedulesPlugin } from '../../src/routes/schedules.js'
import { Scheduler, spawnedSessionUuid, type ScheduleEntry } from '../../src/domain/scheduler.js'

/**
 * "Run now" exists so the user can watch a schedule fire. That only works if
 * the response says *which* session it fired — hence these cases pin the
 * shape the web client navigates off, plus the fallbacks that keep it on the
 * list instead of pushing /session/undefined.
 */

let tmpDir: string
let scheduler: Scheduler
let app: ReturnType<typeof Fastify>
let fetchSpy: ReturnType<typeof vi.fn>

const CRON = '0 9 * * 1'
const PROJECT = '11111111-1111-4111-8111-111111111111'
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

/** A POST /api/sessions reply. Only `text()` is stubbed, matching what the
 *  scheduler actually calls — it never touches `resp.json()`. */
function spawnReply(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 201,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }
}

async function boot() {
  scheduler = new Scheduler(tmpDir, 'http://api.test', null)
  app = Fastify({ logger: false })
  await app.register(schedulesPlugin(scheduler, { enableHeadlessMode: true }))
  await app.ready()
}

/** Write a schedule straight to disk so no test depends on the create route. */
async function seed(id: string): Promise<ScheduleEntry> {
  const entry: ScheduleEntry = {
    id,
    cron: CRON,
    projectId: PROJECT,
    prompt: 'go',
    enabled: false,
    createdAt: new Date().toISOString(),
  }
  fs.mkdirSync(path.join(tmpDir, 'schedules'), { recursive: true })
  fs.writeFileSync(path.join(tmpDir, 'schedules', `${id}.json`), JSON.stringify(entry))
  return entry
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-run-redirect-test-'))
  fetchSpy = vi.fn().mockResolvedValue(spawnReply({ id: SESSION }))
  vi.stubGlobal('fetch', fetchSpy)
  await boot()
})

afterEach(async () => {
  scheduler.stop()
  await app.close()
  vi.unstubAllGlobals()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('spawnedSessionUuid', () => {
  it('reads the id out of a session record body', () => {
    expect(spawnedSessionUuid(JSON.stringify({ id: SESSION, projectId: PROJECT }))).toBe(SESSION)
  })

  it('survives the coerced-flag shape the spawn route can add', () => {
    const body = JSON.stringify({ id: SESSION, coerced: { useTmux: true } })
    expect(spawnedSessionUuid(body)).toBe(SESSION)
  })

  it('returns null for an empty body', () => {
    expect(spawnedSessionUuid('')).toBeNull()
  })

  it('returns null rather than throwing on a non-JSON body', () => {
    expect(spawnedSessionUuid('<html>gateway timeout</html>')).toBeNull()
  })

  it('returns null when id is absent, empty, or not a string', () => {
    expect(spawnedSessionUuid(JSON.stringify({ projectId: PROJECT }))).toBeNull()
    expect(spawnedSessionUuid(JSON.stringify({ id: '' }))).toBeNull()
    expect(spawnedSessionUuid(JSON.stringify({ id: 42 }))).toBeNull()
    expect(spawnedSessionUuid(JSON.stringify({ id: null }))).toBeNull()
  })
})

describe('Scheduler.run', () => {
  it('returns the spawned session uuid', async () => {
    await seed('s1')
    await expect(scheduler.run('s1')).resolves.toBe(SESSION)
  })

  it('returns null when the spawn body carries no id, and still marks the run', async () => {
    await seed('s2')
    fetchSpy.mockResolvedValue(spawnReply({ ok: true }))
    await expect(scheduler.run('s2')).resolves.toBeNull()
    const stored = JSON.parse(fs.readFileSync(path.join(tmpDir, 'schedules', 's2.json'), 'utf8'))
    expect(stored.lastRunAt).toBeTruthy()
  })

  it('still throws — with the body in the message — when the spawn fails', async () => {
    await seed('s3')
    fetchSpy.mockResolvedValue(spawnReply('pool full', { ok: false, status: 503 }))
    await expect(scheduler.run('s3')).rejects.toThrow(/503.*pool full/s)
  })
})

describe('POST /api/schedules/:id/run', () => {
  it('answers ok plus the sessionUuid to navigate to', async () => {
    await seed('r1')
    const res = await app.inject({ method: 'POST', url: '/api/schedules/r1/run' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, sessionUuid: SESSION })
  })

  it('omits sessionUuid — rather than sending null — when there is none', async () => {
    await seed('r2')
    fetchSpy.mockResolvedValue(spawnReply({ ok: true }))
    const res = await app.inject({ method: 'POST', url: '/api/schedules/r2/run' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect('sessionUuid' in res.json()).toBe(false)
  })

  it('still 404s for an unknown schedule without spawning anything', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/schedules/nope/run' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toMatch(/Schedule not found/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
