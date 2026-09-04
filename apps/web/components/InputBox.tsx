'use client'

import { useState, KeyboardEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/fetcher'
import type { SessionStatus } from '@agent-hq-orchestron/shared'

interface Props {
  uuid: string
  status: SessionStatus
}

const ENABLED: SessionStatus[] = ['awaiting_input', 'waiting']
const HINT: Partial<Record<SessionStatus, string>> = {
  spawning: 'Session is spawning…',
  waiting: 'Session ready — type your first message',
  running: 'Agent is working — wait for its response',
  awaiting_input: 'Agent is waiting for you',
  completing: 'Session is completing…',
  completed: 'Session ended',
  failed: 'Session failed',
  killed: 'Session killed',
}

export function InputBox({ uuid, status }: Props) {
  const [text, setText] = useState('')
  const qc = useQueryClient()

  const sendMutation = useMutation({
    mutationFn: async (prompt: string) => {
      const res = await apiFetch(`/api/sessions/${uuid}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      return res.json()
    },
    onSuccess: () => {
      setText('')
      qc.invalidateQueries({ queryKey: ['session', uuid] })
    },
  })

  const enabled = ENABLED.includes(status) && !sendMutation.isPending
  const hint = HINT[status] ?? ''

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed || !enabled) return
    sendMutation.mutate(trimmed)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      submit()
    }
  }

  const isAwaiting = status === 'awaiting_input'

  return (
    <div className={`border-t px-3 py-2 ${isAwaiting ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/20' : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900'}`}>
      {isAwaiting && (
        <div className="text-xs font-medium text-amber-700 dark:text-amber-400 mb-1">
          Needs your input
        </div>
      )}
      <div className="flex gap-2 items-end">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!enabled}
          placeholder={hint || 'Type a message…'}
          rows={2}
          className="flex-1 resize-none rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm disabled:bg-zinc-50 disabled:text-zinc-400 dark:disabled:bg-zinc-950 dark:disabled:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <button
          type="button"
          onClick={submit}
          disabled={!enabled || !text.trim()}
          className="rounded bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-300 dark:disabled:bg-zinc-700 text-white text-sm font-medium px-3 py-1.5 transition"
        >
          {sendMutation.isPending ? 'Sending…' : 'Send'}
        </button>
      </div>
      {sendMutation.isError && (
        <div className="text-xs text-red-600 mt-1">{(sendMutation.error as Error).message}</div>
      )}
      <div className="text-[10px] text-zinc-400 mt-1">Ctrl+Enter to send</div>
    </div>
  )
}
