import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { schedulesPlugin, isValidCron } from '../../src/routes/schedules.js'
import { Scheduler, type ScheduleEntry } from '../../src/domain/scheduler.js'

/**
 * E2E smoke finding F3. `CronExpressionParser.parse` pads a short expression
 * instead of rejecting it, so the validator that only asked "does it parse?"
 * turned `* * * *` into an every-minute schedule — observed live, three
 * unattended spawns before it was deleted. The field count has to be checked
 * first, and it has to hold on all three write paths, not just POST.
 */

let tmpDir: string
let scheduler: Scheduler
let app: ReturnType<typeof Fastify>

const VALID = '0 9 * * 1'
const PROJECT = '11111111-1111-4111-8111-111111111111'

/** Expressions cron-parser accepts but a schedule must not carry. */
const REJECTED: Array<[string, string]> = [
  ['* * * *', 'four fields — padded to every-minute'],
  ['1 2', 'two fields — padded to a date nobody asked for'],
  ['*/5 * * * * *', 'six fields — seconds, so every five seconds'],
  ['0 9 * * 1 2030', 'six fields — a year-ish trailing field'],
  ['nonsense', 'not cron at all'],
  ['@daily', 'alias the dialog cannot render'],
  ['0 9 * * 1\n0 9 * * 2', 'newline-joined pair — nine fields'],
]

async function boot() {
  scheduler = new Scheduler(tmpDir, 'http://api.test', null)
  app = Fastify({ logger: false })
  app.addContentTypeParser(
    ['application/x-yaml', 'application/yaml', 'text/yaml'],
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  )
  await app.register(schedulesPlugin(scheduler, { enableHeadlessMode: true }))
  await app.ready()
}

async function create(body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/schedules',
    payload: { cron: VALID, projectId: PROJECT, prompt: 'go', enabled: false, ...body },
  })
}

function storedIds(): string[] {
  const dir = path.join(tmpDir, 'schedules')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
}

function stored(id: string): ScheduleEntry {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'schedules', `${id}.json`), 'utf8'))
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-cron-test-'))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 201, text: async () => '' }))
  await boot()
})

afterEach(async () => {
  scheduler.stop()
  await app.close()
  vi.unstubAllGlobals()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('isValidCron', () => {
  it.each([
    ['* * * * *', 'the every-minute expression spelled in full'],
    [VALID, 'a weekday range'],
    ['0 */6 * * *', 'a step'],
    ['0 9 1,15 * *', 'a list'],
    ['  0 9 * * 1  ', 'surrounding whitespace'],
  ])('accepts %j (%s)', (expr) => {
    expect(isValidCron(expr)).toBe(true)
  })

  it.each(REJECTED)('rejects %j (%s)', (expr) => {
    expect(isValidCron(expr)).toBe(false)
  })

  it('rejects a five-field expression whose values are out of range', () => {
    // The field count is a pre-filter, not a replacement for the parse.
    expect(isValidCron('99 9 * * 1')).toBe(false)
  })
})

describe('POST /api/schedules — cron field count', () => {
  it.each(REJECTED)('refuses to create a schedule from %j (%s)', async (expr) => {
    const res = await create({ cron: expr })
    expect(res.statusCode).toBe(400)
    expect(storedIds()).toHaveLength(0)
  })

  it('still creates one from a five-field expression', async () => {
    const res = await create({})
    expect(res.statusCode).toBe(201)
    expect(stored(res.json().id).cron).toBe(VALID)
  })
})

describe('PATCH /api/schedules/:id — cron field count', () => {
  it.each(REJECTED)('refuses to rewrite a stored cron to %j (%s)', async (expr) => {
    const id = (await create({})).json().id
    const res = await app.inject({ method: 'PATCH', url: `/api/schedules/${id}`, payload: { cron: expr } })
    expect(res.statusCode).toBe(400)
    // The whole point: the schedule keeps firing on its old, valid cron
    // rather than being quietly retimed to every minute.
    expect(stored(id).cron).toBe(VALID)
  })
})

describe('POST /api/schedules/import — cron field count', () => {
  async function importYaml(cron: string) {
    return app.inject({
      method: 'POST',
      url: '/api/schedules/import?mode=merge',
      headers: { 'content-type': 'application/x-yaml' },
      payload: YAML.stringify({
        schedules: [{ id: 'imported-one', cron, projectId: PROJECT, prompt: 'go', enabled: true }],
      }),
    })
  }

  it.each(REJECTED)('reports %j (%s) as an error instead of importing it', async (expr) => {
    const res = await importYaml(expr)
    expect(res.json().created).toBe(0)
    expect(res.json().errors[0].error).toContain('invalid cron expression')
    expect(storedIds()).toHaveLength(0)
  })

  it('imports a five-field entry', async () => {
    const res = await importYaml(VALID)
    expect(res.json()).toMatchObject({ created: 1 })
    expect(stored('imported-one').cron).toBe(VALID)
  })
})
