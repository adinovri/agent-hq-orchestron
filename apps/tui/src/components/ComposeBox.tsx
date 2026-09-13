import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'

interface Props {
  onSubmit: (text: string) => void
  onCancel: () => void
  placeholder?: string
}

export function ComposeBox({ onSubmit, onCancel, placeholder = 'Type message…' }: Props) {
  const [lines, setLines] = useState<string[]>([''])
  const [cursor, setCursor] = useState(0) // line index

  useInput(
    useCallback(
      (input, key) => {
        if (key.escape) {
          onCancel()
          return
        }

        // Ctrl+Enter = submit
        if (key.return && key.ctrl) {
          const text = lines.join('\n').trim()
          if (text) onSubmit(text)
          return
        }

        // Enter = newline
        if (key.return) {
          setLines((ls) => {
            const next = [...ls]
            next.splice(cursor + 1, 0, '')
            return next
          })
          setCursor((c) => c + 1)
          return
        }

        if (key.backspace || key.delete) {
          setLines((ls) => {
            const next = [...ls]
            if (next[cursor].length > 0) {
              next[cursor] = next[cursor].slice(0, -1)
            } else if (cursor > 0) {
              // merge with previous line
              const merged = next[cursor - 1]
              next.splice(cursor - 1, 2, merged)
              setCursor((c) => c - 1)
            }
            return next
          })
          return
        }

        if (key.upArrow && cursor > 0) {
          setCursor((c) => c - 1)
          return
        }
        if (key.downArrow && cursor < lines.length - 1) {
          setCursor((c) => c + 1)
          return
        }

        if (input && !key.ctrl && !key.meta) {
          setLines((ls) => {
            const next = [...ls]
            next[cursor] = (next[cursor] ?? '') + input
            return next
          })
        }
      },
      [lines, cursor, onSubmit, onCancel],
    ),
  )

  const isEmpty = lines.every((l) => l === '')

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginX={1} marginBottom={1}>
      <Box marginBottom={0}>
        <Text bold color="cyan">Compose  </Text>
        <Text color="gray">Enter=newline  Ctrl+Enter=send  Esc=cancel</Text>
      </Box>
      <Box flexDirection="column" minHeight={3}>
        {isEmpty ? (
          <Text color="gray" italic>{placeholder}</Text>
        ) : (
          lines.map((line, i) => (
            <Text key={i} color={i === cursor ? 'white' : 'gray'}>
              {i === cursor ? `▸ ${line}█` : `  ${line}`}
            </Text>
          ))
        )}
      </Box>
    </Box>
  )
}
