import React from 'react'
import { Box, Text } from 'ink'

interface Props {
  baseUrl: string
}

export function Header({ baseUrl }: Props) {
  return (
    <Box borderStyle="single" paddingX={1} marginBottom={1}>
      <Text bold color="cyan">
        🤖 Orchestron TUI
      </Text>
      <Text color="gray">  {baseUrl}</Text>
      <Box flexGrow={1} />
      <Text color="gray">j/k nav  Enter open  K kill  n new  q quit  / cmd</Text>
    </Box>
  )
}
