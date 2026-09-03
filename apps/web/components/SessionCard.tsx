'use client'

import Link from 'next/link'
import { SessionMetadata } from '@agent-hq-orchestron/shared'
import { Button } from '@/components/ui/button'

const STATUS_STYLES: Record<string, string> = {
  running: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  spawning: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  completing: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  waiting: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  completed: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  killed: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
}

interface Props {
  session: SessionMetadata
  onKill: (id: string) => void
  killing: boolean
}

export function SessionCard({ session, onKill, killing }: Props) {
  const isActive = ['spawning', 'waiting', 'running', 'completing'].includes(session.status)
  const badge = STATUS_STYLES[session.status] ?? 'bg-zinc-100 text-zinc-500'

  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 flex items-start gap-3 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${badge}`}>
            {session.status}
          </span>
          <span className="text-xs text-zinc-400 font-mono">{session.id.slice(0, 12)}</span>
          <span className="text-xs text-zinc-500">{session.projectId}</span>
          {session.model && (
            <span className="text-xs text-zinc-400">{session.model}</span>
          )}
        </div>
        <p className="mt-1.5 text-sm text-zinc-700 dark:text-zinc-300 line-clamp-2">
          {session.initialPrompt || <span className="italic text-zinc-400">no prompt</span>}
        </p>
        <p className="mt-1 text-xs text-zinc-400">
          Started {new Date(session.startedAt).toLocaleString()}
          {session.endedAt && ` · Ended ${new Date(session.endedAt).toLocaleString()}`}
          {session.costUsd != null && ` · $${session.costUsd.toFixed(4)}`}
        </p>
      </div>
      <div className="flex flex-col gap-2 shrink-0">
        <Link href={`/session/${session.id}`}>
          <Button variant="outline" size="sm">View</Button>
        </Link>
        {isActive && (
          <Button
            variant="ghost"
            size="sm"
            className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950"
            disabled={killing}
            onClick={() => onKill(session.id)}
          >
            Kill
          </Button>
        )}
      </div>
    </div>
  )
}
