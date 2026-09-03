import React, { useEffect, useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import EventSource from 'eventsource'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'
import type { ApiConfig } from '../hooks/useApi.js'
import { getHeaders } from '../hooks/useApi.js'

interface Props {
  session: SessionMetadata
  config: ApiConfig
  onBack: () => void
}

interface TranscriptLine {
  role: string
  content: string
}

export function SessionDetail({ session, config, onBack }: Props) {
  const [lines, setLines] = useState<TranscriptLine[]>([])
  const [scrollOffset, setScrollOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const url = `${config.baseUrl}/api/sessions/${session.id}/transcript`
    const es = new EventSource(url, {
      headers: getHeaders(config.token),
      withCredentials: false,
    } as ConstructorParameters<typeof EventSource>[1])

    es.addEventListener('message', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as { role?: string; content?: string }
        setLines((prev) => [
          ...prev,
          { role: data.role ?? 'system', content: data.content ?? String(e.data) },
        ])
      } catch {
        setLines((prev) => [...prev, { role: 'raw', content: String(e.data) }])
      }
    })

    es.addEventListener('error', () => {
      setError('SSE connection closed')
      es.close()
    })

    return () => es.close()
  }, [session.id, config.baseUrl, config.token])

  useInput(
    useCallback(
      (input, key) => {
        if (input === 'q' || key.escape) {
          onBack()
        } else if (key.downArrow || input === 'j') {
          setScrollOffset((s) => s + 1)
        } else if (key.upArrow || input === 'k') {
          setScrollOffset((s) => Math.max(0, s - 1))
        }
      },
      [onBack],
    ),
  )

  const visible = lines.slice(scrollOffset, scrollOffset + 20)

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1} marginBottom={1}>
        <Text bold>Session: </Text>
        <Text color="cyan">{session.id.slice(0, 8)}</Text>
        <Text color="gray">  {session.tmuxName}</Text>
        <Box flexGrow={1} />
        <Text color="gray">j/k scroll  q/Esc back</Text>
      </Box>

      {error && <Text color="red">{error}</Text>}

      <Box flexDirection="column" paddingX={1}>
        {visible.map((line, i) => (
          <Box key={i} flexDirection="row">
            <Text color={line.role === 'assistant' ? 'green' : 'blue'} bold>
              {(line.role + ':').padEnd(12)}
            </Text>
            <Text wrap="wrap">{line.content.slice(0, 200)}</Text>
          </Box>
        ))}
        {lines.length === 0 && !error && (
          <Text color="gray">Waiting for transcript events…</Text>
        )}
      </Box>

      <Box marginTop={1} paddingX={1}>
        <Text color="gray">
          Lines: {lines.length}  Scroll: {scrollOffset}
        </Text>
      </Box>
    </Box>
  )
}
