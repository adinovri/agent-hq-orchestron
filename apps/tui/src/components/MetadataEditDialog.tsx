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

interface Props {
  currentModel?: string
  currentEffort?: string
  onSubmit: (model: string | undefined, effort: string | undefined) => void
  onCancel: () => void
}

export function MetadataEditDialog({ currentModel, currentEffort, onSubmit, onCancel }: Props) {
  const [field, setField] = useState<Field>('model')
  const [modelIdx, setModelIdx] = useState(0)
  const [effortIdx, setEffortIdx] = useState(0)

  useInput(
    useCallback(
      (input, key) => {
        if (key.escape) {
          onCancel()
          return
        }

        if (key.return) {
          const model = MODELS[modelIdx].value || undefined
          const effort = EFFORTS[effortIdx].value || undefined
          onSubmit(model, effort)
          return
        }

        if (key.tab || input === '\t') {
          setField((f) => (f === 'model' ? 'effort' : 'model'))
          return
        }

        if (key.upArrow || input === 'k') {
          if (field === 'model') setModelIdx((i) => Math.max(0, i - 1))
          else setEffortIdx((i) => Math.max(0, i - 1))
        } else if (key.downArrow || input === 'j') {
          if (field === 'model') setModelIdx((i) => Math.min(MODELS.length - 1, i + 1))
          else setEffortIdx((i) => Math.min(EFFORTS.length - 1, i + 1))
        }
      },
      [field, modelIdx, effortIdx, onSubmit, onCancel],
    ),
  )

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginX={1} marginBottom={1}>
      <Text bold color="yellow">Edit Metadata  </Text>
      <Text color="gray">Tab=switch field  j/k=move  Enter=save  Esc=cancel</Text>

      <Box marginTop={1} flexDirection="row" gap={4}>
        <Box flexDirection="column">
          <Text bold color={field === 'model' ? 'cyan' : 'gray'}>Model</Text>
          {currentModel && <Text color="gray" dimColor>current: {currentModel}</Text>}
          {MODELS.map((m, i) => (
            <Text key={m.value} color={i === modelIdx && field === 'model' ? 'cyan' : 'gray'} dimColor={i !== modelIdx || field !== 'model'}>
              {i === modelIdx && field === 'model' ? '▸ ' : '  '}{m.label}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold color={field === 'effort' ? 'cyan' : 'gray'}>Effort</Text>
          {currentEffort && <Text color="gray" dimColor>current: {currentEffort}</Text>}
          {EFFORTS.map((e, i) => (
            <Text key={e.value} color={i === effortIdx && field === 'effort' ? 'cyan' : 'gray'} dimColor={i !== effortIdx || field !== 'effort'}>
              {i === effortIdx && field === 'effort' ? '▸ ' : '  '}{e.label}
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  )
}
