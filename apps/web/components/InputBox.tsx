'use client'

import { useState, KeyboardEvent, useEffect } from 'react'
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
  running: 'Claude is thinking…',
  awaiting_input: 'Type your reply',
  completing: 'Session is completing…',
  completed: 'Session ended',
  failed: 'Session failed',
  killed: 'Session killed',
}

export function InputBox({ uuid, status }: Props) {
  const [text, setText] = useState('')
  const [lastSent, setLastSent] = useState<string | null>(null)
  const qc = useQueryClient()

  // Clear the "just sent" preview when Claude finishes responding
  useEffect(() => {
    if (status === 'awaiting_input' || status === 'completed' || status === 'failed' || status === 'killed') {
      setLastSent(null)
    }
  }, [status])

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
    onSuccess: (_data, prompt) => {
      setLastSent(prompt)
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
  const isThinking = status === 'running' || status === 'spawning'

  return (
    <div className={`border-t px-3 py-2 ${isAwaiting ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/20' : 'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900'}`}>
      {lastSent && (
        <div className="flex items-start gap-1.5 mb-2 text-xs text-zinc-500 border-l-2 border-blue-400 pl-2 py-1 bg-blue-50 dark:bg-blue-950/20">
          <span className="font-medium text-blue-600 dark:text-blue-400 shrink-0">Sent:</span>
          <span className="break-words">{lastSent.length > 200 ? lastSent.slice(0, 200) + '…' : lastSent}</span>
        </div>
      )}
      {isThinking && (
        <div className="flex items-center gap-2 mb-2 text-xs text-zinc-500">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          <span>{status === 'spawning' ? 'Starting Claude…' : 'Claude is thinking…'}</span>
        </div>
      )}
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
