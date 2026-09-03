import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { ProjectRegistry, ProjectNotFoundError, ProjectPathError } from '../src/domain/project-registry.js'

let tmpDir: string
let registry: ProjectRegistry
let realProjectPath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-registry-test-'))
  realProjectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-workspace-'))
  registry = new ProjectRegistry(tmpDir)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(realProjectPath, { recursive: true, force: true })
})

describe('ProjectRegistry — create', () => {
  it('create returns project with generated id', async () => {
    const project = await registry.create({ name: 'Test', path: realProjectPath })
    expect(project.id).toBeTruthy()
    expect(project.name).toBe('Test')
    expect(project.path).toBe(realProjectPath)
    expect(project.agentType).toBe('claude')
    expect(project.tags).toEqual([])
  })

  it('create persists to disk (round-trip)', async () => {
    const created = await registry.create({ name: 'Round Trip', path: realProjectPath })
    const fetched = await registry.get(created.id)
    expect(fetched).toEqual(created)
  })

  it('create throws ProjectPathError for nonexistent path', async () => {
    await expect(
      registry.create({ name: 'Bad', path: '/nonexistent/path/xyz' }),
    ).rejects.toThrow(ProjectPathError)
  })
})

describe('ProjectRegistry — get', () => {
  it('throws ProjectNotFoundError for unknown id', async () => {
    await expect(registry.get('nonexistent-id')).rejects.toThrow(ProjectNotFoundError)
  })
})

describe('ProjectRegistry — list', () => {
  it('returns all created projects', async () => {
    await registry.create({ name: 'A', path: realProjectPath })
    await registry.create({ name: 'B', path: realProjectPath })
    const all = await registry.list()
    expect(all).toHaveLength(2)
  })

  it('returns empty array when no projects', async () => {
    const all = await registry.list()
    expect(all).toEqual([])
  })
})

describe('ProjectRegistry — update', () => {
  it('patches fields and persists', async () => {
    const p = await registry.create({ name: 'Original', path: realProjectPath })
    const updated = await registry.update(p.id, { name: 'Updated', tags: ['foo'] })
    expect(updated.name).toBe('Updated')
    expect(updated.tags).toEqual(['foo'])
    expect(updated.id).toBe(p.id)
    expect(updated.createdAt).toBe(p.createdAt)
  })
})

describe('ProjectRegistry — delete', () => {
  it('removes .json and .bak files', async () => {
    const p = await registry.create({ name: 'ToDelete', path: realProjectPath })
    // trigger a .bak by writing twice
    await registry.update(p.id, { name: 'Updated' })

    await registry.delete(p.id)

    const projectsDir = path.join(tmpDir, 'projects')
    const files = fs.readdirSync(projectsDir)
    expect(files.filter((f) => f.includes(p.id))).toEqual([])
  })

  it('throws ProjectNotFoundError for unknown id', async () => {
    await expect(registry.delete('ghost-id')).rejects.toThrow(ProjectNotFoundError)
  })
})

describe('ProjectRegistry — filter', () => {
  it('filters by group', async () => {
    await registry.create({ name: 'A', path: realProjectPath, group: 'backend' })
    await registry.create({ name: 'B', path: realProjectPath, group: 'frontend' })
    await registry.create({ name: 'C', path: realProjectPath, group: 'backend' })

    const result = await registry.filter({ group: 'backend' })
    expect(result).toHaveLength(2)
    expect(result.every((p) => p.group === 'backend')).toBe(true)
  })

  it('filters by tags (all must match)', async () => {
    await registry.create({ name: 'A', path: realProjectPath, tags: ['ts', 'api'] })
    await registry.create({ name: 'B', path: realProjectPath, tags: ['ts'] })
    await registry.create({ name: 'C', path: realProjectPath, tags: ['api'] })

    const result = await registry.filter({ tags: ['ts', 'api'] })
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('A')
  })

  it('filter by group + tags combined', async () => {
    await registry.create({ name: 'A', path: realProjectPath, group: 'backend', tags: ['ts'] })
    await registry.create({ name: 'B', path: realProjectPath, group: 'backend', tags: ['go'] })
    await registry.create({ name: 'C', path: realProjectPath, group: 'frontend', tags: ['ts'] })

    const result = await registry.filter({ group: 'backend', tags: ['ts'] })
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('A')
  })

  it('empty filter returns all', async () => {
    await registry.create({ name: 'X', path: realProjectPath })
    await registry.create({ name: 'Y', path: realProjectPath })
    const result = await registry.filter({})
    expect(result).toHaveLength(2)
  })
})
