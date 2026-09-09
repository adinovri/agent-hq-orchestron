'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/fetcher'
import { HelpCircle, Send, Loader2 } from 'lucide-react'
import type { Inquiry, InquiryField } from '@agent-hq-orchestron/shared'

interface Props {
  uuid: string
  inquiry: Inquiry
}

/**
 * A headless agent's structured question.
 *
 * The tmux counterpart is PendingPromptBanner, which scrapes a selector
 * modal off a live pane and answers it with a keystroke. Nothing like that
 * exists here: a headless turn has no TUI and, by the time the question is
 * visible, no process either. The agent instead returned an `inquiry` in its
 * schema-constrained final response, and the answer is plain text that starts
 * the next `-p --resume` turn. So this is a form, not a set of pills, and
 * submitting it goes to the ordinary /input endpoint.
 */
function fieldKey(f: InquiryField, i: number) {
  return `${i}:${f.name}`
}

/** Render answers as `label: value` lines. The agent asked in prose and gets
 *  prose back; `name` is its machine key, but `label` is what it actually
 *  wrote, so echoing the label is what reads naturally in the transcript.
 *  A single unlabelled-feeling field answers bare. */
function formatAnswer(fields: InquiryField[], values: Map<string, string>): string {
  const answered = fields
    .map((f, i) => ({ f, v: (values.get(fieldKey(f, i)) ?? '').trim() }))
    .filter(({ v }) => v.length > 0)
  if (answered.length === 0) return ''
  if (answered.length === 1 && fields.length === 1) return answered[0]!.v
  return answered.map(({ f, v }) => `${f.label}: ${v}`).join('\n')
}

export function InquiryCard({ uuid, inquiry }: Props) {
  const qc = useQueryClient()
  const [values, setValues] = useState<Map<string, string>>(new Map())
  const [submitted, setSubmitted] = useState(false)

  const send = useMutation({
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

  const disabled = submitted || send.isPending
  const set = (k: string, v: string) => {
    if (disabled) return
    setValues((prev) => new Map(prev).set(k, v))
  }

  // Every field must be answered. The agent said it cannot continue without
  // these, so a half-filled form would just produce the same question again.
  const canSubmit = useMemo(
    () => inquiry.fields.every((f, i) => (values.get(fieldKey(f, i)) ?? '').trim().length > 0),
    [inquiry.fields, values],
  )

  const inputCls =
    'w-full px-2.5 py-1.5 text-sm rounded-md border border-violet-300 dark:border-violet-700 bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:opacity-60'

  return (
    <div className="border-b border-violet-300 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 px-3 sm:px-4 py-2.5">
      <div className="flex items-start gap-2.5">
        <HelpCircle className="w-4 h-4 shrink-0 mt-0.5 text-violet-700 dark:text-violet-300" />
        <div className="min-w-0 flex-1">
          <span className="text-[10px] uppercase tracking-wide font-semibold text-violet-700 dark:text-violet-300">
            {submitted ? 'Answer sent' : 'Agent needs input'}
          </span>
          <div className="mt-1 text-sm text-zinc-800 dark:text-zinc-100 whitespace-pre-wrap break-words">
            {inquiry.message}
          </div>

          <div className="mt-2.5 space-y-2.5">
            {inquiry.fields.map((f, i) => {
              const k = fieldKey(f, i)
              const value = values.get(k) ?? ''
              return (
                <div key={k}>
                  <label className="block text-[11px] font-medium text-zinc-700 dark:text-zinc-300 mb-1">
                    {f.label}
                  </label>
                  {f.type === 'choice' && f.options && f.options.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {f.options.map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => set(k, opt)}
                          disabled={disabled}
                          className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs border transition disabled:opacity-60 disabled:cursor-not-allowed ${
                            value === opt
                              ? 'bg-violet-600 text-white border-violet-600 hover:bg-violet-700'
                              : 'bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 border-zinc-300 dark:border-zinc-700 hover:border-violet-400 dark:hover:border-violet-600'
                          }`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  ) : f.type === 'boolean' ? (
                    <div className="flex gap-1.5">
                      {['yes', 'no'].map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => set(k, opt)}
                          disabled={disabled}
                          className={`inline-flex items-center px-3 py-1 rounded-md text-xs border transition capitalize disabled:opacity-60 disabled:cursor-not-allowed ${
                            value === opt
                              ? 'bg-violet-600 text-white border-violet-600 hover:bg-violet-700'
                              : 'bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 border-zinc-300 dark:border-zinc-700 hover:border-violet-400 dark:hover:border-violet-600'
                          }`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={value}
                      onChange={(e) => set(k, e.target.value)}
                      disabled={disabled}
                      placeholder="Type your answer…"
                      className={inputCls}
                    />
                  )}
                  {/* A choice field whose options the model nulled out still
                    * needs answering, so it falls through to the text input
                    * above rather than rendering an empty row of buttons. */}
                </div>
              )
            })}
          </div>

          {!submitted && (
            <div className="mt-2.5 flex items-center justify-between gap-2">
              <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
                Sends as the next turn — the agent resumes with your answer.
              </span>
              <button
                type="button"
                onClick={() => {
                  const text = formatAnswer(inquiry.fields, values)
                  if (text) send.mutate(text)
                }}
                disabled={!canSubmit || send.isPending}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                {send.isPending
                  ? <><Loader2 className="w-3 h-3 animate-spin" /> Sending…</>
                  : <><Send className="w-3 h-3" /> Send answer</>}
              </button>
            </div>
          )}

          {send.error && (
            <div className="mt-1 text-[11px] text-red-600 dark:text-red-400">
              {(send.error as Error).message}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
