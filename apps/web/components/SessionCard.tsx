'use client'

import Link from 'next/link'
import { SessionMetadata } from '@agent-hq-orchestron/shared'
import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/StatusPill'
import { formatRelative, formatDuration } from '@/lib/time'
import { isActive } from '@/lib/status'
import { Sparkles, Terminal, Bot, X } from 'lucide-react'

interface Props {
  session: SessionMetadata
  onKill: (id: string) => void
  killing: boolean
}

const AGENT_ICON: Record<string, React.ReactNode> = {
  claude: <Sparkles className="w-4 h-4" />,
  codex: <Bot className="w-4 h-4" />,
  opencode: <Terminal className="w-4 h-4" />,
}

export function SessionCard({ session, onKill, killing }: Props) {
  const active = isActive(session.status)
  const needsInput = session.status === 'needs_input'
  const icon = AGENT_ICON[session.agentType] ?? <Bot className="w-4 h-4" />

  return (
    <Link
      href={`/session/${session.id}`}
      className={`group block bg-white dark:bg-zinc-900 border rounded-lg p-3 sm:p-4 transition-all hover:shadow-sm ${
        needsInput
          ? 'border-amber-300 dark:border-amber-800 ring-1 ring-amber-100 dark:ring-amber-900/40'
          : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700'
      }`}
    >
      <div className="flex items-start gap-3">
        <div className={`shrink-0 w-9 h-9 rounded-lg flex items-center justify-center ${
          active
            ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200'
            : 'bg-zinc-50 dark:bg-zinc-900 text-zinc-400 dark:text-zinc-500'
        }`}>
          {icon}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusPill status={session.status} />
            {session.model && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">{session.model}</span>
            )}
            {session.effort && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 font-mono uppercase">
                effort:{session.effort}
              </span>
            )}
            <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono">{session.id.slice(0, 8)}</span>
          </div>

          <p className="mt-1.5 text-sm text-zinc-800 dark:text-zinc-200 line-clamp-2 leading-snug">
            {session.initialPrompt || <span className="italic text-zinc-400">no prompt</span>}
          </p>

          <div className="mt-1.5 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400 flex-wrap">
            <span>{formatRelative(session.startedAt)}</span>
            <span className="text-zinc-300 dark:text-zinc-700">·</span>
            <span>{formatDuration(session.startedAt, session.endedAt)}</span>
            {session.costUsd != null && session.costUsd > 0 && (
              <>
                <span className="text-zinc-300 dark:text-zinc-700">·</span>
                <span>${session.costUsd.toFixed(4)}</span>
              </>
            )}
          </div>
        </div>

        {active && (
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950 h-8 w-8 p-0"
            disabled={killing}
            title="Kill session"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onKill(session.id)
            }}
          >
            <X className="w-4 h-4" />
          </Button>
        )}
      </div>
    </Link>
  )
}
