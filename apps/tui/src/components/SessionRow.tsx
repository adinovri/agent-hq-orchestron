import React from 'react'
import { Box, Text } from 'ink'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'

const STATUS_COLOR: Record<string, string> = {
  spawning: 'yellow',
  waiting: 'yellow',
  running: 'green',
  needs_input: 'magenta',
  idle: 'white',
  sleeping: 'gray',
  succeeded: 'blue',
  failed: 'red',
  killed: 'gray',
}

interface Props {
  session: SessionMetadata
  selected: boolean
  width: number
}

export function SessionRow({ session, selected, width }: Props) {
  const color = STATUS_COLOR[session.status] ?? 'white'
  const id = session.id.slice(0, 8)
  const name = session.tmuxName.slice(0, 20).padEnd(20)
  const status = session.status.padEnd(10)
  const cost = session.costUsd != null ? `$${session.costUsd.toFixed(4)}` : '—'

  return (
    <Box width={width}>
      <Text backgroundColor={selected ? 'blue' : undefined} color={selected ? 'white' : undefined}>
        {selected ? '▶ ' : '  '}
        <Text color="gray">{id}</Text>
        {'  '}
        <Text>{name}</Text>
        {'  '}
        <Text color={color}>{status}</Text>
        {'  '}
        <Text color="cyan">{cost}</Text>
      </Text>
    </Box>
  )
}
