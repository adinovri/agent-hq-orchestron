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

type Step = 'pick-project' | 'enter-cron' | 'pick-model' | 'pick-effort' | 'pick-tmux' | 'enter-prompt' | 'confirm' | 'submitting'

const STEPS: Step[] = ['pick-project', 'enter-cron', 'pick-model', 'pick-effort', 'pick-tmux', 'enter-prompt', 'confirm']

const CRON_PRESETS = [
  { label: 'Every 5 min', value: '*/5 * * * *' },
  { label: 'Every 15 min', value: '*/15 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every day 9am', value: '0 9 * * *' },
  { label: 'Every weekday 9am', value: '0 9 * * 1-5' },
  { label: 'Every Sunday midnight', value: '0 0 * * 0' },
  { label: 'Custom', value: '' },
]

const MODELS = [
  { label: '— project default —', value: '' },
  { label: 'claude-opus-5', value: 'claude-opus-5' },
  { label: 'claude-sonnet-5', value: 'claude-sonnet-5' },
  { label: 'claude-fable-5-1', value: 'claude-fable-5-1' },
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

interface ProjectsResponse {
  projects: ProjectMetadata[]
}

function nextFirePreview(cron: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const parser = require('cron-parser')
    const interval = parser.parseExpression(cron)
    const next1 = interval.next().toDate()
    const next2 = interval.next().toDate()
    return `${next1.toLocaleString()}  →  ${next2.toLocaleString()}`
  } catch {
    return '(invalid cron expression)'
  }
}

