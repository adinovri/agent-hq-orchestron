import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'

const MODELS = [
  { label: '— keep current —', value: '' },
  { label: 'claude-opus-5', value: 'claude-opus-5' },
  { label: 'claude-sonnet-5', value: 'claude-sonnet-5' },
  { label: 'claude-fable-5-1', value: 'claude-fable-5-1' },
  { label: 'claude-opus-4-8', value: 'claude-opus-4-8-20250514' },
  { label: 'claude-sonnet-4-6', value: 'claude-sonnet-4-6-20250514' },
  { label: 'claude-haiku-4-5', value: 'claude-haiku-4-5-20251001' },
]

const EFFORTS = [
  { label: '— keep current —', value: '' },
  { label: 'low', value: 'low' },
  { label: 'medium', value: 'medium' },
  { label: 'high', value: 'high' },
  { label: 'xhigh', value: 'xhigh' },
  { label: 'max', value: 'max' },
]

type Field = 'model' | 'effort'
type Step = 'pick-model' | 'pick-effort' | 'confirm'

interface Props {
  currentModel?: string
  currentEffort?: string
  onSubmit: (model: string | undefined, effort: string | undefined) => void
  onCancel: () => void
}

export function MetadataEditDialog({ currentModel, currentEffort, onSubmit, onCancel }: Props) {
  const [step, setStep] = useState<Step>('pick-model')
  const [field, setField] = useState<Field>('model')
  const [modelIdx, setModelIdx] = useState(0)
  const [effortIdx, setEffortIdx] = useState(0)

  useInput(
    useCallback(
      (input, key) => {
        if (key.escape) {
          if (step === 'pick-effort') setStep('pick-model')
          else if (step === 'confirm') setStep('pick-effort')
          else onCancel()
          return
        }

        if (step === 'pick-model') {
          if (key.tab || input === '\t') {
            setField((f) => (f === 'model' ? 'effort' : 'model'))
          } else if (key.return) {
            setStep('pick-effort')
          } else if (key.upArrow || input === 'k') {
            if (field === 'model') setModelIdx((i) => Math.max(0, i - 1))
            else setEffortIdx((i) => Math.max(0, i - 1))
          } else if (key.downArrow || input === 'j') {
            if (field === 'model') setModelIdx((i) => Math.min(MODELS.length - 1, i + 1))
            else setEffortIdx((i) => Math.min(EFFORTS.length - 1, i + 1))
          }
        } else if (step === 'pick-effort') {
          if (key.return) {
            setStep('confirm')
          } else if (key.upArrow || input === 'k') {
            setEffortIdx((i) => Math.max(0, i - 1))
          } else if (key.downArrow || input === 'j') {
            setEffortIdx((i) => Math.min(EFFORTS.length - 1, i + 1))
          }
        } else if (step === 'confirm') {
          if (key.return || input === 'y') {
            const model = MODELS[modelIdx].value || undefined
            const effort = EFFORTS[effortIdx].value || undefined
            onSubmit(model, effort)
          }
        }
      },
      [step, field, modelIdx, effortIdx, onSubmit, onCancel],
    ),
  )

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginX={1} marginBottom={1}>
      <Text bold color="yellow">Edit Metadata  </Text>

      {(step === 'pick-model') && (
        <>
          <Text color="gray">Tab=switch col  j/k=move  Enter=next  Esc=cancel</Text>
          <Box marginTop={1} flexDirection="row" gap={4}>
            <Box flexDirection="column">
              <Text bold color={field === 'model' ? 'cyan' : 'gray'}>Model {step === 'pick-model' && field === 'model' ? '← active' : ''}</Text>
              {currentModel && <Text color="gray" dimColor>current: {currentModel}</Text>}
              {MODELS.map((m, i) => (
                <Text key={m.value} color={i === modelIdx && field === 'model' ? 'cyan' : 'gray'} dimColor={i !== modelIdx || field !== 'model'}>
                  {i === modelIdx && field === 'model' ? '▸ ' : '  '}{m.label}
                </Text>
              ))}
            </Box>
            <Box flexDirection="column">
              <Text bold color={field === 'effort' ? 'cyan' : 'gray'}>Effort {step === 'pick-model' && field === 'effort' ? '← active' : ''}</Text>
              {currentEffort && <Text color="gray" dimColor>current: {currentEffort}</Text>}
              {EFFORTS.map((e, i) => (
                <Text key={e.value} color={i === effortIdx && field === 'effort' ? 'cyan' : 'gray'} dimColor={i !== effortIdx || field !== 'effort'}>
                  {i === effortIdx && field === 'effort' ? '▸ ' : '  '}{e.label}
                </Text>
              ))}
            </Box>
          </Box>
        </>
      )}

      {step === 'pick-effort' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">j/k=move  Enter=review  Esc=back</Text>
          <Box marginTop={1}><Text bold color="cyan">Effort:</Text></Box>
          {currentEffort && <Text color="gray" dimColor>current: {currentEffort}</Text>}
          {EFFORTS.map((e, i) => (
            <Text key={e.value} color={i === effortIdx ? 'cyan' : 'gray'} dimColor={i !== effortIdx}>
              {i === effortIdx ? '▸ ' : '  '}{e.label}
            </Text>
          ))}
        </Box>
      )}

      {step === 'confirm' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">y/Enter=save  Esc=back</Text>
          <Box flexDirection="column" marginTop={1}>
            {MODELS[modelIdx].value
              ? <Text color="gray">Model:  <Text color="cyan">{MODELS[modelIdx].label}</Text></Text>
              : <Text color="gray">Model:  <Text color="gray" dimColor>unchanged</Text></Text>
            }
            {EFFORTS[effortIdx].value
              ? <Text color="gray">Effort: <Text color="cyan">{EFFORTS[effortIdx].label}</Text></Text>
              : <Text color="gray">Effort: <Text color="gray" dimColor>unchanged</Text></Text>
            }
          </Box>
        </Box>
      )}
    </Box>
  )
}
