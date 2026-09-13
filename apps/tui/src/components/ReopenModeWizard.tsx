import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'

type Action = 'reopen' | 'fork' | 'respawn'

interface Props {
  action: Action
  onConfirm: (useTmux: boolean) => void
  onCancel: () => void
}

const ACTION_LABELS: Record<Action, string> = {
  reopen: 'Reopen',
  fork: 'Fork',
  respawn: 'Respawn',
}

export function ReopenModeWizard({ action, onConfirm, onCancel }: Props) {
  const [cursor, setCursor] = useState(0) // 0=tmux, 1=headless

  useInput(
    useCallback(
      (input, key) => {
        if (key.escape) { onCancel(); return }
        if (key.downArrow || input === 'j') setCursor((c) => Math.min(c + 1, 1))
        else if (key.upArrow || input === 'k') setCursor((c) => Math.max(c - 1, 0))
        else if (key.return) onConfirm(cursor === 0)
      },
      [cursor, onConfirm, onCancel],
    ),
  )

  const label = ACTION_LABELS[action]

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginX={1} marginBottom={1}>
      <Text bold color="yellow">{label} — select run mode</Text>
      <Text color="gray">j/k=move  Enter=confirm  Esc=cancel</Text>

      <Box flexDirection="column" marginTop={1}>
        {[
          { label: 'tmux (interactive)', desc: 'Full TUI + live transcript' },
          { label: 'headless (-p)', desc: 'Background one-shot subprocess' },
        ].map((m, i) => (
          <Box key={m.label} flexDirection="row" marginTop={i > 0 ? 0 : 0}>
            <Text color={i === cursor ? 'cyan' : 'gray'}>
              {i === cursor ? '▶ ' : '  '}{m.label.padEnd(24)}
            </Text>
            <Text color="gray" dimColor>{m.desc}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
