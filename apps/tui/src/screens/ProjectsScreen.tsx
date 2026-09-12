import React, { useCallback, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import type { ProjectMetadata } from '@agent-hq-orchestron/shared'
import { useApi } from '../hooks/useApi.js'
import type { ApiConfig } from '../hooks/useApi.js'

interface Props {
  config: ApiConfig
  onBack: () => void
}

function mcpCount(project: ProjectMetadata): number {
  const cfg = project.config as Record<string, unknown>
  const mcp =
    (cfg['mcpServers'] as Record<string, unknown> | undefined) ??
    (cfg['mcp_servers'] as Record<string, unknown> | undefined)
  return mcp ? Object.keys(mcp).length : 0
}

export function ProjectsScreen({ config, onBack }: Props) {
  const [cursor, setCursor] = useState(0)
  const [showDetail, setShowDetail] = useState(false)

  const { data, error } = useApi<{ projects: ProjectMetadata[] }>('/api/projects', config, 10000)
  const projects = data?.projects ?? []

  useInput(
    useCallback(
      (input: string, key: import('ink').Key) => {
        if (showDetail) {
          if (input === 'q' || key.escape) setShowDetail(false)
          return
        }
        if (key.downArrow || input === 'j') {
          setCursor((c) => Math.min(c + 1, projects.length - 1))
        } else if (key.upArrow || input === 'k') {
          setCursor((c) => Math.max(c - 1, 0))
        } else if (key.return) {
          if (projects[cursor]) setShowDetail(true)
        } else if (input === 'q' || key.escape) {
          onBack()
        }
      },
      [showDetail, projects, cursor, onBack],
    ),
  )

  const selected = projects[cursor]

  if (showDetail && selected) {
    const cfg = selected.config as Record<string, unknown>
    const mcp =
      (cfg['mcpServers'] as Record<string, unknown> | undefined) ??
      (cfg['mcp_servers'] as Record<string, unknown> | undefined)
    const mcpKeys = mcp ? Object.keys(mcp) : []

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            {selected.name ?? selected.id}
          </Text>
          <Text color="gray">  q/Esc back</Text>
        </Box>
        <Text color="gray">Path: {selected.path}</Text>
        <Text color="gray">Model: {selected.defaultModel ?? '(project default)'}</Text>
        <Text color="gray">Effort: {selected.defaultEffort ?? '(project default)'}</Text>
        {mcpKeys.length === 0 ? (
          <Text color="gray">MCP: no servers configured</Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>MCP Servers ({mcpKeys.length}):</Text>
            {mcpKeys.map((k) => {
              const srv = (mcp as Record<string, unknown>)[k] as Record<string, unknown>
              return (
                <Box key={k} flexDirection="column" marginLeft={2} marginTop={1}>
                  <Text bold color="cyan">{k}</Text>
                  <Text color="gray">{JSON.stringify(srv, null, 2)}</Text>
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Projects
        </Text>
        <Text color="gray">  q/Esc back  j/k nav  Enter view MCP</Text>
      </Box>

      {error && <Text color="red">Error: {error}</Text>}

      {!error && projects.length === 0 && (
        <Text color="gray">No projects configured.</Text>
      )}

      {projects.length > 0 && (
        <Box flexDirection="column">
          <Box paddingX={1}>
            <Text bold color="gray">
              {'ID'.padEnd(10)}
              {'Name'.padEnd(24)}
              {'MCP Servers'.padEnd(14)}
              {'Path'}
            </Text>
          </Box>
          {projects.map((p, i) => {
            const sel = i === cursor
            const name = (p.name ?? p.id).slice(0, 22)
            const path = p.path.slice(0, 40)
            return (
              <Box key={p.id} paddingX={1} backgroundColor={sel ? 'blue' : undefined}>
                <Text color={sel ? 'white' : undefined}>{p.id.slice(0, 8).padEnd(10)}</Text>
                <Text color={sel ? 'white' : 'cyan'}>{name.padEnd(24)}</Text>
                <Text color={sel ? 'white' : 'yellow'}>{String(mcpCount(p)).padEnd(14)}</Text>
                <Text color={sel ? 'white' : 'gray'}>{path}</Text>
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}
