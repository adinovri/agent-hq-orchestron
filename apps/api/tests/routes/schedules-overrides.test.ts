import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { schedulesPlugin } from '../../src/routes/schedules.js'
import { ProjectRegistry } from '../../src/domain/project-registry.js'
import { Scheduler, type ScheduleEntry } from '../../src/domain/scheduler.js'

let tmpDir: string
let scheduler: Scheduler
let app: ReturnType<typeof Fastify>
let fetchSpy: ReturnType<typeof vi.fn>

const CRON = '0 9 * * 1'
const PROJECT = '11111111-1111-4111-8111-111111111111'

/** The routes now refuse a `projectId` that names nothing (NEW-3), so the
 *  fixture project has to exist on disk. Written straight into the registry's
 *  directory rather than through `create()`, which insists on a real writable
 *  workspace path these tests have no use for. */
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


/** Build the plugin against a fresh Scheduler. `headless` mirrors the global
 *  kill switch — the whole point of most of these cases. */
async function boot(headless: boolean) {
  scheduler = new Scheduler(tmpDir, 'http://api.test', null)
  app = Fastify({ logger: false })
  // server.ts registers this so a YAML body arrives as a raw string; the
  // import route parses it itself.
  app.addContentTypeParser(
    ['application/x-yaml', 'application/yaml', 'text/yaml'],
    { parseAs: 'string' },
    (_req, body, done) => done(null, body),
  )
  await app.register(schedulesPlugin(scheduler, seedProject(tmpDir, PROJECT), { enableHeadlessMode: headless }))
  await app.ready()
}

async function create(body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/schedules',
    payload: { cron: CRON, projectId: PROJECT, prompt: 'go', enabled: false, ...body },
  })
}

/** Read the record off disk rather than out of the response, so a test that
 *  says "cleared" is asserting the field really left the file. */
function stored(id: string): ScheduleEntry {
  return JSON.parse(fs.readFileSync(path.join(tmpDir, 'schedules', `${id}.json`), 'utf8'))
}

/** The JSON body the scheduler POSTed to /api/sessions on the last fire. */
function firedBody(): Record<string, unknown> {
  const init = fetchSpy.mock.calls[0]![1] as { body: string }
  return JSON.parse(init.body)
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-overrides-test-'))
  fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 201, text: async () => '' })
  vi.stubGlobal('fetch', fetchSpy)
  await boot(true)
})

