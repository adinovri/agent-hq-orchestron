import React, { useState, useCallback, useMemo } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'
import { SessionRow } from '../components/SessionRow.js'
import { apiDelete } from '../hooks/useApi.js'
import type { ApiConfig } from '../hooks/useApi.js'

interface Props {
  sessions: SessionMetadata[]
  config: ApiConfig
  onOpen: (session: SessionMetadata) => void
  onNew: () => void
  onQuit: () => void
  onStatus: (msg: string, isError?: boolean) => void
  commandMode: boolean
  setCommandMode: (v: boolean) => void
}

type GroupKey = 'running' | 'needs_input' | 'active' | 'terminal'

const GROUP_ORDER: GroupKey[] = ['running', 'needs_input', 'active', 'terminal']
const GROUP_LABEL: Record<GroupKey, string> = {
  running: 'Running',
  needs_input: 'Needs Input',
  active: 'Active',
  terminal: 'Terminal',
}
const GROUP_COLOR: Record<GroupKey, string> = {
  running: 'green',
  needs_input: 'magenta',
  active: 'gray',
  terminal: 'gray',
}

function statusToGroup(status: string): GroupKey {
  if (status === 'running') return 'running'
  if (status === 'needs_input') return 'needs_input'
  if (status === 'succeeded' || status === 'failed' || status === 'killed') return 'terminal'
  return 'active'
}

function sortByActivity(a: SessionMetadata, b: SessionMetadata): number {
  const ta = a.lastActivityAt ?? a.endedAt ?? a.startedAt
  const tb = b.lastActivityAt ?? b.endedAt ?? b.startedAt
  return tb < ta ? -1 : tb > ta ? 1 : 0
}

function matchesFilter(s: SessionMetadata, q: string): boolean {
  if (!q) return true
  const lower = q.toLowerCase()
  return (
    s.tmuxName.toLowerCase().includes(lower) ||
    s.status.toLowerCase().includes(lower) ||
    s.projectId.toLowerCase().includes(lower) ||
    (s.agentType as string).toLowerCase().includes(lower)
  )
}

export function Dashboard({
  sessions,
  config,
  onOpen,
  onNew,
  onQuit,
  onStatus,
  commandMode,
  setCommandMode,
}: Props) {
  const [cursor, setCursor] = useState(0)
  const [filterMode, setFilterMode] = useState(false)
  const [filterQuery, setFilterQuery] = useState('')
  const [grouped, setGrouped] = useState(false)
  const { stdout } = useStdout()
  const width = stdout?.columns ?? 80

  const needsInputCount = useMemo(
    () => sessions.filter((s) => s.status === 'needs_input').length,
    [sessions],
  )

  const filtered = useMemo(() => {
    const base = [...sessions].sort(sortByActivity)
    return base.filter((s) => matchesFilter(s, filterQuery))
  }, [sessions, filterQuery])

  const displayList = useMemo<Array<SessionMetadata | { __group: GroupKey }>>(() => {
    if (!grouped) return filtered
    const byGroup: Record<GroupKey, SessionMetadata[]> = {
      running: [],
      needs_input: [],
      active: [],
      terminal: [],
    }
    for (const s of filtered) byGroup[statusToGroup(s.status)].push(s)
    const result: Array<SessionMetadata | { __group: GroupKey }> = []
    for (const g of GROUP_ORDER) {
      if (byGroup[g].length === 0) continue
      result.push({ __group: g })
      for (const s of byGroup[g]) result.push(s)
    }
    return result
  }, [filtered, grouped])

  // flat sessions only (for cursor bounds)
  const sessionItems = displayList.filter((x): x is SessionMetadata => !('__group' in x))

  useInput(
    useCallback(
      (input, key) => {
        // Filter mode input handling
        if (filterMode) {
          if (key.escape) {
            setFilterMode(false)
            setFilterQuery('')
            setCursor(0)
          } else if (key.return) {
            setFilterMode(false)
          } else if (key.backspace || key.delete) {
            setFilterQuery((q) => q.slice(0, -1))
          } else if (input && !key.ctrl && !key.meta) {
            setFilterQuery((q) => q + input)
          }
          return
        }

        if (commandMode) return

        if (key.downArrow || input === 'j') {
          setCursor((c) => Math.min(c + 1, sessionItems.length - 1))
        } else if (key.upArrow || input === 'k') {
          setCursor((c) => Math.max(c - 1, 0))
        } else if (key.return) {
          const s = sessionItems[cursor]
          if (s) onOpen(s)
        } else if (input === 'K') {
          const s = sessionItems[cursor]
          if (!s) return
          apiDelete(`/api/sessions/${s.id}`, config)
            .then(() => onStatus(`Killed ${s.id.slice(0, 8)}`))
            .catch((e) => onStatus(String(e), true))
        } else if (input === 'n') {
          onNew()
        } else if (input === 'q') {
          onQuit()
        } else if (input === '/') {
          setFilterMode(true)
        } else if (input === 'g') {
          setGrouped((v) => !v)
        }
      },
      [filterMode, commandMode, cursor, sessionItems, config, onOpen, onNew, onQuit, onStatus],
    ),
  )

  return (
    <Box flexDirection="column">
      {/* Stat chip bar */}
      <Box paddingX={1} marginBottom={0}>
        <Text color="gray">Sessions: </Text>
        <Text color="white" bold>
          {sessions.length}
        </Text>
        {needsInputCount > 0 && (
          <>
            <Text color="gray">  </Text>
            <Text backgroundColor="magenta" color="white" bold>
              {' '}
              {needsInputCount} needs input{' '}
            </Text>
          </>
        )}
        <Text color="gray">  </Text>
        <Text color="gray">[/] filter  [g] {grouped ? 'flat' : 'group'}  [n] spawn  [q] quit</Text>
      </Box>

      {/* Filter bar */}
      {filterMode && (
        <Box paddingX={1} marginBottom={0}>
          <Text color="yellow" bold>
            Filter:{' '}
          </Text>
          <Text color="white">{filterQuery}</Text>
          <Text color="gray">▌</Text>
          <Text color="gray">  Esc=clear  Enter=apply</Text>
        </Box>
      )}
      {!filterMode && filterQuery && (
        <Box paddingX={1} marginBottom={0}>
          <Text color="yellow">Filter: </Text>
          <Text color="cyan">{filterQuery}</Text>
          <Text color="gray">  ({filtered.length}/{sessions.length})  [/] edit</Text>
        </Box>
      )}

      {/* Column header */}
      <Box paddingX={1}>
        <Text bold color="gray">
          {'  '}
          {'ID'.padEnd(10)}
          {'Name'.padEnd(22)}
          {'Status'.padEnd(12)}
          {'Cost'}
        </Text>
      </Box>

      {/* Session list */}
      {displayList.length === 0 && (
        <Box paddingX={2}>
          <Text color="gray">
            {sessions.length === 0
              ? 'No sessions. Press n to spawn one.'
              : 'No sessions match filter.'}
          </Text>
        </Box>
      )}

      {displayList.map((item, i) => {
        if ('__group' in item) {
          const g = item.__group
          return (
            <Box key={`group-${g}`} paddingX={1} marginTop={0}>
              <Text color={GROUP_COLOR[g]} bold>
                ── {GROUP_LABEL[g]} ──
              </Text>
            </Box>
          )
        }
        const sessionIndex = sessionItems.indexOf(item)
        return (
          <SessionRow
            key={item.id}
            session={item}
            selected={sessionIndex === cursor}
            width={width}
          />
        )
      })}
    </Box>
  )
}
