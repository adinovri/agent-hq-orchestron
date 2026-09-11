'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from '@dagrejs/dagre'
import type { SessionMetadata, DelegationGraphEdge } from '@agent-hq-orchestron/shared'
import { planDelegationGraph, emptyGraphMessage } from '@/lib/delegation-graph'

const NODE_W = 200
const NODE_H = 70

function layoutDagre(
  nodes: Node[],
  edges: Edge[],
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', ranksep: 60, nodesep: 40 })

  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }))
  edges.forEach((e) => g.setEdge(e.source, e.target))

  dagre.layout(g)

  return {
    nodes: nodes.map((n) => {
      const pos = g.node(n.id)
      return {
        ...n,
        position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 },
      }
    }),
    edges,
  }
}

// Aligned with StatusPill (apps/web/lib/status.ts) so the graph reads
// the same as dashboard chips. Covers all 9 states of state-machine v2
// (2026-09-05 removed `completing`/`completed`). Colors picked to read
// on both dark themes (orchestron zinc + tycho warm) and the light
// theme — saturated fills + white text works on both grounds.
const STATUS_COLORS: Record<string, string> = {
  spawning: '#0284c7',      // sky-600
  waiting: '#ca8a04',       // yellow-600
  running: '#059669',       // emerald-600 (bright — active)
  needs_input: '#d97706',   // amber-600 (attention)
  idle: '#71717a',          // zinc-500 (calm neutral)
  sleeping: '#6366f1',      // indigo-500 (dormant, distinctive)
  succeeded: '#15803d',     // emerald-700 (calmer, done)
  failed: '#dc2626',        // red-600
  killed: '#52525b',        // zinc-600 (muted terminal)
}
// Slightly stronger border to lift each node against the dot-grid bg.
function borderFor(status?: string): string {
  const base = STATUS_COLORS[status ?? 'idle'] ?? '#71717a'
  return base
}

interface Props {
  sessions: SessionMetadata[]
  delegationEdges: DelegationGraphEdge[]
  rootUuid?: string
}

export function DelegationGraph({ sessions, delegationEdges, rootUuid }: Props) {
  const router = useRouter()

  const sessionMap = useMemo(() => {
    const m = new Map<string, SessionMetadata>()
    sessions.forEach((s) => m.set(s.id, s))
    return m
  }, [sessions])

  // Node selection, the unknown-root rule and the inert/clickable split
  // live in lib/delegation-graph so they can be tested without a DOM.
  const plan = useMemo(
    () => planDelegationGraph(sessions, delegationEdges, rootUuid),
    [sessions, delegationEdges, rootUuid],
  )

  // Ids a click may navigate to. Everything else renders, but inert —
  // `/session/<id>` for a session the API does not have is a dead end.
  const clickable = useMemo(
    () => new Set(plan.nodes.filter((n) => n.known).map((n) => n.id)),
    [plan],
  )

  const rawNodes = useMemo((): Node[] =>
    plan.nodes.map((n) => ({
      id: n.id,
      type: 'default',
      position: { x: 0, y: 0 },
      data: { label: n.id.slice(0, 8) + (n.known ? `\n${n.status}` : '\nnot in session list') },
      style: {
        background: STATUS_COLORS[n.status ?? 'idle'] ?? '#71717a',
        color: '#fff',
        borderRadius: 10,
        fontSize: 12,
        fontWeight: 500,
        width: NODE_W,
        height: NODE_H,
        // Root gets a bright white ring so it's distinct in a tree.
        // Non-root nodes get a subtle same-hue border so the fill has
        // a lift against the dot-grid, without competing with the fill.
        border: n.isRoot
          ? '2px solid #fff'
          : `1px solid ${borderFor(n.status)}`,
        boxShadow: n.isRoot
          ? '0 0 0 3px rgba(255,255,255,0.15)'
          : '0 1px 3px rgba(0,0,0,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center' as const,
        whiteSpace: 'pre-wrap',
        // A node with no session behind it advertises that it goes
        // nowhere, rather than looking identical to one that does.
        cursor: n.known ? 'pointer' : 'default',
        opacity: n.known ? 1 : 0.55,
      },
    })),
    [plan],
  )

  const rawEdges = useMemo((): Edge[] =>
    plan.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      animated: ['running', 'spawning'].includes(sessionMap.get(e.target)?.status ?? ''),
    })),
    [plan, sessionMap],
  )

  const { nodes: laidOutNodes, edges: laidOutEdges } = useMemo(() => {
    if (rawNodes.length === 0) return { nodes: [], edges: [] }
    return layoutDagre(rawNodes, rawEdges)
  }, [rawNodes, rawEdges])

  const [nodes, setNodes, onNodesChange] = useNodesState(laidOutNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(laidOutEdges)

  useEffect(() => { setNodes(laidOutNodes) }, [laidOutNodes, setNodes])
  useEffect(() => { setEdges(laidOutEdges) }, [laidOutEdges, setEdges])

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (!clickable.has(node.id)) return
    router.push(`/session/${node.id}`)
  }, [router, clickable])

  // Track the active app theme (orchestron/tycho/light) so React Flow's
  // Controls/MiniMap/Background pick the right palette. ThemeSwitcher
  // sets `data-theme` on <html>; watch that attribute for changes so a
  // live theme toggle re-styles the graph without a reload.
  const [isLight, setIsLight] = useState(false)
  useEffect(() => {
    const html = document.documentElement
    const detect = () => setIsLight(html.getAttribute('data-theme') === 'light')
    detect()
    const obs = new MutationObserver(detect)
    obs.observe(html, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  const dotColor = isLight ? 'rgba(20,22,28,0.10)' : 'rgba(255,255,255,0.08)'
  const chromeStyle = {
    background: 'var(--card)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    color: 'var(--card-foreground)',
  } as const
  const miniMaskColor = isLight ? 'rgba(20,22,28,0.06)' : 'rgba(20,22,28,0.6)'

  // Reachable again: an unknown `?root=` no longer forces a node into the
  // set, so "you asked for a session that isn't there" has somewhere to
  // be said instead of being drawn as a phantom.
  if (rawNodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 px-4 text-center text-zinc-400 text-sm">
        {emptyGraphMessage(plan.root)}
      </div>
    )
  }

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2}
        // Theme-aware — orchestron/tycho are dark, light is light.
        // Without this, React Flow's chrome renders in its default
        // palette (white boxes on a dark app ground, or vice versa on
        // the light theme). See @xyflow/react docs § colorMode.
        colorMode={isLight ? 'light' : 'dark'}
      >
        <Background gap={20} size={1} color={dotColor} />
        <Controls style={chromeStyle} />
        <MiniMap
          nodeColor={(n) => (n.style as { background?: string })?.background ?? '#71717a'}
          maskColor={miniMaskColor}
          style={chromeStyle}
        />
      </ReactFlow>
    </div>
  )
}
