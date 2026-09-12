import React, { useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import type { ApiConfig } from '../hooks/useApi.js'
import { useApi } from '../hooks/useApi.js'

interface MetricsBucket {
  key: string
  sessions: number
  tokens: number
  cost_usd: number
  avg_duration_ms: number
}

interface MetricsResult {
  buckets: MetricsBucket[]
  total: {
    sessions: number
    tokens: number
    cost_usd: number
  }
}

interface Props {
  config: ApiConfig
  onBack: () => void
}

function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`
}

function fmtDur(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 60000)}m`
}

function row(cols: string[], widths: number[]): string {
  return cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ')
}

function hline(widths: number[]): string {
  return widths.map((w) => '─'.repeat(w)).join('──')
}

export function MetricsScreen({ config, onBack }: Props) {
  // Poll adapter breakdown + total
  const { data, error, reload } = useApi<MetricsResult>(
    '/api/metrics?groupBy=adapter',
    config,
    10000,
  )

  useInput(
    useCallback(
      (input, key) => {
        if (key.escape || input === 'q') onBack()
        else if (input === 'r') reload()
      },
      [onBack, reload],
    ),
  )

  const buckets = data?.buckets ?? []
  const total = data?.total

  const COL_WIDTHS = [20, 8, 12, 12, 12]
  const headers = ['Agent', 'Sessions', 'Cost (USD)', 'Tokens', 'Avg Dur']

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">
          Metrics
        </Text>
        <Box flexGrow={1} />
        <Text color="gray">Esc/q back  r refresh</Text>
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
          {/* Summary row */}
          {total && (
            <Box marginBottom={1}>
              <Text bold>Total: </Text>
              <Text color="green">{fmtCost(total.cost_usd)}</Text>
              <Text color="gray">  sessions={total.sessions}  tokens={total.tokens.toLocaleString()}</Text>
            </Box>
          )}

          {/* Table header */}
          <Text color="gray">{row(headers, COL_WIDTHS)}</Text>
          <Text color="gray">{hline(COL_WIDTHS)}</Text>

          {/* Per-agent rows */}
          {buckets.length === 0 && (
            <Text color="gray">No data yet.</Text>
          )}
          {buckets.map((b) => (
            <Text key={b.key}>
              {row(
                [
                  b.key,
                  String(b.sessions),
                  fmtCost(b.cost_usd),
                  b.tokens.toLocaleString(),
                  fmtDur(b.avg_duration_ms),
                ],
                COL_WIDTHS,
              )}
            </Text>
          ))}

          {buckets.length > 0 && (
            <>
              <Text color="gray">{hline(COL_WIDTHS)}</Text>
              {total && (
                <Text bold>
                  {row(
                    [
                      'TOTAL',
                      String(total.sessions),
                      fmtCost(total.cost_usd),
                      total.tokens.toLocaleString(),
                      '',
                    ],
                    COL_WIDTHS,
                  )}
                </Text>
              )}
            </>
          )}
        </Box>
      )}

      <Box paddingX={1} marginTop={1}>
        <Text color="gray" dimColor>
          Auto-refresh 10s · press r to force refresh
        </Text>
      </Box>
    </Box>
  )
}
