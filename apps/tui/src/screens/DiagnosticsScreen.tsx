import React, { useCallback } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'
import type { ApiConfig } from '../hooks/useApi.js'
import { useApi } from '../hooks/useApi.js'

// TODO: d/D keybind wiring from SessionDetail deferred to P1a merge.
// When P1a is ready, add `onDiag` / `onDelegation` props to SessionDetail
// and wire keybind 'd' → DiagnosticsScreen and 'D' → DelegationGraph.

interface RolloutEntry {
  seq: number
  timestamp: string
  kind: 'user' | 'assistant' | 'tool_use' | 'tool_result'
  toolName?: string
  content: string
}

interface TranscriptResponse {
  entries: RolloutEntry[]
  size: number
}

interface Props {
  uuid: string
  config: ApiConfig
  onBack: () => void
}

const KIND_COLOR: Record<string, string> = {
  user: 'cyan',
  assistant: 'green',
  tool_use: 'yellow',
  tool_result: 'gray',
}

const KIND_LABEL: Record<string, string> = {
  user: 'USR',
  assistant: 'AST',
  tool_use: 'TUL',
  tool_result: 'TRS',
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

export function DiagnosticsScreen({ uuid, config, onBack }: Props) {
  const { stdout } = useStdout()
  const width = stdout?.columns ?? 80

  const { data: session, error: sessionErr } = useApi<SessionMetadata>(
    `/api/sessions/${uuid}`,
    config,
    5000,
  )

  const { data: transcript, error: transcriptErr } = useApi<TranscriptResponse>(
    `/api/sessions/${uuid}/transcript`,
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

  const entries = transcript?.entries ?? []
  const contentWidth = Math.max(40, width - 16)

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">
          Diagnostics
        </Text>
        <Text color="gray">  {uuid.slice(0, 8)}…</Text>
        <Box flexGrow={1} />
        <Text color="gray">Esc/q back</Text>
      </Box>

      {(sessionErr || transcriptErr) && (
        <Box paddingX={1}>
          <Text color="red">
            {sessionErr ? `Session error: ${sessionErr}` : `Transcript error: ${transcriptErr}`}
          </Text>
        </Box>
      )}

      {/* Session info block */}
      {session && (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          <Box>
            <Text bold>Status: </Text>
            <Text color={session.status === 'running' ? 'green' : 'gray'}>{session.status}</Text>
            <Text color="gray">  agent={session.agentType}  model={session.model ?? '—'}</Text>
          </Box>
          {session.parentSessionId && (
            <Box>
              <Text bold>Parent: </Text>
              <Text color="cyan">{session.parentSessionId.slice(0, 8)}…</Text>
            </Box>
          )}
          <Box>
            <Text bold>Cost: </Text>
            <Text color="green">
              {session.costUsd != null ? `$${session.costUsd.toFixed(4)}` : '—'}
            </Text>
            {session.tokenUsage && (
              <Text color="gray">
                {'  '}in={session.tokenUsage.input.toLocaleString()}
                {'  '}out={session.tokenUsage.output.toLocaleString()}
                {session.tokenUsage.cacheRead ? `  cache_read=${session.tokenUsage.cacheRead.toLocaleString()}` : ''}
              </Text>
            )}
          </Box>
          <Box>
            <Text bold>Started: </Text>
            <Text color="gray">{session.startedAt.slice(0, 19).replace('T', ' ')}</Text>
            {session.endedAt && (
              <Text color="gray">  ended={session.endedAt.slice(0, 19).replace('T', ' ')}</Text>
            )}
          </Box>
        </Box>
      )}

      {/* Transcript */}
      <Box paddingX={1} marginBottom={0}>
        <Text bold color="gray">
          Transcript ({entries.length} entries)
        </Text>
      </Box>
      <Box paddingX={1} flexDirection="column">
        {!transcript && !transcriptErr && <Text color="gray">Loading…</Text>}
        {entries.length === 0 && transcript && (
          <Text color="gray">No entries yet.</Text>
        )}
        {entries.slice(-40).map((e) => (
          <Box key={e.seq}>
            <Text color="gray">{e.timestamp.slice(11, 19)} </Text>
            <Text
              color={KIND_COLOR[e.kind] ?? 'white'}
              bold={e.kind === 'user' || e.kind === 'assistant'}
            >
              {KIND_LABEL[e.kind] ?? e.kind}
            </Text>
            {e.toolName && <Text color="yellow">  [{e.toolName}]</Text>}
            <Text color="gray">  {truncate(e.content, contentWidth)}</Text>
          </Box>
        ))}
        {entries.length > 40 && (
          <Text color="gray" dimColor>
            … showing last 40 of {entries.length} entries
          </Text>
        )}
      </Box>
    </Box>
  )
}
