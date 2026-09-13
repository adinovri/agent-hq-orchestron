import React, { useCallback } from 'react'
import { Box, Text, useInput } from 'ink'

interface Props {
  onBack: () => void
}

// GET /api/settings does not exist yet — Settings screen is a stub.
// When the endpoint ships, wire it with useApi + display remoteToken (masked),
// defaultModel, defaultEffort, port bindings, mcpAutoInject flag.
export function SettingsScreen({ onBack }: Props) {
  useInput(
    useCallback(
      (input: string, key: import('ink').Key) => {
        if (input === 'q' || key.escape) onBack()
      },
      [onBack],
    ),
  )

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Settings
        </Text>
        <Text color="gray">  q/Esc back</Text>
      </Box>
      <Text color="yellow">
        ⚠  GET /api/settings is not available in this API version.
      </Text>
      <Text color="gray" dimColor>
        Settings display will be wired once the endpoint ships (M2/M3 scope).
      </Text>
      <Text color="gray" dimColor>
        To inspect config now, read the orchestron config file directly.
      </Text>
    </Box>
  )
}
