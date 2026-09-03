'use client'

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
  descendantCount?: number
  readOnly?: boolean
  onKill: () => void
  killing: boolean
}

export function SessionHeader({ session, descendantCount, readOnly, onKill, killing }: Props) {
  const isActive = ['spawning', 'waiting', 'running', 'completing'].includes(session.status)
  const badge = STATUS_STYLES[session.status] ?? 'bg-zinc-100 text-zinc-500'

  return (
    <div className="bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 px-4 py-4">
      {readOnly && (
        <div className="mb-3 px-3 py-2 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded text-sm text-amber-800 dark:text-amber-200">
          Snapshot mode — transcript is read-only
        </div>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${badge}`}>
              {session.status}
            </span>
            <span className="font-mono text-sm text-zinc-500">{session.id}</span>
          </div>
          <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300 line-clamp-3">
            {session.initialPrompt}
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
            <span>Project: <strong className="text-zinc-700 dark:text-zinc-300">{session.projectId}</strong></span>
            {session.agentType && <span>Agent: <strong className="text-zinc-700 dark:text-zinc-300">{session.agentType}</strong></span>}
            {session.model && <span>Model: <strong className="text-zinc-700 dark:text-zinc-300">{session.model}</strong></span>}
            <span>Started: {new Date(session.startedAt).toLocaleString()}</span>
            {session.endedAt && <span>Ended: {new Date(session.endedAt).toLocaleString()}</span>}
            {session.costUsd != null && <span>Cost: ${session.costUsd.toFixed(4)}</span>}
          </div>
        </div>
        {isActive && !readOnly && (
          <Button
            variant="outline"
            size="sm"
            className="text-red-600 border-red-200 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950 shrink-0"
            disabled={killing}
            onClick={onKill}
          >
            {killing ? 'Killing…' : `Kill${descendantCount ? ` (${descendantCount} children)` : ''}`}
          </Button>
        )}
      </div>
    </div>
  )
}
