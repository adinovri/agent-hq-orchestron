import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import { existsSync } from 'node:fs'
import type { ProjectMetadata } from '@agent-hq-orchestron/shared'
import type { ApiConfig } from '../hooks/useApi.js'
import { useApi } from '../hooks/useApi.js'
import { LoadingSkeleton } from '../components/LoadingSkeleton.js'

interface Props {
  config: ApiConfig
  onDone: () => void
  onStatus: (msg: string, isError?: boolean) => void
}

type Step = 'pick-project' | 'enter-path' | 'confirm' | 'submitting'

interface ProjectsResponse {
  projects: ProjectMetadata[]
}

function detectFormat(path: string): { format: string; ok: boolean } {
  if (path.endsWith('.jsonl')) return { format: 'JSONL (claude / codex-rollout)', ok: true }
  if (path.endsWith('.tar.gz') || path.endsWith('.tgz')) return { format: 'tar.gz (codex TUI SQLite)', ok: true }
  return { format: 'unknown extension', ok: false }
}

export function ImportWizard({ config, onDone, onStatus }: Props) {
  const [step, setStep] = useState<Step>('pick-project')
  const [cursor, setCursor] = useState(0)
  const [filePath, setFilePath] = useState('')
  const [fileError, setFileError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const { data, error: listError, loading } = useApi<ProjectsResponse>('/api/projects', config, 30000)
  const projects = data?.projects ?? []

  const validatePath = useCallback((path: string): string | null => {
    const trimmed = path.trim()
    if (!trimmed) return 'Path is required'
    const { ok } = detectFormat(trimmed)
    if (!ok) return 'File must be .jsonl or .tar.gz'
    if (!existsSync(trimmed)) return `File not found: ${trimmed}`
    return null
  }, [])

  const doSubmit = useCallback(async () => {
    const project = projects[cursor]
    if (!project) return
    const err = validatePath(filePath)
    if (err) { setFileError(err); return }

    setBusy(true)
    setStep('submitting')

    try {
      const formData = new FormData()
      formData.append('projectId', project.id)
      const { readFileSync } = await import('node:fs')
      const { basename } = await import('node:path')
      const bytes = readFileSync(filePath.trim())
      const blob = new Blob([bytes])
      formData.append('file', blob, basename(filePath.trim()))

      const headers: Record<string, string> = {}
      if (config.token) headers['Authorization'] = `Bearer ${config.token}`
      const res = await fetch(`${config.baseUrl}/api/sessions/import`, { method: 'POST', headers, body: formData })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const result = await res.json() as { id: string; regeneratedUuid?: boolean }
      onStatus(`Imported → session ${result.id.slice(0, 8)}${result.regeneratedUuid ? ' (UUID regenerated)' : ''}`)
      onDone()
    } catch (e) {
      onStatus(String(e), true)
      setStep('confirm')
    } finally {
      setBusy(false)
    }
  }, [projects, cursor, filePath, config, validatePath, onStatus, onDone])

  useInput(
    useCallback(
      (input, key) => {
        if (busy) return

        if (key.escape) {
          if (step === 'enter-path') setStep('pick-project')
          else if (step === 'confirm') setStep('enter-path')
          else onDone()
          return
        }

        if (step === 'pick-project') {
          if (key.downArrow || input === 'j') setCursor((c) => Math.min(c + 1, projects.length - 1))
          else if (key.upArrow || input === 'k') setCursor((c) => Math.max(c - 1, 0))
          else if (key.return && projects.length > 0) setStep('enter-path')
        } else if (step === 'enter-path') {
          if (key.return) {
            const err = validatePath(filePath)
            if (err) { setFileError(err); return }
            setFileError(null)
            setStep('confirm')
          } else if (key.backspace || key.delete) {
            setFilePath((s) => s.slice(0, -1))
            setFileError(null)
          } else if (input && !key.ctrl && !key.meta) {
            setFilePath((s) => s + input)
            setFileError(null)
          }
        } else if (step === 'confirm') {
          if (input === 'y' || key.return) doSubmit()
        }
      },
      [busy, step, projects.length, filePath, validatePath, doSubmit, onDone],
    ),
  )

  const selectedProject = projects[cursor]
  const { format, ok: fmtOk } = detectFormat(filePath)
  const fileExists = filePath.trim() && fmtOk && existsSync(filePath.trim())

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1} marginBottom={1}>
        <Text bold color="cyan">Import Session Bundle</Text>
        <Box flexGrow={1} />
        <Text color="gray">Esc=back/cancel</Text>
      </Box>

      {listError && <Box paddingX={1}><Text color="red">{listError}</Text></Box>}

      {step === 'pick-project' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="gray">Destination project (1/2):</Text>
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

      {step === 'enter-path' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="gray">Bundle path (2/2){selectedProject ? ` — project: ${selectedProject.name}` : ''}:</Text>
          <Text color="gray" dimColor>Absolute path to .jsonl or .tar.gz file</Text>
          <Box borderStyle="round" paddingX={1} borderColor={fileError ? 'red' : 'cyan'} marginTop={1}>
            <Text color={filePath ? 'white' : 'gray'}>{filePath || '(type path here)'}█</Text>
          </Box>
          {fileError && <Text color="red">{fileError}</Text>}
          {filePath.trim() && !fileError && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">Format: <Text color={fmtOk ? 'cyan' : 'yellow'}>{format}</Text></Text>
              <Text color="gray">File: <Text color={fileExists ? 'green' : 'yellow'}>{fileExists ? 'found' : 'not found yet'}</Text></Text>
            </Box>
          )}
          <Box marginTop={1}><Text color="gray">Enter=confirm  Esc=back</Text></Box>
        </Box>
      )}

      {step === 'confirm' && (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="yellow">Confirm import?</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">Project:  <Text color="cyan">{selectedProject?.name}</Text></Text>
            <Text color="gray">File:     <Text color="white">{filePath.trim()}</Text></Text>
            <Text color="gray">Format:   <Text color="cyan">{format}</Text></Text>
          </Box>
          <Box marginTop={1}><Text color="gray" dimColor>UUID collision is handled automatically via regeneration.</Text></Box>
          <Box marginTop={1}><Text color="green">y/Enter=import  Esc=back</Text></Box>
        </Box>
      )}

      {step === 'submitting' && (
        <Box paddingX={1}><Text color="yellow">Importing session bundle…</Text></Box>
      )}
    </Box>
  )
}
