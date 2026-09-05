'use client'

import { SessionMetadata } from '@agent-hq-orchestron/shared'
import { SessionCard } from './SessionCard'

interface Props {
  sessions: SessionMetadata[]
  killingIds: Set<string>
  onKill: (id: string) => void
  projectNames?: Map<string, string>
}

export function SessionList({ sessions, killingIds, onKill, projectNames }: Props) {
  if (sessions.length === 0) {
    return (
      <div className="text-center py-16 text-zinc-400 text-sm">
        No sessions match your filters.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {sessions.map((s) => (
        <SessionCard
          key={s.id}
          session={s}
          onKill={onKill}
          killing={killingIds.has(s.id)}
          projectName={projectNames?.get(s.projectId)}
        />
      ))}
    </div>
  )
}
