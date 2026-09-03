import React, { useState, useCallback } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'
import { SessionRow } from '../components/SessionRow.js'
import { StatusBar } from '../components/StatusBar.js'
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
  const { stdout } = useStdout()
  const width = stdout?.columns ?? 80

  useInput(
    useCallback(
      (input, key) => {
        if (commandMode) return
        if (key.downArrow || input === 'j') {
          setCursor((c) => Math.min(c + 1, sessions.length - 1))
        } else if (key.upArrow || input === 'k') {
          setCursor((c) => Math.max(c - 1, 0))
        } else if (key.return) {
          const s = sessions[cursor]
          if (s) onOpen(s)
        } else if (input === 'K') {
          const s = sessions[cursor]
          if (!s) return
          apiDelete(`/api/sessions/${s.id}`, config)
            .then(() => onStatus(`Killed ${s.id.slice(0, 8)}`))
            .catch((e) => onStatus(String(e), true))
        } else if (input === 'n') {
          onNew()
        } else if (input === 'q') {
          onQuit()
        } else if (input === '/') {
          setCommandMode(true)
        }
      },
      [commandMode, cursor, sessions, config, onOpen, onNew, onQuit, onStatus, setCommandMode],
    ),
  )

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" height={10}>
        <Text color="gray">No sessions. Press n to spawn one.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text bold color="gray">
          {'  '}
          {'ID'.padEnd(10)}
          {'Name'.padEnd(22)}
          {'Status'.padEnd(12)}
          {'Cost'}
        </Text>
      </Box>
      {sessions.map((s, i) => (
        <SessionRow
          key={s.id}
          session={s}
          selected={i === cursor}
          width={width}
        />
      ))}
    </Box>
  )
}
