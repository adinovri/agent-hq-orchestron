import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { projectsPlugin } from '../../src/routes/projects.js'
import { ProjectRegistry } from '../../src/domain/project-registry.js'

let tmpDir: string
let app: ReturnType<typeof Fastify>

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-projects-test-'))
  const registry = new ProjectRegistry(tmpDir)
  app = Fastify()
  await app.register(projectsPlugin(registry))
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const validBody = {
  name: 'TestProject',
  path: os.tmpdir(), // guaranteed to exist and be writable
  agentType: 'claude',
}

describe('POST /api/projects', () => {
  it('creates project and returns 201', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: validBody })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.id).toBeDefined()
    expect(body.name).toBe('TestProject')
  })

  it('returns 400 on invalid body', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/projects', payload: { name: '' } })
    expect(res.statusCode).toBe(400)
  })

  it('returns 422 when path does not exist', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/projects',
      payload: { ...validBody, path: '/nonexistent/path/xyz' },
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('GET /api/projects', () => {
  it('returns empty list initially', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(res.statusCode).toBe(200)
    expect(res.json().projects).toHaveLength(0)
  })

  it('returns created projects', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: validBody })
    const res = await app.inject({ method: 'GET', url: '/api/projects' })
    expect(res.json().projects).toHaveLength(1)
  })

  it('filters by group', async () => {
    await app.inject({ method: 'POST', url: '/api/projects', payload: { ...validBody, group: 'alpha' } })
    await app.inject({ method: 'POST', url: '/api/projects', payload: { ...validBody, name: 'B', group: 'beta' } })
    const res = await app.inject({ method: 'GET', url: '/api/projects?group=alpha' })
    expect(res.json().projects).toHaveLength(1)
    expect(res.json().projects[0].group).toBe('alpha')
  })
})

describe('GET /api/projects/:id', () => {
  it('returns the project', async () => {
    const create = await app.inject({ method: 'POST', url: '/api/projects', payload: validBody })
    const { id } = create.json()
    const res = await app.inject({ method: 'GET', url: `/api/projects/${id}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().id).toBe(id)
  })

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/00000000-0000-0000-0000-000000000000` })
    expect(res.statusCode).toBe(404)
  })
})

describe('PATCH /api/projects/:id', () => {
  it('updates project name', async () => {
    const create = await app.inject({ method: 'POST', url: '/api/projects', payload: validBody })
    const { id } = create.json()
    const res = await app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: { name: 'Updated' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Updated')
  })

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/projects/00000000-0000-0000-0000-000000000000`, payload: { name: 'X' } })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /api/projects/:id', () => {
  it('deletes project and returns 204', async () => {
    const create = await app.inject({ method: 'POST', url: '/api/projects', payload: validBody })
    const { id } = create.json()
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/${id}` })
    expect(res.statusCode).toBe(204)
  })

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/api/projects/00000000-0000-0000-0000-000000000000` })
    expect(res.statusCode).toBe(404)
  })
})
