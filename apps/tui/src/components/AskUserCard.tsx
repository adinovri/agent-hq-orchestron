import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'

interface Option {
  label: string
  description?: string
}

interface Question {
  question: string
  header?: string
  multiSelect?: boolean
  options: Option[]
}

interface Payload {
  questions: Question[]
}

function tryParse(content: string): Payload | null {
  try {
    const p = JSON.parse(content)
    if (!p || !Array.isArray(p.questions)) return null
    for (const q of p.questions) {
      if (typeof q?.question !== 'string' || !Array.isArray(q?.options)) return null
    }
    return p as Payload
  } catch {
    return null
  }
}

function formatAnswer(questions: Question[], picks: Map<number, Set<string>>, freeTexts: Map<number, string>): string {
  const lines: string[] = []
  questions.forEach((q, qi) => {
    const picked = picks.get(qi) ?? new Set<string>()
    const freeText = (freeTexts.get(qi) ?? '').trim()
    const parts: string[] = []
    for (const label of picked) {
      if (label === '__OTHER__' && freeText) parts.push(freeText)
      else if (label !== '__OTHER__') parts.push(label)
    }
    if (parts.length === 0) return
    const joined = q.multiSelect ? parts.join(', ') : parts[0]
    lines.push(questions.length > 1 ? `${q.header ?? q.question}: ${joined}` : joined)
  })
  return lines.join('\n')
}

interface Props {
  content: string
  answered: boolean
  onSubmit: (text: string) => void
  active: boolean // when true, captures key input
}

export function AskUserCard({ content, answered, onSubmit, active }: Props) {
  const payload = tryParse(content)
  const [qIndex, setQIndex] = useState(0) // which question is focused
  const [picks, setPicks] = useState<Map<number, Set<string>>>(new Map())
  const [freeTexts, setFreeTexts] = useState<Map<number, string>>(new Map())
  const [textMode, setTextMode] = useState(false)

  const currentQ = payload?.questions[qIndex]
  const currentPicks = picks.get(qIndex) ?? new Set<string>()
  const otherPicked = currentPicks.has('__OTHER__')

  useInput(
    useCallback(
      (input, key) => {
        if (!active || !payload || answered) return

        if (textMode) {
          if (key.escape) {
            setTextMode(false)
          } else if (key.return) {
            // submit free text
            const text = (freeTexts.get(qIndex) ?? '').trim()
            if (text) {
              setPicks((prev) => {
                const next = new Map(prev)
                next.set(qIndex, new Set(['__OTHER__']))
                return next
              })
              // if this is last question, submit
              if (qIndex === payload.questions.length - 1) {
                const answer = formatAnswer(payload.questions, new Map(picks).set(qIndex, new Set(['__OTHER__'])), freeTexts)
                if (answer) onSubmit(answer)
              } else {
                setQIndex((i) => i + 1)
                setTextMode(false)
              }
            }
          } else if (key.backspace || key.delete) {
            setFreeTexts((prev) => {
              const next = new Map(prev)
              next.set(qIndex, (prev.get(qIndex) ?? '').slice(0, -1))
              return next
            })
          } else if (input && !key.ctrl) {
            setFreeTexts((prev) => {
              const next = new Map(prev)
              next.set(qIndex, (prev.get(qIndex) ?? '') + input)
              return next
            })
          }
          return
        }

        // number key → select option
        const num = parseInt(input ?? '', 10)
        if (!isNaN(num) && num >= 1 && currentQ && num <= currentQ.options.length) {
          const label = currentQ.options[num - 1].label
          setPicks((prev) => {
            const next = new Map(prev)
            const cur = new Set(prev.get(qIndex) ?? [])
            if (currentQ.multiSelect) {
              if (cur.has(label)) cur.delete(label)
              else cur.add(label)
            } else {
              cur.clear()
              cur.add(label)
            }
            next.set(qIndex, cur)
            return next
          })
          // for single-select, auto-advance or submit
          if (!currentQ.multiSelect) {
            if (qIndex < payload.questions.length - 1) {
              setQIndex((i) => i + 1)
            } else {
              // submit
              const updatedPicks = new Map(picks)
              const cur = new Set<string>()
              cur.add(label)
              updatedPicks.set(qIndex, cur)
              const answer = formatAnswer(payload.questions, updatedPicks, freeTexts)
              if (answer) onSubmit(answer)
            }
          }
        } else if (input === 't') {
          setTextMode(true)
        } else if (key.return && currentQ?.multiSelect) {
          // submit multi-select
          const answer = formatAnswer(payload.questions, picks, freeTexts)
          if (answer) onSubmit(answer)
        }
      },
      [active, payload, answered, textMode, qIndex, picks, freeTexts, currentQ, onSubmit],
    ),
  )

  if (!payload) {
    return (
      <Box paddingX={1}>
        <Text color="gray" italic>⚠ AskUserQuestion (unparseable) — see tool_use above</Text>
      </Box>
    )
  }

  const q = payload.questions[qIndex]

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={answered ? 'gray' : 'magenta'} paddingX={1} marginBottom={1}>
      <Box>
        <Text bold color={answered ? 'gray' : 'magenta'}>? </Text>
        {q.header && <Text color="gray" dimColor>{q.header}  </Text>}
        <Text color={answered ? 'gray' : 'white'}>{q.question}</Text>
        {payload.questions.length > 1 && (
          <Text color="gray" dimColor>  [{qIndex + 1}/{payload.questions.length}]</Text>
        )}
      </Box>
      {q.options.map((opt, i) => {
        const selected = (picks.get(qIndex) ?? new Set()).has(opt.label)
        return (
          <Box key={i} paddingLeft={2}>
            <Text color={selected ? 'magenta' : 'gray'}>
              {selected ? '●' : '○'} <Text bold>{i + 1}</Text> {opt.label}
              {opt.description ? <Text dimColor>  {opt.description}</Text> : null}
            </Text>
          </Box>
        )
      })}
      {textMode && (
        <Box paddingLeft={2}>
          <Text color="cyan">t ▸ {freeTexts.get(qIndex) ?? ''}<Text color="cyan">█</Text></Text>
        </Box>
      )}
      {active && !answered && (
        <Box paddingLeft={1} marginTop={0}>
          <Text color="gray" dimColor>
            {textMode ? 'Enter=submit  Esc=cancel' : `1-${q.options.length}=pick  t=type  ${q.multiSelect ? 'Enter=submit' : '(auto-submit on pick)'}`}
          </Text>
        </Box>
      )}
      {answered && (
        <Box paddingLeft={1}>
          <Text color="gray" dimColor>✓ answered</Text>
        </Box>
      )}
    </Box>
  )
}
