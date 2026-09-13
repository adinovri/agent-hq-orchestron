import React, { useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import type { ScheduleEntry } from '@agent-hq-orchestron/shared'
import { useApi } from '../hooks/useApi.js'
import type { ApiConfig } from '../hooks/useApi.js'
import { useState } from 'react'

interface Props {
  config: ApiConfig
  onBack: () => void
  onNew?: () => void
}

function nextFireLabel(cron: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const parser = require('cron-parser')
    const interval = parser.parseExpression(cron)
    const next = interval.next().toDate()
    return next.toLocaleString()
  } catch {
    return '—'
  }
}

export function SchedulesScreen({ config, onBack, onNew }: Props) {
  const [cursor, setCursor] = useState(0)

  const { data, error, loading } = useApi<{ schedules: ScheduleEntry[] }>('/api/schedules', config, 10000)
  const schedules = data?.schedules ?? []

  useInput(
    useCallback(
      (_input: string, key: import('ink').Key) => {
        if (key.downArrow || _input === 'j') {
          setCursor((c) => Math.min(c + 1, schedules.length - 1))
        } else if (key.upArrow || _input === 'k') {
          setCursor((c) => Math.max(c - 1, 0))
        } else if (_input === 'q' || key.escape) {
          onBack()
        } else if (_input === 'C' && onNew) {
          onNew()
        }
      },
      [schedules.length, onBack, onNew],
    ),
  )

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Schedules
        </Text>
        <Text color="gray">  q/Esc back  j/k nav  C=new schedule</Text>
      </Box>

      {loading && schedules.length === 0 && (
        <Box paddingX={1}><Text color="gray" dimColor>Loading schedules…</Text></Box>
      )}

      {error && <Text color="red">Error: {error}</Text>}

      {!error && schedules.length === 0 && (
        <Text color="gray">
          No schedules configured. Use `orchestron schedule create` from CLI.
        </Text>
      )}

      {schedules.length > 0 && (
        <Box flexDirection="column">
          <Box paddingX={1}>
            <Text bold color="gray">
              {'ID'.padEnd(10)}
              {'Cron'.padEnd(20)}
              {'Status'.padEnd(10)}
              {'Next Fire'}
            </Text>
          </Box>
          {schedules.map((s, i) => {
            const selected = i === cursor
            const status = s.enabled ? 'active' : 'paused'
            const statusColor = s.enabled ? 'green' : 'yellow'
            const nextFire = s.nextRunAt
              ? new Date(s.nextRunAt).toLocaleString()
              : nextFireLabel(s.cron)
            return (
              <Box key={s.id} paddingX={1} backgroundColor={selected ? 'blue' : undefined}>
                <Text color={selected ? 'white' : undefined}>
                  {s.id.slice(0, 8).padEnd(10)}
                </Text>
                <Text color={selected ? 'white' : 'cyan'}>{s.cron.padEnd(20)}</Text>
                <Text color={statusColor}>{status.padEnd(10)}</Text>
                <Text color={selected ? 'white' : 'gray'}>{nextFire}</Text>
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}
