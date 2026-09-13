import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'

interface Props {
  suggestedFilename: string
  onSubmit: (filePath: string) => void
  onCancel: () => void
}

export function ExportDialog({ suggestedFilename, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState(suggestedFilename)

  useInput(
    useCallback(
      (input, key) => {
        if (key.escape) {
          onCancel()
          return
        }
        if (key.return) {
          const path = value.trim()
          if (path) onSubmit(path)
          return
        }
        if (key.backspace || key.delete) {
          setValue((s) => s.slice(0, -1))
          return
        }
        if (input && !key.ctrl && !key.meta) {
          setValue((s) => s + input)
        }
      },
      [value, onSubmit, onCancel],
    ),
  )

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginX={1} marginBottom={1}>
      <Text bold color="blue">Export session  </Text>
      <Text color="gray">Enter=save  Esc=cancel</Text>
      <Box marginTop={1}>
        <Text color="blue">Path: </Text>
        <Text color="white">{value}</Text>
        <Text color="blue">█</Text>
      </Box>
    </Box>
  )
}