afterEach(async () => {
  scheduler.stop()
  await app.close()
  vi.unstubAllGlobals()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('POST /api/schedules — overrides', () => {
  it('stores nothing for the three fields when the body omits them', async () => {
    const res = await create({})
    expect(res.statusCode).toBe(201)
    const entry = stored(res.json().id)
    expect('model' in entry).toBe(false)
    expect('effort' in entry).toBe(false)
    expect('useTmux' in entry).toBe(false)
    expect(res.json().coerced).toBeUndefined()
  })

  it('stores each override the body pins', async () => {
    const res = await create({ model: 'claude-opus-5', effort: 'high', useTmux: false })
    expect(res.statusCode).toBe(201)
    expect(stored(res.json().id)).toMatchObject({
      model: 'claude-opus-5', effort: 'high', useTmux: false,
    })
  })

  it('treats the empty spellings as "no override", not as values', async () => {
    const res = await create({ model: '', effort: '', useTmux: null })
    const entry = stored(res.json().id)
    expect('model' in entry).toBe(false)
    expect('effort' in entry).toBe(false)
    expect('useTmux' in entry).toBe(false)
  })

  it('rejects an effort outside the catalog', async () => {
    const res = await create({ effort: 'turbo' })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/schedules — headless kill switch', () => {
  it('coerces an explicit headless request to tmux and says so', async () => {
    await boot(false)
    const res = await create({ useTmux: false })
    expect(res.statusCode).toBe(201)
    expect(stored(res.json().id).useTmux).toBe(true)
    expect(res.json().coerced).toEqual({ useTmux: true, reason: 'headless disabled globally' })
  })

  it('leaves a body that never mentions the mode unpinned', async () => {
    await boot(false)
    const res = await create({})
    expect('useTmux' in stored(res.json().id)).toBe(false)
    expect(res.json().coerced).toBeUndefined()
  })
})

describe('PATCH /api/schedules/:id — overrides', () => {
  async function patch(id: string, body: Record<string, unknown>) {
    return app.inject({ method: 'PATCH', url: `/api/schedules/${id}`, payload: body })
  }

  it('leaves an override alone when the patch does not mention it', async () => {
    const id = (await create({ model: 'claude-opus-5', useTmux: false })).json().id
    const res = await patch(id, { enabled: true })
    expect(res.statusCode).toBe(200)
    expect(stored(id)).toMatchObject({ model: 'claude-opus-5', useTmux: false, enabled: true })
  })

  it('clears an override sent as the empty spelling', async () => {
    const id = (await create({ model: 'claude-opus-5', effort: 'high', useTmux: false })).json().id
    await patch(id, { model: '', effort: '', useTmux: null })
    const entry = stored(id)
    expect('model' in entry).toBe(false)
    expect('effort' in entry).toBe(false)
    expect('useTmux' in entry).toBe(false)
  })

  it('coerces a flip to headless while the switch is off', async () => {
    await boot(false)
    const id = (await create({})).json().id
    const res = await patch(id, { useTmux: false })
    expect(stored(id).useTmux).toBe(true)
    expect(res.json().coerced).toEqual({ useTmux: true, reason: 'headless disabled globally' })
  })

  it('does not touch a stored headless preference when the patch skips the mode', async () => {
    const id = (await create({ useTmux: false })).json().id
    await boot(false)
    const res = await patch(id, { model: 'claude-sonnet-5' })
    expect(stored(id).useTmux).toBe(false)
    expect(res.json().coerced).toBeUndefined()
  })

  it('rejects an invalid cron instead of storing one that can never fire', async () => {
    const id = (await create({})).json().id
    const res = await patch(id, { cron: 'not a cron' })
    expect(res.statusCode).toBe(400)
    expect(stored(id).cron).toBe(CRON)
  })

  it('drops keys that are not editable fields', async () => {
    const id = (await create({})).json().id
    await patch(id, { enabled: true, lastRunAt: 'yesterday', nonsense: 1 })
    const entry = stored(id) as Record<string, unknown>
    expect(entry.lastRunAt).toBeUndefined()
    expect(entry.nonsense).toBeUndefined()
  })
})

describe('fire — what reaches POST /api/sessions', () => {
  it('passes each pinned override through', async () => {
    const id = (await create({ model: 'claude-opus-5', effort: 'high', useTmux: false })).json().id
    await scheduler.run(id)
    expect(firedBody()).toMatchObject({
      projectId: PROJECT, prompt: 'go', model: 'claude-opus-5', effort: 'high', useTmux: false,
    })
  })

  it('omits an unpinned field entirely, so the spawn route resolves it against the project', async () => {
    const id = (await create({})).json().id
    await scheduler.run(id)
    const body = firedBody()
    expect('model' in body).toBe(false)
    expect('effort' in body).toBe(false)
    expect('useTmux' in body).toBe(false)
  })

  it('sends useTmux:true as a real value rather than dropping it as falsy-adjacent', async () => {
    const id = (await create({ useTmux: true })).json().id
    await scheduler.run(id)
    expect(firedBody().useTmux).toBe(true)
  })
})

describe('YAML export / import', () => {
  async function exportYaml(): Promise<{ schedules: ScheduleEntry[] }> {
    const res = await app.inject({ method: 'GET', url: '/api/schedules/export' })
    return YAML.parse(res.body)
  }

  async function importYaml(doc: unknown, mode = 'merge') {
    return app.inject({
      method: 'POST',
      url: `/api/schedules/import?mode=${mode}`,
      headers: { 'content-type': 'application/x-yaml' },
      payload: YAML.stringify(doc),
    })
  }

  it('writes the overrides it has and omits the ones it does not', async () => {
    await create({ model: 'claude-opus-5', useTmux: false })
    const doc = await exportYaml()
    expect(doc.schedules[0]).toMatchObject({ model: 'claude-opus-5', useTmux: false })
    expect('effort' in doc.schedules[0]!).toBe(false)
  })

  it('round-trips a document through export and back', async () => {
    const id = (await create({ model: 'claude-opus-5', effort: 'max', useTmux: false })).json().id
    const doc = await exportYaml()
    await scheduler.delete(id)
    const res = await importYaml(doc)
    expect(res.json()).toMatchObject({ created: 1, coerced: 0 })
    expect(stored(id)).toMatchObject({ model: 'claude-opus-5', effort: 'max', useTmux: false })
  })

  it('accepts a document written before the fields existed', async () => {
    const res = await importYaml({
      schedules: [{ id: 'legacy-one', cron: CRON, projectId: PROJECT, prompt: 'go', enabled: true }],
    })
    expect(res.json()).toMatchObject({ created: 1, skipped: 0 })
    const entry = stored('legacy-one')
    expect('model' in entry).toBe(false)
    expect('useTmux' in entry).toBe(false)
  })

  it('reports an entry whose effort is not in the catalog instead of storing it', async () => {
    const res = await importYaml({
      schedules: [{ id: 'bad-one', cron: CRON, projectId: PROJECT, prompt: 'go', effort: 'turbo' }],
    })
    expect(res.json().created).toBe(0)
    expect(res.json().errors[0].error).toContain('invalid model/effort/useTmux')
  })

  it('forces a headless entry to tmux while the switch is off, and counts it', async () => {
    await boot(false)
    const res = await importYaml({
      schedules: [{ id: 'headless-one', cron: CRON, projectId: PROJECT, prompt: 'go', useTmux: false }],
    })
    expect(res.json()).toMatchObject({ created: 1, coerced: 1 })
    expect(stored('headless-one').useTmux).toBe(true)
  })
})
