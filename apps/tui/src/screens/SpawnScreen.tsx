import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import type { ProjectMetadata } from '@agent-hq-orchestron/shared'
import type { ApiConfig } from '../hooks/useApi.js'
import { useApi, apiPost } from '../hooks/useApi.js'
import { LoadingSkeleton } from '../components/LoadingSkeleton.js'

interface Props {
  config: ApiConfig
  onDone: () => void
  onStatus: (msg: string, isError?: boolean) => void
}

type Step = 'pick-project' | 'pick-model' | 'pick-effort' | 'pick-mode' | 'pick-tmux' | 'enter-prompt' | 'submitting'

interface ProjectsResponse {
  projects: ProjectMetadata[]
}

const MODELS = [
  { label: '— project default —', value: '' },
  { label: 'claude-opus-5-5', value: 'claude-opus-5-5' },
  { label: 'claude-opus-5', value: 'claude-opus-5' },
  { label: 'claude-sonnet-5', value: 'claude-sonnet-5' },
  { label: 'claude-fable-5-1', value: 'claude-fable-5-1' },
  { label: 'claude-opus-4-8', value: 'claude-opus-4-8-20250514' },
  { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6-20250514' },
  { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5-20251001' },
]

const EFFORTS = [
  { label: '— project default —', value: '' },
  { label: 'low', value: 'low' },
  { label: 'medium', value: 'medium' },
  { label: 'high', value: 'high' },
  { label: 'xhigh', value: 'xhigh' },
  { label: 'max', value: 'max' },
]

const STEPS: Step[] = ['pick-project', 'pick-model', 'pick-effort', 'pick-mode', 'pick-tmux', 'enter-prompt']

function stepLabel(step: Step): string {
  switch (step) {
    case 'pick-project': return '1/6  Project'
    case 'pick-model': return '2/6  Model'
    case 'pick-effort': return '3/6  Effort'
    case 'pick-mode': return '4/6  Mode'
    case 'pick-tmux': return '5/6  Run mode'
    case 'enter-prompt': return '6/6  Prompt'
    default: return ''
  }
}

export function SpawnScreen({ config, onDone, onStatus }: Props) {
  const [step, setStep] = useState<Step>('pick-project')
  const [projectCursor, setProjectCursor] = useState(0)
  const [modelCursor, setModelCursor] = useState(0)
  const [effortCursor, setEffortCursor] = useState(0)
  const [modeCursor, setModeCursor] = useState(0) // 0=block, 1=edit-at-idle, 2=headless
  const [tmuxCursor, setTmuxCursor] = useState(0) // 0=tmux, 1=headless
  const [prompt, setPrompt] = useState('')

  const { data, error, loading } = useApi<ProjectsResponse>('/api/projects', config, 30000)
  const projects = data?.projects ?? []

  const goBack = useCallback(() => {
    const idx = STEPS.indexOf(step)
    if (idx > 0) setStep(STEPS[idx - 1])
    else onDone()
  }, [step, onDone])

  const goNext = useCallback(() => {
    const idx = STEPS.indexOf(step)
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1])
  }, [step])

  const submit = useCallback(async () => {
    const project = projects[projectCursor]
    if (!project) return
    setStep('submitting')

    const body: Record<string, unknown> = { projectId: project.id }
    if (prompt.trim()) body.prompt = prompt.trim()
    const model = MODELS[modelCursor].value
    if (model) body.model = model
    const effort = EFFORTS[effortCursor].value
    if (effort) body.effort = effort

    // mode: 0=block, 1=edit-at-idle, 2=headless → maps to headless flag
    if (modeCursor === 2 || tmuxCursor === 1) body.useTmux = false

    try {
      await apiPost('/api/sessions', body, config)
      onStatus(`Spawned session in "${project.name}"`)
      onDone()
    } catch (e) {
      onStatus(String(e), true)
      setStep('enter-prompt')
    }
  }, [projects, projectCursor, modelCursor, effortCursor, modeCursor, tmuxCursor, prompt, config, onStatus, onDone])

  useInput(
    useCallback(
      (input, key) => {
        if (step === 'submitting') return

        if (key.escape) {
          goBack()
          return
        }

        if (step === 'pick-project') {
          if (key.downArrow || input === 'j') setProjectCursor((c) => Math.min(c + 1, projects.length - 1))
          else if (key.upArrow || input === 'k') setProjectCursor((c) => Math.max(c - 1, 0))
          else if (key.return && projects.length > 0) goNext()
        } else if (step === 'pick-model') {
          if (key.downArrow || input === 'j') setModelCursor((c) => Math.min(c + 1, MODELS.length - 1))
          else if (key.upArrow || input === 'k') setModelCursor((c) => Math.max(c - 1, 0))
          else if (key.return) goNext()
        } else if (step === 'pick-effort') {
          if (key.downArrow || input === 'j') setEffortCursor((c) => Math.min(c + 1, EFFORTS.length - 1))
          else if (key.upArrow || input === 'k') setEffortCursor((c) => Math.max(c - 1, 0))
          else if (key.return) goNext()
        } else if (step === 'pick-mode') {
          const modeCount = 3
          if (key.downArrow || input === 'j') setModeCursor((c) => Math.min(c + 1, modeCount - 1))
          else if (key.upArrow || input === 'k') setModeCursor((c) => Math.max(c - 1, 0))
          else if (key.return) goNext()
        } else if (step === 'pick-tmux') {
          if (key.downArrow || input === 'j') setTmuxCursor((c) => Math.min(c + 1, 1))
          else if (key.upArrow || input === 'k') setTmuxCursor((c) => Math.max(c - 1, 0))
          else if (key.return) goNext()
        } else if (step === 'enter-prompt') {
          if (key.return && !key.shift) {
            submit()
          } else if (key.backspace || key.delete) {
            setPrompt((s) => s.slice(0, -1))
          } else if (input && !key.ctrl && !key.meta) {
            setPrompt((s) => s + input)
          }
        }
      },
      [step, projects.length, goBack, goNext, submit],
    ),
  )

  const selectedProject = projects[projectCursor]
  const stepIdx = STEPS.indexOf(step)

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">Spawn Session</Text>
        <Text color="gray">  {step !== 'submitting' ? stepLabel(step) : 'Spawning…'}</Text>
        <Box flexGrow={1} />
        <Text color="gray">Esc=back</Text>
      </Box>

      {/* Step progress bar */}
      {step !== 'submitting' && (
        <Box paddingX={1} marginBottom={1}>
          {STEPS.map((s, i) => (
            <Text key={s} color={i < stepIdx ? 'green' : i === stepIdx ? 'cyan' : 'gray'}>
              {i < stepIdx ? '●' : i === stepIdx ? '▶' : '○'}
              {i < STEPS.length - 1 ? '─' : ''}
            </Text>
          ))}
          <Text color="gray">  j/k=move  Enter=next  Esc=back</Text>
        </Box>
      )}

      {error && <Box paddingX={1}><Text color="red">Failed to load projects: {error}</Text></Box>}

      {/* Step: pick-project */}
      {step === 'pick-project' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="gray">Select project:</Text>
          {loading && <LoadingSkeleton rows={3} label="Loading projects…" />}
          {projects.map((p, i) => (
            <Box key={p.id}>
              <Text
                color={i === projectCursor ? 'white' : 'gray'}
                backgroundColor={i === projectCursor ? 'blue' : undefined}
              >
                {i === projectCursor ? '▶ ' : '  '}
                <Text bold={i === projectCursor}>{p.name}</Text>
                <Text color="gray">  {p.agentType}  {p.path.slice(-40)}</Text>
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Step: pick-model */}
      {step === 'pick-model' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="gray">Model {selectedProject?.defaultModel ? `(project default: ${selectedProject.defaultModel})` : ''}:</Text>
          {MODELS.map((m, i) => (
            <Text key={m.value} color={i === modelCursor ? 'cyan' : 'gray'} dimColor={i !== modelCursor}>
              {i === modelCursor ? '▶ ' : '  '}{m.label}
            </Text>
          ))}
        </Box>
      )}

      {/* Step: pick-effort */}
      {step === 'pick-effort' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="gray">Effort {selectedProject?.defaultEffort ? `(project default: ${selectedProject.defaultEffort})` : ''}:</Text>
          {EFFORTS.map((e, i) => (
            <Text key={e.value} color={i === effortCursor ? 'cyan' : 'gray'} dimColor={i !== effortCursor}>
              {i === effortCursor ? '▶ ' : '  '}{e.label}
            </Text>
          ))}
        </Box>
      )}

      {/* Step: pick-mode */}
      {step === 'pick-mode' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="gray">Run mode:</Text>
          {[
            { label: 'block-mode', desc: 'Claude blocks + waits for approvals (default)' },
            { label: 'edit-at-idle', desc: 'Allow edits only when session is idle' },
            { label: 'headless', desc: 'Non-interactive one-shot (-p flag)' },
          ].map((m, i) => (
            <Box key={m.label} flexDirection="row">
              <Text color={i === modeCursor ? 'cyan' : 'gray'}>
                {i === modeCursor ? '▶ ' : '  '}{m.label.padEnd(16)}
              </Text>
              <Text color="gray" dimColor>{m.desc}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Step: pick-tmux */}
      {step === 'pick-tmux' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="gray">Session supervisor:</Text>
          {[
            { label: 'tmux (interactive)', desc: 'Full TUI + live transcript + send input' },
            { label: 'headless (-p flag)', desc: 'Background subprocess, no tmux' },
          ].map((m, i) => (
            <Box key={m.label} flexDirection="row">
              <Text color={i === tmuxCursor ? 'cyan' : 'gray'}>
                {i === tmuxCursor ? '▶ ' : '  '}{m.label.padEnd(28)}
              </Text>
              <Text color="gray" dimColor>{m.desc}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Step: enter-prompt */}
      {step === 'enter-prompt' && (
        <Box flexDirection="column" paddingX={1}>
          {selectedProject && (
            <Box marginBottom={1} flexDirection="column">
              <Text color="gray">Project: <Text color="cyan">{selectedProject.name}</Text></Text>
              {MODELS[modelCursor].value && <Text color="gray">Model: <Text color="cyan">{MODELS[modelCursor].label}</Text></Text>}
              {EFFORTS[effortCursor].value && <Text color="gray">Effort: <Text color="cyan">{EFFORTS[effortCursor].label}</Text></Text>}
            </Box>
          )}
          <Text bold color="gray">Initial prompt (Enter to spawn, Esc=back):</Text>
          <Box borderStyle="round" paddingX={1} borderColor="cyan" marginTop={1}>
            <Text color={prompt ? 'white' : 'gray'}>
              {prompt || '(empty — session starts waiting)'}█
            </Text>
          </Box>
        </Box>
      )}

      {step === 'submitting' && (
        <Box paddingX={1}>
          <Text color="yellow">Spawning session…</Text>
        </Box>
      )}
    </Box>
  )
}
