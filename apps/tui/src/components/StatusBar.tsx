import React from 'react'
import { Box, Text } from 'ink'
import type { ToastLevel } from '../hooks/useToast.js'

interface Props {
  message: string
  level?: ToastLevel
  /** @deprecated use level instead */
  isError?: boolean
  reconnecting?: boolean
}

const LEVEL_COLOR: Record<ToastLevel, string> = {
  error: 'red',
  warn: 'yellow',
  info: 'cyan',
  success: 'green',
}

export function StatusBar({ message, level, isError, reconnecting }: Props) {
  const effectiveLevel: ToastLevel = level ?? (isError ? 'error' : 'success')
  const color = LEVEL_COLOR[effectiveLevel]

  return (
    <Box borderStyle="single" paddingX={1} marginTop={1}>
      {reconnecting && (
        <Text color="yellow" bold>⟳ reconnecting…  </Text>
      )}
      <Text color={color}>{message}</Text>
    </Box>
  )
}
