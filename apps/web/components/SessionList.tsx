'use client'

import { SessionMetadata } from '@agent-hq-orchestron/shared'
import { SessionCard } from './SessionCard'
import { Folder } from 'lucide-react'

interface Props {
  sessions: SessionMetadata[]
  killingIds: Set<string>
  onKill: (id: string) => void
  projectNames?: Map<string, string>
  projectDefaults?: Map<string, { model?: string; effort?: string }>
  /** When 'project', sessions are grouped under project headers.
   *  Anything else (or omitted) renders a flat list. */
  groupBy?: 'project' | 'none'
}

function renderCard(
  s: SessionMetadata,
  killingIds: Set<string>,
  onKill: (id: string) => void,
  projectNames?: Map<string, string>,
  projectDefaults?: Map<string, { model?: string; effort?: string }>,
) {
  const defs = projectDefaults?.get(s.projectId)
  return (
    <SessionCard
      key={s.id}
      session={s}
      onKill={onKill}
      killing={killingIds.has(s.id)}
      projectName={projectNames?.get(s.projectId)}
      projectDefaultModel={defs?.model}
      projectDefaultEffort={defs?.effort}
    />
  )
}

export function SessionList({ sessions, killingIds, onKill, projectNames, projectDefaults, groupBy }: Props) {
  if (sessions.length === 0) {
    return (
      <div className="text-center py-16 text-zinc-400 text-sm">
        No sessions match your filters.
      </div>
    )
  }

  if (groupBy !== 'project') {
    return (
      <div className="flex flex-col gap-3">
        {sessions.map((s) => renderCard(s, killingIds, onKill, projectNames, projectDefaults))}
      </div>
    )
  }

  // Group by projectId, preserving the sorted order of sessions inside each
  // group. Groups themselves are ordered by their most-recent session so the
  // "loudest" project floats up.
  const groups = new Map<string, SessionMetadata[]>()
  for (const s of sessions) {
    const arr = groups.get(s.projectId)
    if (arr) arr.push(s)
    else groups.set(s.projectId, [s])
  }
  const orderedProjectIds = Array.from(groups.keys()).sort((a, b) => {
    const aTop = groups.get(a)![0]!.startedAt
    const bTop = groups.get(b)![0]!.startedAt
    return aTop < bTop ? 1 : aTop > bTop ? -1 : 0
  })

  return (
    <div className="flex flex-col gap-5">
      {orderedProjectIds.map((pid) => {
        const items = groups.get(pid)!
        const name = projectNames?.get(pid) ?? pid.slice(0, 8)
        return (
          <section key={pid}>
            <div className="flex items-center gap-2 mb-2 px-1">
              <Folder className="w-3.5 h-3.5 text-zinc-400" />
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                {name}
              </h2>
              <span className="text-[10px] text-zinc-400 dark:text-zinc-500 tabular-nums">
                {items.length}
              </span>
            </div>
            <div className="flex flex-col gap-3">
              {items.map((s) => renderCard(s, killingIds, onKill, projectNames, projectDefaults))}
            </div>
          </section>
        )
      })}
    </div>
  )
}
