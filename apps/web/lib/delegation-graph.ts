/**
 * Which sessions the delegation graph should draw, and which of them a
 * click may navigate to.
 *
 * Split out of `DelegationGraph` so it is unit-testable (apps/web's
 * vitest is node-only and only picks up `lib/**`).
 *
 * The rule it encodes: **a root the sessions list does not know is not
 * drawn.** `?root=` used to be added to the node set unconditionally, so
 * any string in the query — a typo, a UUID whose session was deleted,
 * `not-a-uuid` — produced a one-node graph with no status line, full
 * canvas chrome, and a click that navigated to `/session/<that string>`
 * (B6-F3). The empty-state branch was unreachable whenever a root was
 * present, which is why nothing said "unknown root".
 *
 * Nodes reached through an *edge* are treated differently: a delegation
 * record is evidence the session existed, and the list can legitimately
 * not have it (filtered, archived, pruned). Those are still drawn, so
 * the tree keeps its shape, but they are marked `known: false` and are
 * inert on click — navigating to a session the API will 404 on is the
 * broken half of the defect, and it is broken for edge nodes too.
 */

export interface GraphSessionLike {
  id: string
  status?: string
}

export interface GraphEdgeLike {
  id: string
  source: string
  target: string
  label?: string
}

export type RootState =
  /** No `?root=` and no edges — the user has not asked for anything yet. */
  | { kind: 'none' }
  /** A root was given and the sessions list has it. */
  | { kind: 'known'; id: string }
  /** A root was given and no session by that id exists. Nothing is drawn
   *  for it; the page says so rather than inventing a node. */
  | { kind: 'unknown'; id: string }

export interface GraphPlanNode {
  id: string
  /** True when a session with this id is in the sessions list. Only these
   *  are clickable — a click on anything else would land on a 404. */
  known: boolean
  isRoot: boolean
  status?: string
}

export interface GraphPlan {
  nodes: GraphPlanNode[]
  /** Edges whose endpoints both survived node selection. */
  edges: GraphEdgeLike[]
  root: RootState
}

export function planDelegationGraph(
  sessions: GraphSessionLike[],
  delegationEdges: GraphEdgeLike[],
  rootUuid?: string,
): GraphPlan {
  const byId = new Map<string, GraphSessionLike>()
  sessions.forEach((s) => byId.set(s.id, s))

  const rootKnown = Boolean(rootUuid) && byId.has(rootUuid as string)
  const root: RootState = !rootUuid
    ? { kind: 'none' }
    : rootKnown
      ? { kind: 'known', id: rootUuid }
      : { kind: 'unknown', id: rootUuid }

  const ids = new Set<string>()
  delegationEdges.forEach((e) => { ids.add(e.source); ids.add(e.target) })
  // Only a root the sessions list can vouch for joins the set on its own.
  // An unknown root that an edge already references still gets drawn —
  // the edge is the evidence, not the query string.
  if (rootUuid && rootKnown) ids.add(rootUuid)

  const nodes: GraphPlanNode[] = Array.from(ids).map((id) => {
    const s = byId.get(id)
    return {
      id,
      known: Boolean(s),
      isRoot: id === rootUuid,
      ...(s?.status !== undefined ? { status: s.status } : {}),
    }
  })

  const present = new Set(nodes.map((n) => n.id))
  const edges = delegationEdges.filter((e) => present.has(e.source) && present.has(e.target))

  return { nodes, edges, root }
}

/** Copy for the empty state, which is now reachable in two distinct
 *  situations that deserve different sentences. */
export function emptyGraphMessage(root: RootState): string {
  if (root.kind === 'unknown') {
    return `No session ${root.id} — it may have been deleted, or the id in ?root= is wrong.`
  }
  return 'No delegation graph — select a session root via ?root=<uuid>'
}
