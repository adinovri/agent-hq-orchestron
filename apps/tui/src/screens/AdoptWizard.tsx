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

type Step = 'pick-project' | 'enter-uuid' | 'validating' | 'confirmed' | 'submitting'

interface ValidationResult {
  ok: boolean
  checks: {
    uuid: boolean
    project: boolean
    transcript: boolean
    noExisting: boolean
    noLiveProcess: boolean
  }
  error?: string
}

interface ProjectsResponse {
  projects: ProjectMetadata[]
}

export function AdoptWizard({ config, onDone, onStatus }: Props) {
  const [step, setStep] = useState<Step>('pick-project')
  const [cursor, setCursor] = useState(0)
  const [uuid, setUuid] = useState('')
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [busy, setBusy] = useState(false)

  const { data, error: listError, loading } = useApi<ProjectsResponse>('/api/projects', config, 30000)
  const projects = data?.projects ?? []

  const doValidate = useCallback(async () => {
    const project = projects[cursor]
    if (!project || !uuid.trim()) return
    setBusy(true)
    setStep('validating')
    try {
      const res = await apiPost<{ validation: ValidationResult }>(
        '/api/sessions/adopt/validate',
        { projectId: project.id, claudeSessionUuid: uuid.trim() },
        config,
      )
      setValidation(res.validation)
      setStep('confirmed')
    } catch (e) {
      setValidation({ ok: false, checks: { uuid: false, project: false, transcript: false, noExisting: false, noLiveProcess: false }, error: String(e) })
      setStep('confirmed')
    } finally {
      setBusy(false)
    }
  }, [projects, cursor, uuid, config])

  const doSubmit = useCallback(async () => {
    const project = projects[cursor]
    if (!project) return
    setBusy(true)
    setStep('submitting')
    try {
      await apiPost('/api/sessions/adopt', { projectId: project.id, claudeSessionUuid: uuid.trim() }, config)
      onStatus(`Adopted session ${uuid.trim().slice(0, 8)}`)
      onDone()
    } catch (e) {
      onStatus(String(e), true)
      setStep('confirmed')
    } finally {
      setBusy(false)
    }
  }, [projects, cursor, uuid, config, onStatus, onDone])

  useInput(
    useCallback(
      (input, key) => {
        if (busy) return

        if (key.escape) {
          if (step === 'enter-uuid') setStep('pick-project')
          else if (step === 'confirmed') setStep('enter-uuid')
          else onDone()
          return
        }

        if (step === 'pick-project') {
          if (key.downArrow || input === 'j') setCursor((c) => Math.min(c + 1, projects.length - 1))
          else if (key.upArrow || input === 'k') setCursor((c) => Math.max(c - 1, 0))
          else if (key.return && projects.length > 0) setStep('enter-uuid')
        } else if (step === 'enter-uuid') {
          if (key.return) {
            if (uuid.trim().length >= 8) doValidate()
          } else if (key.backspace || key.delete) {
            setUuid((s) => s.slice(0, -1))
          } else if (input && !key.ctrl && !key.meta) {
            setUuid((s) => s + input)
          }
        } else if (step === 'confirmed') {
          if (input === 'y' || key.return) {
            if (validation?.ok) doSubmit()
          }
        }
      },
      [busy, step, projects.length, uuid, validation, doValidate, doSubmit, onDone],
    ),
  )

  const selectedProject = projects[cursor]

  function checkIcon(val: boolean) {
    return val ? <Text color="green">✓</Text> : <Text color="red">✗</Text>
  }

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">Adopt Session</Text>
        <Box flexGrow={1} />
        <Text color="gray">Esc=back/cancel</Text>
      </Box>

      {listError && <Box paddingX={1}><Text color="red">{listError}</Text></Box>}

      {step === 'pick-project' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="gray">Select project (1/2):</Text>
          {loading && <LoadingSkeleton rows={3} />}
          {projects.map((p, i) => (
            <Box key={p.id}>
              <Text color={i === cursor ? 'white' : 'gray'} backgroundColor={i === cursor ? 'blue' : undefined}>
                {i === cursor ? '▶ ' : '  '}<Text bold={i === cursor}>{p.name}</Text>
                <Text color="gray">  {p.agentType}</Text>
              </Text>
            </Box>
          ))}
          <Box marginTop={1}><Text color="gray">j/k=move  Enter=select</Text></Box>
        </Box>
      )}

      {step === 'enter-uuid' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="gray">
            Session UUID (2/2){selectedProject ? ` — project: ${selectedProject.name}` : ''}:
          </Text>
          <Text color="gray" dimColor>Paste the session UUID from the harness (8+ hex chars)</Text>
          <Box borderStyle="round" paddingX={1} borderColor="cyan" marginTop={1}>
            <Text color={uuid ? 'white' : 'gray'}>{uuid || '(paste UUID here)'}█</Text>
          </Box>
          <Box marginTop={1}><Text color="gray">Enter=validate  Esc=back</Text></Box>
        </Box>
      )}

      {step === 'validating' && (
        <Box paddingX={1}><Text color="yellow">Validating session…</Text></Box>
      )}

      {step === 'confirmed' && validation && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color={validation.ok ? 'green' : 'red'}>
            {validation.ok ? '✓ Validation passed' : '✗ Validation failed'}
          </Text>
          {validation.error && <Text color="red">{validation.error}</Text>}

          <Box flexDirection="column" marginTop={1}>
            <Box><Text color="gray">UUID format:        </Text>{checkIcon(validation.checks.uuid)}</Box>
            <Box><Text color="gray">Project exists:     </Text>{checkIcon(validation.checks.project)}</Box>
            <Box><Text color="gray">Transcript on disk: </Text>{checkIcon(validation.checks.transcript)}</Box>
            <Box><Text color="gray">No existing record: </Text>{checkIcon(validation.checks.noExisting)}</Box>
            <Box><Text color="gray">No live process:    </Text>{checkIcon(validation.checks.noLiveProcess)}</Box>
          </Box>

          {validation.ok && (
            <Box marginTop={1}>
              <Text color="green">y/Enter=adopt  Esc=back</Text>
            </Box>
          )}
          {!validation.ok && (
            <Box marginTop={1}>
              <Text color="gray">Esc=back to edit UUID</Text>
            </Box>
          )}
        </Box>
      )}

      {step === 'submitting' && (
        <Box paddingX={1}><Text color="yellow">Adopting session…</Text></Box>
      )}
    </Box>
  )
}
