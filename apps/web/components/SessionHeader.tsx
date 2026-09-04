'use client'

import { SessionMetadata } from '@agent-hq-orchestron/shared'
import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/StatusPill'
import { isActive } from '@/lib/status'
import { formatRelative, formatDuration } from '@/lib/time'
import { X, GitBranch, ChevronDown, ChevronUp } from 'lucide-react'
import { useState } from 'react'

interface Props {
  session: SessionMetadata
  descendantCount?: number
  readOnly?: boolean
  onKill: () => void
  killing: boolean
}

export function SessionHeader({ session, descendantCount, readOnly, onKill, killing }: Props) {
  const active = isActive(session.status)
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
      {readOnly && (
        <div className="mx-3 mt-3 px-3 py-2 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-800 dark:text-amber-200">
          Snapshot mode — transcript is read-only
        </div>
      )}
      <div className="px-3 sm:px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <StatusPill status={session.status} />
              {session.model && (
                <span className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">{session.model}</span>
              )}
              {descendantCount != null && descendantCount > 0 && (
                <span className="inline-flex items-center gap-1 text-xs text-zinc-500">
                  <GitBranch className="w-3 h-3" />
                  {descendantCount}
                </span>
              )}
            </div>
            <p className="mt-2 text-sm text-zinc-800 dark:text-zinc-200 line-clamp-2 leading-snug">
              {session.initialPrompt || <span className="italic text-zinc-400">no prompt</span>}
            </p>
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-1.5 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
            >
              <span>{formatRelative(session.startedAt)} · {formatDuration(session.startedAt, session.endedAt)}</span>
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
            {expanded && (
              <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400 space-y-0.5 font-mono">
                <div>id: {session.id}</div>
                <div>project: {session.projectId}</div>
                <div>agent: {session.agentType}</div>
                <div>started: {new Date(session.startedAt).toLocaleString()}</div>
                {session.endedAt && <div>ended: {new Date(session.endedAt).toLocaleString()}</div>}
                {session.costUsd != null && <div>cost: ${session.costUsd.toFixed(4)}</div>}
              </div>
            )}
          </div>
          {active && !readOnly && (
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950 h-8 w-8 p-0"
              disabled={killing}
              onClick={onKill}
              title={`Kill session${descendantCount ? ` (${descendantCount} children)` : ''}`}
            >
              <X className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
