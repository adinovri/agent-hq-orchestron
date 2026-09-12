import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import type { ProjectMetadata } from '@agent-hq-orchestron/shared'
import type { ApiConfig } from '../hooks/useApi.js'
import { useApi, apiPost } from '../hooks/useApi.js'

interface Props {
  config: ApiConfig
  onDone: () => void
  onStatus: (msg: string, isError?: boolean) => void
}

type Step = 'pick-project' | 'enter-prompt' | 'submitting'

interface ProjectsResponse {
  projects: ProjectMetadata[]
}

export function SpawnScreen({ config, onDone, onStatus }: Props) {
  const [step, setStep] = useState<Step>('pick-project')
  const [cursor, setCursor] = useState(0)
  const [prompt, setPrompt] = useState('')

  const { data, error } = useApi<ProjectsResponse>('/api/projects', config, 10000)
  const projects = data?.projects ?? []

  const submit = useCallback(async () => {
    const project = projects[cursor]
    if (!project) return
    setStep('submitting')
    try {
      await apiPost('/api/sessions', { projectId: project.id, prompt: prompt || undefined }, config)
      onStatus(`Spawned session in project "${project.name}"`)
      onDone()
    } catch (e) {
      onStatus(String(e), true)
      setStep('enter-prompt')
    }
  }, [projects, cursor, prompt, config, onStatus, onDone])

  useInput(
    useCallback(
      (input, key) => {
        if (step === 'submitting') return
        if (step === 'pick-project') {
          if (key.escape) {
            onDone()
          } else if (key.downArrow || input === 'j') {
            setCursor((c) => Math.min(c + 1, projects.length - 1))
          } else if (key.upArrow || input === 'k') {
            setCursor((c) => Math.max(c - 1, 0))
          } else if (key.return) {
            if (projects.length > 0) setStep('enter-prompt')
          }
        } else if (step === 'enter-prompt') {
          if (key.escape) {
            setStep('pick-project')
          } else if (key.return) {
            submit()
          } else if (key.backspace || key.delete) {
            setPrompt((s) => s.slice(0, -1))
          } else if (input && !key.ctrl && !key.meta) {
            setPrompt((s) => s + input)
          }
        }
      },
      [step, projects.length, submit, onDone],
    ),
  )

  const selectedProject = projects[cursor]

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">Spawn Session</Text>
        <Box flexGrow={1} />
        <Text color="gray">Esc=cancel</Text>
      </Box>

      {error && (
        <Box paddingX={1}>
          <Text color="red">Failed to load projects: {error}</Text>
        </Box>
      )}

      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Text bold color="gray">Select project {step === 'pick-project' ? '← active' : ''}:</Text>
        {projects.length === 0 && !error && (
          <Text color="gray">Loading projects…</Text>
        )}
        {projects.map((p, i) => (
          <Box key={p.id}>
            <Text
              color={i === cursor ? 'white' : 'gray'}
              backgroundColor={i === cursor && step === 'pick-project' ? 'blue' : undefined}
            >
              {i === cursor ? '▶ ' : '  '}
              <Text bold={i === cursor}>{p.name}</Text>
              <Text color="gray">  {p.agentType}  {p.path.slice(-40)}</Text>
            </Text>
          </Box>
        ))}
      </Box>

      {step !== 'pick-project' && selectedProject && (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          <Text bold color="gray">
            Project: <Text color="cyan">{selectedProject.name}</Text>
            <Text color="gray">  ({selectedProject.agentType})</Text>
          </Text>
          <Box marginTop={1}>
            <Text bold color="gray">
              Initial prompt {step === 'enter-prompt' ? '← active (Enter to spawn)' : ''}:
            </Text>
          </Box>
          <Box borderStyle="round" paddingX={1} borderColor={step === 'enter-prompt' ? 'cyan' : 'gray'}>
            <Text color={prompt ? 'white' : 'gray'}>
              {prompt || '(empty — session will start in waiting state)'}
              {step === 'enter-prompt' ? '█' : ''}
            </Text>
          </Box>
        </Box>
      )}

      {step === 'submitting' && (
        <Box paddingX={1}>
          <Text color="yellow">Spawning session…</Text>
        </Box>
      )}

      <Box paddingX={1} marginTop={1}>
        <Text color="gray">
          {step === 'pick-project' && 'j/k to move, Enter to select project'}
          {step === 'enter-prompt' && 'Type prompt, Enter to spawn, Esc to go back'}
        </Text>
      </Box>
    </Box>
  )
}
