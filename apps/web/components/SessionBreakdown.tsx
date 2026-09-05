'use client'

import Link from 'next/link'
import { useState } from 'react'
import { formatRelative } from '@/lib/time'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'

interface SessionRow {
  sessionId: string  // uuid
  cost: number
  tokens: number
  avgDurationMs: number
}

type SortKey = 'cost' | 'tokens' | 'duration'

interface Props {
  data: SessionRow[]
  sessions?: SessionMetadata[]  // for prompt preview + started time
}

export function SessionBreakdown({ data, sessions = [] }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('cost')
  const sessionMap = new Map(sessions.map(s => [s.id, s]))
  const sorted = [...data].sort((a, b) => {
    if (sortKey === 'cost') return b.cost - a.cost
    if (sortKey === 'tokens') return b.tokens - a.tokens
    return b.avgDurationMs - a.avgDurationMs
  })

  if (sorted.length === 0) {
    return <div className="py-8 text-center text-sm text-zinc-500">No sessions with token usage</div>
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-zinc-200 dark:border-zinc-800 text-left">
            <th className="py-2 px-3 text-xs font-medium text-zinc-500">Session</th>
            {(['cost', 'tokens', 'duration'] as const).map((col) => (
              <th
                key={col}
                onClick={() => setSortKey(col)}
                className={`py-2 px-3 text-xs font-medium cursor-pointer hover:text-zinc-800 dark:hover:text-zinc-200 ${
                  sortKey === col ? 'text-zinc-900 dark:text-zinc-100' : 'text-zinc-500'
                }`}
              >
                {col.charAt(0).toUpperCase() + col.slice(1)}
                {sortKey === col && ' ↓'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const s = sessionMap.get(r.sessionId)
            const durMin = r.avgDurationMs / 60_000
            return (
              <tr key={r.sessionId} className="border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900">
                <td className="py-2 px-3 min-w-[240px]">
                  <Link href={`/session/${r.sessionId}`} className="block hover:underline">
                    <div className="text-sm text-zinc-800 dark:text-zinc-200 truncate max-w-md">
                      {s?.initialPrompt || <span className="italic text-zinc-400">no prompt</span>}
                    </div>
                    <div className="text-[10px] text-zinc-400 font-mono mt-0.5">
                      {r.sessionId.slice(0, 12)}
                      {s?.startedAt && ` · ${formatRelative(s.startedAt)}`}
                      {s?.model && ` · ${s.model}`}
                    </div>
                  </Link>
                </td>
                <td className="py-2 px-3 tabular-nums font-mono text-emerald-600 dark:text-emerald-400">
                  ${r.cost.toFixed(4)}
                </td>
                <td className="py-2 px-3 tabular-nums font-mono">
                  {r.tokens >= 1000 ? `${(r.tokens / 1000).toFixed(1)}k` : r.tokens.toLocaleString()}
                </td>
                <td className="py-2 px-3 tabular-nums font-mono text-zinc-500">
                  {durMin < 1 ? `${(durMin * 60).toFixed(0)}s` : `${durMin.toFixed(1)}m`}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
