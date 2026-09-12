import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'
import type { ApiConfig } from '../hooks/useApi.js'
import { useApi, apiPost, apiDelete } from '../hooks/useApi.js'

interface Props {
  session: SessionMetadata
  config: ApiConfig
  onBack: () => void
  onStatus: (msg: string, isError?: boolean) => void
}

interface TranscriptEntry {
  seq: number
  timestamp: string
  kind: 'user' | 'assistant' | 'tool_use' | 'tool_result'
  toolName?: string
  content: string
}

interface TranscriptResponse {
  entries: TranscriptEntry[]
  size: number
}

type ConfirmAction = 'reopen' | 'fork' | 'respawn' | 'archive' | 'kill' | null

const KIND_COLOR: Record<string, string> = {
  user: 'cyan',
  assistant: 'green',
  tool_use: 'yellow',
  tool_result: 'gray',
}

const KIND_LABEL: Record<string, string> = {
  user: 'user',
  assistant: 'assistant',
  tool_use: 'tool',
  tool_result: 'result',
}

export function SessionDetail({ session, config, onBack, onStatus }: Props) {
  const [scrollOffset, setScrollOffset] = useState(0)
  const [confirm, setConfirm] = useState<ConfirmAction>(null)
  const [busy, setBusy] = useState(false)

  const transcriptUrl = `/api/sessions/${session.id}/transcript`
  const { data, error } = useApi<TranscriptResponse>(transcriptUrl, config, 3000)

  const entries = data?.entries ?? []
  const VISIBLE = 20

  const scrollDown = useCallback(() => {
    setScrollOffset((s) => Math.min(s + 1, Math.max(0, entries.length - VISIBLE)))
  }, [entries.length])

  const scrollUp = useCallback(() => {
    setScrollOffset((s) => Math.max(0, s - 1))
  }, [])

  const doAction = useCallback(
    async (action: ConfirmAction) => {
      if (!action || busy) return
      setBusy(true)
      setConfirm(null)
      try {
        if (action === 'kill') {
          await apiDelete(`/api/sessions/${session.id}`, config)
          onStatus(`Killed ${session.id.slice(0, 8)}`)
        } else if (action === 'archive') {
          await apiPost(`/api/sessions/${session.id}/archive`, {}, config)
          onStatus(`Archived ${session.id.slice(0, 8)}`)
        } else if (action === 'reopen') {
          await apiPost(`/api/sessions/${session.id}/reopen`, {}, config)
          onStatus(`Reopened ${session.id.slice(0, 8)}`)
        } else if (action === 'respawn') {
          await apiPost(`/api/sessions/${session.id}/respawn`, {}, config)
          onStatus(`Respawned ${session.id.slice(0, 8)}`)
        } else if (action === 'fork') {
          await apiPost(`/api/sessions/${session.id}/clone`, {}, config)
          onStatus(`Forked ${session.id.slice(0, 8)} — new session spawned`)
        }
        onBack()
      } catch (e) {
        onStatus(String(e), true)
      } finally {
        setBusy(false)
      }
    },
    [busy, session.id, config, onStatus, onBack],
  )

  useInput(
    useCallback(
      (input, key) => {
        if (busy) return
        if (confirm !== null) {
          if (input === 'y' || key.return) {
            doAction(confirm)
          } else {
            setConfirm(null)
            onStatus('Action cancelled')
          }
          return
        }
        if (input === 'q' || key.escape) {
          onBack()
        } else if (key.downArrow || input === 'j') {
          scrollDown()
        } else if (key.upArrow || input === 'k') {
          scrollUp()
        } else if (input === 'r') {
          setConfirm('reopen')
        } else if (input === 'f') {
          setConfirm('fork')
        } else if (input === 'R') {
          setConfirm('respawn')
        } else if (input === 'a') {
          setConfirm('archive')
        } else if (input === 'K') {
          setConfirm('kill')
        }
      },
      [busy, confirm, onBack, scrollDown, scrollUp, doAction, onStatus],
    ),
  )

  const visible = entries.slice(scrollOffset, scrollOffset + VISIBLE)

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1} marginBottom={1}>
        <Text bold>Session: </Text>
        <Text color="cyan">{session.id.slice(0, 8)}</Text>
        <Text color="gray">  {session.tmuxName}  </Text>
        <Text color={session.status === 'running' ? 'green' : 'gray'}>{session.status}</Text>
        <Box flexGrow={1} />
        <Text color="gray">j/k r=reopen f=fork R=respawn a=archive K=kill q=back</Text>
      </Box>

      {error && <Box paddingX={1}><Text color="red">Error: {error}</Text></Box>}

      {confirm && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} marginX={1} marginBottom={1}>
          <Text color="yellow">Confirm {confirm.toUpperCase()} for {session.id.slice(0, 8)}? </Text>
          <Text color="white">Press y/Enter to confirm, any other key cancels</Text>
        </Box>
      )}

      <Box flexDirection="column" paddingX={1}>
        {visible.map((entry) => (
          <Box key={entry.seq} flexDirection="row" marginBottom={0}>
            <Text color={KIND_COLOR[entry.kind] ?? 'white'} bold>
              {(entry.toolName ? `${KIND_LABEL[entry.kind]}:${entry.toolName}` : KIND_LABEL[entry.kind]).slice(0, 20).padEnd(20)}
            </Text>
            <Box flexGrow={1}>
              <Text wrap="wrap">{entry.content.slice(0, 160)}</Text>
            </Box>
          </Box>
        ))}
        {entries.length === 0 && !error && (
          <Text color="gray">No transcript yet — session may still be spawning…</Text>
        )}
      </Box>

      <Box marginTop={1} paddingX={1}>
        <Text color="gray">
          Entries: {entries.length}  Scroll: {scrollOffset}/{Math.max(0, entries.length - VISIBLE)}
          {data?.size != null ? `  Size: ${(data.size / 1024).toFixed(1)}KB` : ''}
          {busy ? '  [working…]' : ''}
        </Text>
      </Box>
    </Box>
  )
}
