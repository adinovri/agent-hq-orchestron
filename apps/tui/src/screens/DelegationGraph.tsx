import React, { useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'
import type { ApiConfig } from '../hooks/useApi.js'
import { useApi } from '../hooks/useApi.js'

// TODO: D keybind wiring from SessionDetail deferred to P1a merge.
// When P1a is ready, add `onDelegation` prop to SessionDetail and
// wire keybind 'D' → DelegationGraph with `session.id` as rootUuid.

interface DelegationEdge {
  id: string
  source: string
  target: string
  label?: string
}

interface DelegationResponse {
  nodes: SessionMetadata[]
  edges: DelegationEdge[]
}

interface Props {
  rootUuid: string
  config: ApiConfig
  onBack: () => void
}

const STATUS_CHAR: Record<string, string> = {
  spawning: '⋯',
  waiting: '⊙',
  running: '▶',
  needs_input: '?',
  idle: '○',
  sleeping: 'z',
  succeeded: '✓',
  failed: '✗',
  killed: '×',
}

const STATUS_COLOR: Record<string, string> = {
  spawning: 'blue',
  waiting: 'yellow',
  running: 'green',
  needs_input: 'magenta',
  idle: 'gray',
  sleeping: 'cyan',
  succeeded: 'green',
  failed: 'red',
  killed: 'gray',
}

interface TreeNode {
  session: SessionMetadata
  children: TreeNode[]
}

function buildTree(
  rootUuid: string,
  nodeMap: Map<string, SessionMetadata>,
  childrenMap: Map<string, string[]>,
): TreeNode | null {
  const session = nodeMap.get(rootUuid)
  if (!session) return null
  const childUuids = childrenMap.get(rootUuid) ?? []
  const children: TreeNode[] = []
  for (const cid of childUuids) {
    const child = buildTree(cid, nodeMap, childrenMap)
    if (child) children.push(child)
  }
  return { session, children }
}

function renderTree(node: TreeNode, prefix: string, isLast: boolean): string[] {
  const connector = isLast ? '└─ ' : '├─ '
  const s = node.session
  const statusChar = STATUS_CHAR[s.status] ?? '?'
  const label = `${s.id.slice(0, 8)} [${s.agentType}] ${statusChar} ${s.status}`
  const cost = s.costUsd != null ? ` $${s.costUsd.toFixed(4)}` : ''
  const line = `${prefix}${connector}${label}${cost}`
  const childPrefix = prefix + (isLast ? '   ' : '│  ')
  const lines: string[] = [line]
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!
    lines.push(...renderTree(child, childPrefix, i === node.children.length - 1))
  }
  return lines
}

export function DelegationGraph({ rootUuid, config, onBack }: Props) {
  const { data, error } = useApi<DelegationResponse>(
    `/api/delegation/${rootUuid}`,
    config,
    5000,
  )

  useInput(
    useCallback(
      (input, key) => {
        if (key.escape || input === 'q') onBack()
      },
      [onBack],
    ),
  )

  const nodeMap = new Map<string, SessionMetadata>()
  const childrenMap = new Map<string, string[]>()

  if (data) {
    for (const n of data.nodes) nodeMap.set(n.id, n)
    for (const e of data.edges) {
      const list = childrenMap.get(e.source) ?? []
      list.push(e.target)
      childrenMap.set(e.source, list)
    }
  }

  const tree = data ? buildTree(rootUuid, nodeMap, childrenMap) : null
  const rootSession = nodeMap.get(rootUuid)
  const treeLines: string[] = []

  if (tree) {
    const rootLabel = `${tree.session.id.slice(0, 8)} [${tree.session.agentType}] ${STATUS_CHAR[tree.session.status] ?? '?'} ${tree.session.status}`
    const rootCost = tree.session.costUsd != null ? ` $${tree.session.costUsd.toFixed(4)}` : ''
    treeLines.push(`◉ ${rootLabel}${rootCost}`)
    for (let i = 0; i < tree.children.length; i++) {
      const child = tree.children[i]!
      treeLines.push(...renderTree(child, '', i === tree.children.length - 1))
    }
  }

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">
          Delegation Tree
        </Text>
        <Text color="gray">  root={rootUuid.slice(0, 8)}…</Text>
        <Box flexGrow={1} />
        <Text color="gray">Esc/q back</Text>
      </Box>

      {error && (
        <Box paddingX={1}>
          <Text color="red">API error: {error}</Text>
        </Box>
      )}

      {!data && !error && (
        <Box paddingX={1}>
          <Text color="gray">Loading…</Text>
        </Box>
      )}

      {data && (
        <Box flexDirection="column" paddingX={1}>
          {/* Summary */}
          <Box marginBottom={1}>
            <Text color="gray">
              {data.nodes.length} node{data.nodes.length !== 1 ? 's' : ''}
              {'  '}
              {data.edges.length} edge{data.edges.length !== 1 ? 's' : ''}
              {rootSession && rootSession.costUsd != null
                ? `  total_cost=$${rootSession.costUsd.toFixed(4)}`
                : ''}
            </Text>
          </Box>

          {/* ASCII tree */}
          {treeLines.length === 0 && (
            <Text color="gray">No delegation data found for this session.</Text>
          )}
          {treeLines.map((line, i) => {
            // Colour the status marker inline (simple: highlight ✓/✗/▶)
            const isRoot = i === 0
            return (
              <Text key={i} color={isRoot ? 'white' : 'gray'} bold={isRoot}>
                {line}
              </Text>
            )
          })}

          {/* Legend */}
          <Box marginTop={1} flexDirection="column">
            <Text color="gray" dimColor>
              Legend:{'  '}
              {Object.entries(STATUS_CHAR)
                .map(([k, v]) => `${v}=${k}`)
                .join('  ')}
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  )
}
