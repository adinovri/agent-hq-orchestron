import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'

interface Props {
  session: SessionMetadata
  onConfirm: () => void
  onCancel: () => void
}

type Step = 'summary' | 'confirm-text'

export function KillConfirmWizard({ session, onConfirm, onCancel }: Props) {
  const [step, setStep] = useState<Step>('summary')
  const [typed, setTyped] = useState('')

  useInput(
    useCallback(
      (input, key) => {
        if (key.escape) { onCancel(); return }

        if (step === 'summary') {
          if (key.return) setStep('confirm-text')
        } else if (step === 'confirm-text') {
          if (key.return) {
            if (typed === 'KILL') onConfirm()
            else setTyped('')
          } else if (key.backspace || key.delete) {
            setTyped((s) => s.slice(0, -1))
          } else if (input && !key.ctrl && !key.meta) {
            setTyped((s) => s + input)
          }
        }
      },
      [step, typed, onConfirm, onCancel],
    ),
  )

  const elapsed = session.startedAt
    ? Math.round((Date.now() - new Date(session.startedAt).getTime()) / 60000)
    : null

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} marginX={1} marginBottom={1}>
      <Text bold color="red">Kill Session — irreversible</Text>

      {step === 'summary' && (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="column">
            <Text color="gray">ID:      <Text color="white">{session.id.slice(0, 16)}</Text></Text>
            <Text color="gray">Status:  <Text color="white">{session.status}</Text></Text>
            <Text color="gray">Model:   <Text color="white">{session.model ?? 'project default'}</Text></Text>
            {elapsed !== null && (
              <Text color="gray">Running: <Text color="white">{elapsed} min</Text></Text>
            )}
            {session.initialPrompt && (
              <Text color="gray">Prompt:  <Text color="white">{session.initialPrompt.slice(0, 60)}{session.initialPrompt.length > 60 ? '…' : ''}</Text></Text>
            )}
          </Box>
          <Box marginTop={1}>
            <Text color="yellow">Enter=continue  Esc=cancel</Text>
          </Box>
        </Box>
      )}

      {step === 'confirm-text' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="red">This will kill the session immediately.</Text>
          <Text color="gray">Type <Text bold color="white">KILL</Text> and press Enter to confirm:</Text>
          <Box borderStyle="round" paddingX={1} borderColor={typed === 'KILL' ? 'green' : 'red'} marginTop={1}>
            <Text color={typed === 'KILL' ? 'green' : 'white'}>{typed || ' '}█</Text>
          </Box>
          <Text color="gray" dimColor>Esc=cancel  Enter when KILL typed</Text>
        </Box>
      )}
    </Box>
  )
}
