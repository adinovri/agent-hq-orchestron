'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/fetcher'
import { Check, Send, HelpCircle, Loader2 } from 'lucide-react'

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

interface Props {
  uuid: string
  contentJson: string
  answered: boolean
}

function tryParse(contentJson: string): Payload | null {
  try {
    const p = JSON.parse(contentJson)
    if (!p || !Array.isArray(p.questions)) return null
    for (const q of p.questions) {
      if (typeof q?.question !== 'string' || !Array.isArray(q?.options)) return null
    }
    return p as Payload
  } catch {
    return null
  }
}

function formatAnswer(questions: Question[], picks: Map<number, Set<string>>, others: Map<number, string>): string {
  const lines: string[] = []
  questions.forEach((q, qi) => {
    const picked = picks.get(qi) ?? new Set<string>()
    const otherText = (others.get(qi) ?? '').trim()
    const parts: string[] = []
    for (const label of picked) {
      if (label === '__OTHER__' && otherText) parts.push(otherText)
      else if (label !== '__OTHER__') parts.push(label)
    }
    if (parts.length === 0) return
    const joined = q.multiSelect ? parts.join(', ') : parts[0]
    lines.push(questions.length > 1 ? `${q.header ?? q.question}: ${joined}` : joined)
  })
  return lines.join('\n')
}

export function AskUserQuestionCard({ uuid, contentJson, answered }: Props) {
  const payload = tryParse(contentJson)
  const qc = useQueryClient()

  // picks[qIndex] = set of selected labels ('__OTHER__' means the free-text branch)
  const [picks, setPicks] = useState<Map<number, Set<string>>>(new Map())
  const [others, setOthers] = useState<Map<number, string>>(new Map())
  const [submitted, setSubmitted] = useState(false)

  const sendMutation = useMutation({
    mutationFn: async (prompt: string) => {
      const res = await apiFetch(`/api/sessions/${uuid}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      return res.json()
    },
    onSuccess: () => {
      setSubmitted(true)
      qc.invalidateQueries({ queryKey: ['session', uuid] })
      qc.invalidateQueries({ queryKey: ['transcript', uuid] })
    },
  })

  if (!payload) {
    return (
      <div className="text-xs text-zinc-500 italic px-3 py-2">
        AskUserQuestion payload could not be parsed — see raw tool_use above.
      </div>
    )
  }

  const disabled = answered || submitted || sendMutation.isPending

  const toggle = (qi: number, label: string, multiSelect: boolean) => {
    if (disabled) return
    setPicks(prev => {
      const next = new Map(prev)
      const cur = new Set(next.get(qi) ?? [])
      if (multiSelect) {
        if (cur.has(label)) cur.delete(label)
        else cur.add(label)
      } else {
        cur.clear()
        cur.add(label)
      }
      next.set(qi, cur)
      return next
    })
  }

  const setOther = (qi: number, text: string) => {
    if (disabled) return
    setOthers(prev => {
      const next = new Map(prev)
      next.set(qi, text)
      return next
    })
  }

  const canSubmit = payload.questions.every((_, qi) => {
    const picked = picks.get(qi) ?? new Set<string>()
    if (picked.size === 0) return false
    if (picked.has('__OTHER__')) return (others.get(qi) ?? '').trim().length > 0
    return true
  })

  const handleSubmit = () => {
    const text = formatAnswer(payload.questions, picks, others)
    if (!text) return
    sendMutation.mutate(text)
  }

  return (
    <div className="rounded-lg border border-violet-200 dark:border-violet-900/60 bg-violet-50/50 dark:bg-violet-950/20 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-violet-200 dark:border-violet-900/60 bg-violet-100/60 dark:bg-violet-900/20">
        <HelpCircle className="w-3.5 h-3.5 text-violet-700 dark:text-violet-300" />
        <span className="text-xs font-medium text-violet-900 dark:text-violet-100">
          {answered ? 'Question answered' : 'Claude is asking'}
        </span>
        {payload.questions.length > 1 && (
          <span className="text-[10px] text-violet-600 dark:text-violet-400">
            {payload.questions.length} questions
          </span>
        )}
      </div>

      <div className="p-3 space-y-4">
        {payload.questions.map((q, qi) => {
          const picked = picks.get(qi) ?? new Set<string>()
          const otherPicked = picked.has('__OTHER__')
          return (
            <div key={qi} className="space-y-2">
              {q.header && (
                <div className="text-[10px] uppercase tracking-wide text-violet-600 dark:text-violet-400 font-mono">
                  {q.header}
                </div>
              )}
              <div className="text-sm text-zinc-800 dark:text-zinc-100">{q.question}</div>
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((opt) => {
                  const active = picked.has(opt.label)
                  return (
                    <button
                      key={opt.label}
                      onClick={() => toggle(qi, opt.label, !!q.multiSelect)}
                      disabled={disabled}
                      title={opt.description}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs border transition ${
                        active
                          ? 'bg-violet-600 text-white border-violet-600 hover:bg-violet-700'
                          : 'bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 border-zinc-300 dark:border-zinc-700 hover:border-violet-400 dark:hover:border-violet-600'
                      } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
                    >
                      {active && <Check className="w-3 h-3" />}
                      {opt.label}
                    </button>
                  )
                })}
                <button
                  onClick={() => toggle(qi, '__OTHER__', !!q.multiSelect)}
                  disabled={disabled}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs border transition ${
                    otherPicked
                      ? 'bg-violet-600 text-white border-violet-600 hover:bg-violet-700'
                      : 'bg-white dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 border-dashed border-zinc-300 dark:border-zinc-700 hover:border-violet-400'
                  } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  ✎ Other
                </button>
              </div>
              {otherPicked && (
                <input
                  type="text"
                  autoFocus
                  value={others.get(qi) ?? ''}
                  onChange={(e) => setOther(qi, e.target.value)}
                  disabled={disabled}
                  placeholder="Type your answer…"
                  className="w-full px-2.5 py-1.5 text-sm rounded-md border border-violet-300 dark:border-violet-700 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-60"
                />
              )}
            </div>
          )
        })}

        {!answered && !submitted && (
          <div className="flex items-center justify-between pt-1">
            <div className="text-[10px] text-zinc-500 dark:text-zinc-400">
              Sends as text to the session — Claude may need to dismiss its TUI selector first.
            </div>
            <button
              onClick={handleSubmit}
              disabled={!canSubmit || sendMutation.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              {sendMutation.isPending ? (
                <><Loader2 className="w-3 h-3 animate-spin" /> Sending…</>
              ) : (
                <><Send className="w-3 h-3" /> Send answer</>
              )}
            </button>
          </div>
        )}
        {sendMutation.error && (
          <div className="text-[11px] text-red-600 dark:text-red-400">
            {(sendMutation.error as Error).message}
          </div>
        )}
      </div>
    </div>
  )
}