export function ScheduleWizard({ config, onDone, onStatus }: Props) {
  const [step, setStep] = useState<Step>('pick-project')
  const [projectCursor, setCursor] = useState(0)
  const [presetCursor, setPresetCursor] = useState(0)
  const [customCron, setCustomCron] = useState('')
  const [modelCursor, setModelCursor] = useState(0)
  const [effortCursor, setEffortCursor] = useState(0)
  const [tmuxCursor, setTmuxCursor] = useState(0) // 0=tmux, 1=headless
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)

  const { data, error: listError, loading } = useApi<ProjectsResponse>('/api/projects', config, 30000)
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

  const effectiveCron = CRON_PRESETS[presetCursor].value || customCron.trim()

  const doSubmit = useCallback(async () => {
    const project = projects[projectCursor]
    if (!project || !effectiveCron) return
    setBusy(true)
    setStep('submitting')
    try {
      const body: Record<string, unknown> = {
        projectId: project.id,
        cron: effectiveCron,
        enabled: true,
      }
      if (prompt.trim()) body.prompt = prompt.trim()
      const model = MODELS[modelCursor].value
      if (model) body.model = model
      const effort = EFFORTS[effortCursor].value
      if (effort) body.effort = effort
      if (tmuxCursor === 1) body.useTmux = false

      await apiPost('/api/schedules', body, config)
      onStatus(`Schedule created: ${effectiveCron}`)
      onDone()
    } catch (e) {
      onStatus(String(e), true)
      setStep('confirm')
    } finally {
      setBusy(false)
    }
  }, [projects, projectCursor, effectiveCron, prompt, modelCursor, effortCursor, tmuxCursor, config, onStatus, onDone])

  useInput(
    useCallback(
      (input, key) => {
        if (busy) return
        if (key.escape) { goBack(); return }

        if (step === 'pick-project') {
          if (key.downArrow || input === 'j') setCursor((c) => Math.min(c + 1, projects.length - 1))
          else if (key.upArrow || input === 'k') setCursor((c) => Math.max(c - 1, 0))
          else if (key.return && projects.length > 0) goNext()
        } else if (step === 'enter-cron') {
          const isCustom = CRON_PRESETS[presetCursor].value === ''
          if (isCustom) {
            // custom cron text input
            if (key.tab) setPresetCursor((c) => Math.min(c - 1, CRON_PRESETS.length - 1))
            else if (key.return) {
              if (customCron.trim()) goNext()
            } else if (key.backspace || key.delete) {
              setCustomCron((s) => s.slice(0, -1))
            } else if (input && !key.ctrl && !key.meta) {
              setCustomCron((s) => s + input)
            }
          } else {
            if (key.downArrow || input === 'j') setPresetCursor((c) => Math.min(c + 1, CRON_PRESETS.length - 1))
            else if (key.upArrow || input === 'k') setPresetCursor((c) => Math.max(c - 1, 0))
            else if (key.return) goNext()
          }
        } else if (step === 'pick-model') {
          if (key.downArrow || input === 'j') setModelCursor((c) => Math.min(c + 1, MODELS.length - 1))
          else if (key.upArrow || input === 'k') setModelCursor((c) => Math.max(c - 1, 0))
          else if (key.return) goNext()
        } else if (step === 'pick-effort') {
          if (key.downArrow || input === 'j') setEffortCursor((c) => Math.min(c + 1, EFFORTS.length - 1))
          else if (key.upArrow || input === 'k') setEffortCursor((c) => Math.max(c - 1, 0))
          else if (key.return) goNext()
        } else if (step === 'pick-tmux') {
          if (key.downArrow || input === 'j') setTmuxCursor((c) => Math.min(c + 1, 1))
          else if (key.upArrow || input === 'k') setTmuxCursor((c) => Math.max(c - 1, 0))
          else if (key.return) goNext()
        } else if (step === 'enter-prompt') {
          if (key.return) goNext()
          else if (key.backspace || key.delete) setPrompt((s) => s.slice(0, -1))
          else if (input && !key.ctrl && !key.meta) setPrompt((s) => s + input)
        } else if (step === 'confirm') {
          if (input === 'y' || key.return) doSubmit()
        }
      },
      [busy, step, projects.length, presetCursor, customCron, goBack, goNext, doSubmit],
    ),
  )

  const selectedProject = projects[projectCursor]
  const isCustomPreset = CRON_PRESETS[presetCursor].value === ''
  const stepIdx = STEPS.indexOf(step)

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">New Schedule</Text>
        <Text color="gray">  {stepIdx + 1}/{STEPS.length}</Text>
        <Box flexGrow={1} />
        <Text color="gray">Esc=back</Text>
      </Box>

      {listError && <Box paddingX={1}><Text color="red">{listError}</Text></Box>}

      {step === 'pick-project' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="gray">Select project:</Text>
          {loading && <LoadingSkeleton rows={3} />}
          {projects.map((p, i) => (
            <Box key={p.id}>
              <Text color={i === projectCursor ? 'white' : 'gray'} backgroundColor={i === projectCursor ? 'blue' : undefined}>
                {i === projectCursor ? '▶ ' : '  '}<Text bold={i === projectCursor}>{p.name}</Text>
                <Text color="gray">  {p.agentType}</Text>
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {step === 'enter-cron' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="gray">Cron expression:</Text>
          {CRON_PRESETS.map((p, i) => (
            <Box key={p.label}>
              <Text color={i === presetCursor ? 'cyan' : 'gray'}>
                {i === presetCursor ? '▶ ' : '  '}{p.label.padEnd(22)}{p.value && <Text color="gray" dimColor>{p.value}</Text>}
              </Text>
            </Box>
          ))}
          {isCustomPreset && (
            <Box borderStyle="round" paddingX={1} borderColor="cyan" marginTop={1}>
              <Text color={customCron ? 'white' : 'gray'}>{customCron || '(e.g. */30 * * * *)'}█</Text>
            </Box>
          )}
          {effectiveCron && (
            <Box marginTop={1}>
              <Text color="gray" dimColor>Next: {nextFirePreview(effectiveCron)}</Text>
            </Box>
          )}
        </Box>
      )}

      {step === 'pick-model' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="gray">Model override:</Text>
          {MODELS.map((m, i) => (
            <Text key={m.value} color={i === modelCursor ? 'cyan' : 'gray'} dimColor={i !== modelCursor}>
              {i === modelCursor ? '▶ ' : '  '}{m.label}
            </Text>
          ))}
        </Box>
      )}

      {step === 'pick-effort' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="gray">Effort override:</Text>
          {EFFORTS.map((e, i) => (
            <Text key={e.value} color={i === effortCursor ? 'cyan' : 'gray'} dimColor={i !== effortCursor}>
              {i === effortCursor ? '▶ ' : '  '}{e.label}
            </Text>
          ))}
        </Box>
      )}

      {step === 'pick-tmux' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="gray">Run mode:</Text>
          {[
            { label: 'tmux (interactive)' },
            { label: 'headless (-p)' },
          ].map((m, i) => (
            <Text key={m.label} color={i === tmuxCursor ? 'cyan' : 'gray'} dimColor={i !== tmuxCursor}>
              {i === tmuxCursor ? '▶ ' : '  '}{m.label}
            </Text>
          ))}
        </Box>
      )}

      {step === 'enter-prompt' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="gray">Prompt template (Enter to skip/confirm):</Text>
          <Box borderStyle="round" paddingX={1} borderColor="cyan" marginTop={1}>
            <Text color={prompt ? 'white' : 'gray'}>{prompt || '(empty — use template if set)'}█</Text>
          </Box>
        </Box>
      )}

      {step === 'confirm' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="yellow">Confirm new schedule?</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">Project:  <Text color="cyan">{selectedProject?.name}</Text></Text>
            <Text color="gray">Cron:     <Text color="white">{effectiveCron}</Text></Text>
            {MODELS[modelCursor].value && <Text color="gray">Model:    <Text color="cyan">{MODELS[modelCursor].label}</Text></Text>}
            {EFFORTS[effortCursor].value && <Text color="gray">Effort:   <Text color="cyan">{EFFORTS[effortCursor].label}</Text></Text>}
            <Text color="gray">Run mode: <Text color="cyan">{tmuxCursor === 0 ? 'tmux' : 'headless'}</Text></Text>
            {prompt && <Text color="gray">Prompt:   <Text color="white">{prompt.slice(0, 60)}</Text></Text>}
          </Box>
          {effectiveCron && (
            <Box marginTop={1}><Text color="gray" dimColor>Next: {nextFirePreview(effectiveCron)}</Text></Box>
          )}
          <Box marginTop={1}><Text color="green">y/Enter=create  Esc=back</Text></Box>
        </Box>
      )}

      {step === 'submitting' && (
        <Box paddingX={1}><Text color="yellow">Creating schedule…</Text></Box>
      )}
    </Box>
  )
}
