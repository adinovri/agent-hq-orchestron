import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DelegationTracker } from '../src/domain/delegation-tracker.js'
import type { SessionManager } from '../src/domain/session-manager.js'

let tmpDir: string
let tracker: DelegationTracker

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-test-'))
  tracker = new DelegationTracker(tmpDir)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('DelegationTracker — recordEdge + getChildren', () => {
  it('records and retrieves children', async () => {
    await tracker.recordEdge('parent1', 'child1', 'do something')
    await tracker.recordEdge('parent1', 'child2')
    const children = await tracker.getChildren('parent1')
    expect(children).toHaveLength(2)
    expect(children[0].childUuid).toBe('child1')
    expect(children[0].spawnPrompt).toBe('do something')
    expect(children[1].childUuid).toBe('child2')
    expect(children[1].spawnPrompt).toBeUndefined()
  })

  it('returns empty array for unknown parent', async () => {
    const children = await tracker.getChildren('unknown-uuid')
    expect(children).toHaveLength(0)
  })

  it('excludes detached sessions', async () => {
    await tracker.recordEdge('parent1', 'child1', undefined, true)
    const children = await tracker.getChildren('parent1')
    expect(children).toHaveLength(0)
  })

  it('includes non-detached sessions', async () => {
    await tracker.recordEdge('parent1', 'child1', undefined, false)
    const children = await tracker.getChildren('parent1')
    expect(children).toHaveLength(1)
  })
})

describe('DelegationTracker — getDescendants', () => {
  it('returns empty for leaf node', async () => {
    const descendants = await tracker.getDescendants('leaf')
    expect(descendants).toHaveLength(0)
  })

  it('3-level BFS traversal', async () => {
    await tracker.recordEdge('root', 'child1')
    await tracker.recordEdge('root', 'child2')
    await tracker.recordEdge('child1', 'grandchild1')
    await tracker.recordEdge('child2', 'grandchild2')

    const descendants = await tracker.getDescendants('root')
    expect(descendants).toContain('child1')
    expect(descendants).toContain('child2')
    expect(descendants).toContain('grandchild1')
    expect(descendants).toContain('grandchild2')
    expect(descendants).toHaveLength(4)
  })
})

describe('DelegationTracker — killCascade', () => {
  it('kills all descendants (leaves first)', async () => {
    await tracker.recordEdge('root', 'child1')
    await tracker.recordEdge('child1', 'grandchild1')

    const killed: string[] = []
    const mockSessionManager = {
      kill: vi.fn().mockImplementation((uuid: string) => {
        killed.push(uuid)
        return Promise.resolve({})
      }),
    } as unknown as SessionManager

    await tracker.killCascade('root', mockSessionManager)

    expect(killed).toContain('child1')
    expect(killed).toContain('grandchild1')
    expect(killed).toHaveLength(2)
    // grandchild killed before child (reverse order)
    expect(killed.indexOf('grandchild1')).toBeLessThan(killed.indexOf('child1'))
  })

  it('3-level cascade kills all nodes', async () => {
    await tracker.recordEdge('root', 'child1')
    await tracker.recordEdge('root', 'child2')
    await tracker.recordEdge('child1', 'grandchild1')

    const killFn = vi.fn().mockResolvedValue({})
    const mockSessionManager = { kill: killFn } as unknown as SessionManager

    await tracker.killCascade('root', mockSessionManager)
    expect(killFn).toHaveBeenCalledTimes(3)
  })

  it('swallows errors per session (best-effort)', async () => {
    await tracker.recordEdge('root', 'child1')

    const mockSessionManager = {
      kill: vi.fn().mockRejectedValue(new Error('already dead')),
    } as unknown as SessionManager

    await expect(tracker.killCascade('root', mockSessionManager)).resolves.toBeUndefined()
  })
})

describe('DelegationTracker — getAncestorChain', () => {
  it('returns empty for root node', async () => {
    await tracker.recordEdge('root', 'child')
    const chain = await tracker.getAncestorChain('root')
    expect(chain).toHaveLength(0)
  })

  it('returns correct ancestry order', async () => {
    await tracker.recordEdge('grandparent', 'parent')
    await tracker.recordEdge('parent', 'child')

    const chain = await tracker.getAncestorChain('child')
    expect(chain).toEqual(['parent', 'grandparent'])
  })

  it('returns empty for unknown uuid', async () => {
    const chain = await tracker.getAncestorChain('nobody')
    expect(chain).toHaveLength(0)
  })
})
