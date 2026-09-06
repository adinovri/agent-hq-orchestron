'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/fetcher'
import { ShieldAlert, HelpCircle, Send, Loader2 } from 'lucide-react'
import type { PendingPrompt } from '@agent-hq-orchestron/shared'

interface Props {
  uuid: string
  prompt: PendingPrompt
}

export function PendingPromptBanner({ uuid, prompt }: Props) {
  const qc = useQueryClient()

  const answer = useMutation({
    mutationFn: async (index: number) => {
      const res = await apiFetch(`/api/sessions/${uuid}/answer-prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ index }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      return res.json()
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['session', uuid] })
      qc.invalidateQueries({ queryKey: ['transcript', uuid] })
    },
  })

  const isPermission = prompt.kind === 'permission'
  const Icon = isPermission ? ShieldAlert : HelpCircle
  const accent = isPermission
    ? 'border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30'
    : 'border-violet-300 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30'
  const iconTint = isPermission
    ? 'text-amber-700 dark:text-amber-300'
    : 'text-violet-700 dark:text-violet-300'
  const label = isPermission ? 'Permission needed' : 'Question waiting'

  return (
    <div className={`border-b ${accent} px-3 sm:px-4 py-2.5`}>
      <div className="flex items-start gap-2.5">
        <Icon className={`w-4 h-4 shrink-0 mt-0.5 ${iconTint}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] uppercase tracking-wide font-semibold ${iconTint}`}>
              {label}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              captured {new Date(prompt.capturedAt).toLocaleTimeString()}
            </span>
          </div>
          <div className="mt-1 text-sm text-zinc-800 dark:text-zinc-100 font-medium break-words">
            {prompt.title}
          </div>
          {prompt.detail && (
            <pre className="mt-1 text-[11px] font-mono text-zinc-700 dark:text-zinc-300 bg-white/60 dark:bg-zinc-900/60 rounded px-2 py-1 whitespace-pre-wrap break-all border border-zinc-200 dark:border-zinc-800">
              {prompt.detail}
            </pre>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {prompt.options.map((opt, i) => {
              const idx = i + 1
              const isDangerLike = /\bno\b|deny|reject|cancel/i.test(opt)
              const isPrimary = idx === 1
              const cls = isPrimary
                ? 'bg-violet-600 hover:bg-violet-700 text-white border-violet-600'
                : isDangerLike
                ? 'bg-white dark:bg-zinc-900 hover:bg-red-50 dark:hover:bg-red-950/40 text-red-700 dark:text-red-300 border-red-300 dark:border-red-800'
                : 'bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-200 border-zinc-300 dark:border-zinc-700'
              return (
                <button
                  key={idx}
                  onClick={() => answer.mutate(idx)}
                  disabled={answer.isPending}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs border transition disabled:opacity-50 disabled:cursor-not-allowed ${cls}`}
                  title={`Sends Down×${idx - 1} + Enter to the tmux pane`}
                >
                  {answer.isPending && answer.variables === idx ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <span className="font-mono text-[10px] opacity-70">{idx}.</span>
                  )}
                  <span className="truncate max-w-[280px]">{opt}</span>
                </button>
              )
            })}
          </div>
          {answer.error && (
            <div className="mt-1 text-[11px] text-red-600 dark:text-red-400">
              {(answer.error as Error).message}
            </div>
          )}
          <div className="mt-1.5 flex items-center gap-1 text-[10px] text-zinc-500 dark:text-zinc-400">
            <Send className="w-3 h-3" />
            <span>Answered via tmux arrow-nav + Enter. Modal in the pane is source of truth.</span>
          </div>
        </div>
      </div>
    </div>
  )
}
