import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { projectsPlugin } from '../../src/routes/projects.js'
import { ProjectRegistry } from '../../src/domain/project-registry.js'

/**
 * B6-F2 — PATCH shallow-merges, and the dialog omitted a field when the
 * user chose "harness default", so a project pinned to an expensive
 * model could never be un-pinned from the UI. `null` now means unset;
 * omission still means keep.
 */

let tmpDir: string
let app: ReturnType<typeof Fastify>

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-clear-'))
  await app?.close()
  app = Fastify()
  await app.register(projectsPlugin(new ProjectRegistry(tmpDir)))
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function seed(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: {
      name: 'Pinned',
      path: os.tmpdir(),
      agentType: 'claude',
      defaultModel: 'claude-opus-5',
      defaultEffort: 'high',
      agentConfig: { env: { CLAUDE_CONFIG_DIR: '/cfg' }, extraArgs: ['--verbose'] },
    },
  })
  expect(res.statusCode).toBe(201)
  return res.json().id as string
}

async function patch(id: string, payload: unknown) {
  return app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload })
}

async function get(id: string) {
  const res = await app.inject({ method: 'GET', url: `/api/projects/${id}` })
  return res.json() as Record<string, unknown>
}

describe('PATCH /api/projects/:id — null unsets', () => {
  it('clears defaultModel', async () => {
    const id = await seed()
    const res = await patch(id, { defaultModel: null })
    expect(res.statusCode).toBe(200)
    const after = await get(id)
    expect('defaultModel' in after).toBe(false)
  })

  it('clears defaultEffort', async () => {
    const id = await seed()
    expect((await patch(id, { defaultEffort: null })).statusCode).toBe(200)
    expect('defaultEffort' in (await get(id))).toBe(false)
  })

  it('clears agentConfig entirely — env, extraArgs and all', async () => {
    const id = await seed()
    expect((await patch(id, { agentConfig: null })).statusCode).toBe(200)
    expect('agentConfig' in (await get(id))).toBe(false)
  })

  it('clears all three in one request, the body the dialog now sends', async () => {
    const id = await seed()
    const res = await patch(id, {
      name: 'Pinned',
      path: os.tmpdir(),
      agentType: 'claude',
      defaultModel: null,
      defaultEffort: null,
      agentConfig: null,
      defaultUseTmux: true,
      group: null,
      tags: [],
    })
    expect(res.statusCode).toBe(200)
    const after = await get(id)
    expect('defaultModel' in after).toBe(false)
    expect('defaultEffort' in after).toBe(false)
    expect('agentConfig' in after).toBe(false)
    // The fields that are not clearable are untouched.
    expect(after.name).toBe('Pinned')
    expect(after.defaultUseTmux).toBe(true)
  })

  it('the response body reflects the clear, not just the stored record', async () => {
    const id = await seed()
    const body = (await patch(id, { defaultModel: null })).json() as Record<string, unknown>
    expect('defaultModel' in body).toBe(false)
  })
})

describe('PATCH /api/projects/:id — backwards compatibility', () => {
  it('an omitted key still merges: the old value survives', async () => {
    // Every API client written against the previous shape depends on
    // this. Only the dialog changed; the merge semantics did not.
    const id = await seed()
    expect((await patch(id, { defaultUseTmux: false })).statusCode).toBe(200)
    const after = await get(id)
    expect(after.defaultModel).toBe('claude-opus-5')
    expect(after.defaultEffort).toBe('high')
    expect(after.agentConfig).toEqual({ env: { CLAUDE_CONFIG_DIR: '/cfg' }, extraArgs: ['--verbose'] })
    expect(after.defaultUseTmux).toBe(false)
  })

  it('this is exactly the pre-fix body, and it still keeps the pin', async () => {
    const id = await seed()
    await patch(id, {
      name: 'Pinned',
      path: os.tmpdir(),
      agentType: 'claude',
      defaultUseTmux: true,
      group: null,
      tags: [],
    })
    expect((await get(id)).defaultModel).toBe('claude-opus-5')
  })

  it('setting a new value still replaces the old one', async () => {
    const id = await seed()
    await patch(id, { defaultModel: 'claude-haiku-4-5' })
    expect((await get(id)).defaultModel).toBe('claude-haiku-4-5')
  })

  it('group: null remains a value, not an erasure', async () => {
    // `group` is `string | null` on the record — null there means
    // "ungrouped", so it must survive as null rather than vanish.
    const id = await seed()
    await patch(id, { group: 'infra' })
    await patch(id, { group: null })
    const after = await get(id)
    expect('group' in after).toBe(true)
    expect(after.group).toBeNull()
  })
})

describe('PATCH /api/projects/:id — empty string is still a 400', () => {
  it('rejects defaultModel ""', async () => {
    const id = await seed()
    const res = await patch(id, { defaultModel: '' })
    expect(res.statusCode).toBe(400)
    expect((await get(id)).defaultModel).toBe('claude-opus-5')
  })

  it('rejects defaultEffort ""', async () => {
    const id = await seed()
    expect((await patch(id, { defaultEffort: '' })).statusCode).toBe(400)
  })

  it('rejects defaultModel "" on create too', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'X', path: os.tmpdir(), agentType: 'claude', defaultModel: '' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects null on create — there is nothing to clear yet', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'X', path: os.tmpdir(), agentType: 'claude', defaultModel: null },
    })
    expect(res.statusCode).toBe(400)
  })
})
