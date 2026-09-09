'use client'

import { useCallback, useEffect, useMemo } from 'react'
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

const STATUS_COLORS: Record<string, string> = {
  running: '#22c55e',
  spawning: '#3b82f6',
  completing: '#eab308',
  waiting: '#eab308',
  completed: '#a1a1aa',
  failed: '#ef4444',
  killed: '#a1a1aa',
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

  const rawNodes = useMemo((): Node[] => {
    const ids = new Set<string>()
    delegationEdges.forEach((e) => { ids.add(e.source); ids.add(e.target) })
    if (rootUuid) ids.add(rootUuid)

    return Array.from(ids).map((id) => {
      const s = sessionMap.get(id)
      return {
        id,
        type: 'default',
        position: { x: 0, y: 0 },
        data: { label: id.slice(0, 8) + (s ? `\n${s.status}` : '') },
        style: {
          background: STATUS_COLORS[s?.status ?? 'waiting'] ?? '#a1a1aa',
          color: '#fff',
          borderRadius: 8,
          fontSize: 12,
          width: NODE_W,
          height: NODE_H,
          border: id === rootUuid ? '2px solid #fff' : '1px solid rgba(255,255,255,0.2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center' as const,
          whiteSpace: 'pre-wrap',
          cursor: 'pointer',
        },
      }
    })
  }, [delegationEdges, sessionMap, rootUuid])

  const rawEdges = useMemo((): Edge[] =>
    delegationEdges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      animated: ['running', 'spawning'].includes(sessionMap.get(e.target)?.status ?? ''),
    })),
    [delegationEdges, sessionMap],
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
    router.push(`/session/${node.id}`)
  }, [router])

  if (rawNodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-400 text-sm">
        No delegation graph — select a session root via ?root=&lt;uuid&gt;
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
        // Dark theme — React Flow's Controls / MiniMap / Background pull
        // their palette from this. Without it, buttons + minimap render
        // pure white on the app's dark ground → glaring white boxes in
        // bottom-left/bottom-right. See @xyflow/react docs § colorMode.
        colorMode="dark"
      >
        <Background gap={20} size={1} color="rgba(255,255,255,0.08)" />
        <Controls
          className="react-flow__controls-dark"
          style={{
            background: 'rgba(20, 22, 28, 0.85)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6,
          }}
        />
        <MiniMap
          nodeColor={(n) => (n.style as { background?: string })?.background ?? '#71717a'}
          maskColor="rgba(20, 22, 28, 0.6)"
          style={{
            background: 'rgba(20, 22, 28, 0.85)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 6,
          }}
        />
      </ReactFlow>
    </div>
  )
}
