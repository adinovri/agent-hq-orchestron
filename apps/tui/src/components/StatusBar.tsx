import React from 'react'
import { Box, Text } from 'ink'

interface Props {
  message: string
  isError?: boolean
}

export function StatusBar({ message, isError }: Props) {
  return (
    <Box borderStyle="single" paddingX={1} marginTop={1}>
      <Text color={isError ? 'red' : 'green'}>{message}</Text>
    </Box>
  )
}
