import { describe, it, expect } from 'vitest'
import { planDelegationGraph, emptyGraphMessage } from './delegation-graph'

const REAL = '11111111-1111-4111-8111-111111111111'
const CHILD = '22222222-2222-4222-8222-222222222222'
const GHOST = '00000000-0000-0000-0000-000000000000'

const sessions = [
  { id: REAL, status: 'idle' },
  { id: CHILD, status: 'running' },
]

const edge = { id: 'e1', source: REAL, target: CHILD, label: 'spawn' }

describe('planDelegationGraph — an unknown root is not drawn (B6-F3)', () => {
  it('drops a root the sessions list does not have', () => {
    const plan = planDelegationGraph(sessions, [], GHOST)
    expect(plan.nodes).toEqual([])
    expect(plan.root).toEqual({ kind: 'unknown', id: GHOST })
  })

  it('drops a root that is not even a uuid', () => {
    const plan = planDelegationGraph(sessions, [], 'not-a-uuid')
    expect(plan.nodes).toEqual([])
    expect(plan.root.kind).toBe('unknown')
  })

  it('leaves the empty state reachable, which it was not before', () => {
    // Previously `ids.add(rootUuid)` ran unconditionally, so rawNodes was
    // never empty while a root was present and the branch was dead code.
    expect(planDelegationGraph(sessions, [], GHOST).nodes.length).toBe(0)
  })

  it('still draws a real childless root', () => {
    const plan = planDelegationGraph(sessions, [], REAL)
    expect(plan.nodes).toEqual([
      { id: REAL, known: true, isRoot: true, status: 'idle' },
    ])
    expect(plan.root).toEqual({ kind: 'known', id: REAL })
  })

  it('reports no root at all when none was asked for', () => {
    const plan = planDelegationGraph(sessions, [], undefined)
    expect(plan.nodes).toEqual([])
    expect(plan.root).toEqual({ kind: 'none' })
  })
})

describe('planDelegationGraph — clickability tracks existence', () => {
  it('marks every node backed by a session as known', () => {
    const plan = planDelegationGraph(sessions, [edge], REAL)
    expect(plan.nodes.every((n) => n.known)).toBe(true)
    expect(plan.nodes.map((n) => n.id).sort()).toEqual([REAL, CHILD].sort())
  })

  it('still draws an edge endpoint missing from the list, but inert', () => {
    // A delegation record is evidence the child existed; the list can be
    // filtered or pruned. Draw it so the tree keeps its shape — but a
    // click would 404, so it must not be clickable.
    const plan = planDelegationGraph(
      [{ id: REAL, status: 'idle' }],
      [edge],
      REAL,
    )
    const child = plan.nodes.find((n) => n.id === CHILD)
    expect(child).toBeDefined()
    expect(child?.known).toBe(false)
    expect(child?.status).toBeUndefined()
  })

  it('keeps an unknown root when an edge references it', () => {
    const plan = planDelegationGraph([{ id: CHILD, status: 'idle' }], [edge], REAL)
    const root = plan.nodes.find((n) => n.id === REAL)
    expect(root?.isRoot).toBe(true)
    expect(root?.known).toBe(false)
  })

  it('drops edges whose endpoints were not drawn', () => {
    const orphan = { id: 'e2', source: GHOST, target: 'zzz' }
    const plan = planDelegationGraph(sessions, [edge], REAL)
    expect(plan.edges).toEqual([edge])
    const plan2 = planDelegationGraph(sessions, [edge, orphan], REAL)
    // orphan's endpoints are added by the edge itself, so both survive —
    // pinning that edges are only dropped when a node was actually removed.
    expect(plan2.edges).toHaveLength(2)
  })
})

describe('emptyGraphMessage', () => {
  it('names the missing id when the root is unknown', () => {
    const msg = emptyGraphMessage({ kind: 'unknown', id: GHOST })
    expect(msg).toContain(GHOST)
    expect(msg).toMatch(/deleted|wrong/)
  })

  it('falls back to the pick-a-root prompt otherwise', () => {
    expect(emptyGraphMessage({ kind: 'none' })).toContain('?root=')
  })
})
