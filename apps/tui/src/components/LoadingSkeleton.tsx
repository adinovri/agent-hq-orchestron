import React from 'react'
import { Box, Text } from 'ink'

interface Props {
  rows?: number
  label?: string
}

export function LoadingSkeleton({ rows = 5, label = 'Loading…' }: Props) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color="gray" dimColor>{label}</Text>
      {Array.from({ length: rows }).map((_, i) => (
        <Box key={i} marginTop={0}>
          <Text color="gray" dimColor>{'░'.repeat(40 - i * 3)}</Text>
        </Box>
      ))}
    </Box>
  )
}
