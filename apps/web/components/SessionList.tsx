'use client'

import { SessionMetadata } from '@agent-hq-orchestron/shared'
import { SessionCard } from './SessionCard'
import { Folder, ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

/** Derive the parent→children map + a short human label per parent from
 *  the flat session list. Used to surface list-level tree hints
 *  (`⑃ N` on parents, `⑃ parent: X` on children) without hitting the
 *  delegation endpoint per card. */
function buildDelegationMaps(sessions: SessionMetadata[]): {
  descendantCount: Map<string, number>
  parentLabel: Map<string, string>
} {
  const descendantCount = new Map<string, number>()
  const parentLabel = new Map<string, string>()
  const byId = new Map(sessions.map(s => [s.id, s]))
  for (const s of sessions) {
    if (!s.parentSessionId) continue
    descendantCount.set(s.parentSessionId, (descendantCount.get(s.parentSessionId) ?? 0) + 1)
    const parent = byId.get(s.parentSessionId)
    if (parent) {
      const label = (parent.initialPrompt ?? '').trim().slice(0, 28) || parent.id.slice(0, 8)
      parentLabel.set(s.id, label)
    } else {
      parentLabel.set(s.id, s.parentSessionId.slice(0, 8))
    }
  }
  return { descendantCount, parentLabel }
}

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
  descendantCount?: Map<string, number>,
  parentLabel?: Map<string, string>,
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
      descendantCount={descendantCount?.get(s.id)}
      parentLabel={parentLabel?.get(s.id)}
    />
  )
}

export function SessionList({ sessions, killingIds, onKill, projectNames, projectDefaults, groupBy }: Props) {
  const { descendantCount, parentLabel } = useMemo(() => buildDelegationMaps(sessions), [sessions])

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
        {sessions.map((s) => renderCard(s, killingIds, onKill, projectNames, projectDefaults, descendantCount, parentLabel))}
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
      {orderedProjectIds.map((pid) => (
        <ProjectGroup
          key={pid}
          projectId={pid}
          items={groups.get(pid)!}
          projectNames={projectNames}
          projectDefaults={projectDefaults}
          killingIds={killingIds}
          onKill={onKill}
          descendantCount={descendantCount}
          parentLabel={parentLabel}
        />
      ))}
    </div>
  )
}

// ── Collapsible per-project group ─────────────────────────────────────

const COLLAPSED_STORAGE_KEY = 'orchestron.dashboard.collapsedProjects'

function loadCollapsedSet(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_STORAGE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw) as unknown
    if (Array.isArray(arr)) return new Set(arr.filter((x): x is string => typeof x === 'string'))
  } catch { /* private mode / corrupt */ }
  return new Set()
}

function saveCollapsedSet(s: Set<string>): void {
  try { localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(Array.from(s))) } catch { /* noop */ }
}

interface ProjectGroupProps {
  projectId: string
  items: SessionMetadata[]
  projectNames?: Map<string, string>
  projectDefaults?: Map<string, { model?: string; effort?: string }>
  killingIds: Set<string>
  onKill: (id: string) => void
  descendantCount?: Map<string, number>
  parentLabel?: Map<string, string>
}

function ProjectGroup({ projectId, items, projectNames, projectDefaults, killingIds, onKill, descendantCount, parentLabel }: ProjectGroupProps) {
  const [collapsed, setCollapsed] = useState<boolean>(false)
  // Hydrate collapsed state from localStorage after mount (avoids SSR mismatch).
  useEffect(() => {
    setCollapsed(loadCollapsedSet().has(projectId))
  }, [projectId])

  const toggle = () => {
    const set = loadCollapsedSet()
    if (set.has(projectId)) set.delete(projectId)
    else set.add(projectId)
    saveCollapsedSet(set)
    setCollapsed(set.has(projectId))
  }

  const name = projectNames?.get(projectId) ?? projectId.slice(0, 8)
  // Surface attention info so a collapsed section still tells you why it matters.
  const needsInput = items.filter((s) => s.status === 'needs_input').length
  const running = items.filter((s) => ['running', 'spawning', 'waiting'].includes(s.status)).length

  return (
    <section>
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center gap-2 mb-2 px-1 py-0.5 rounded hover:bg-zinc-100/50 dark:hover:bg-zinc-800/50 transition-colors text-left"
        aria-expanded={!collapsed}
        aria-controls={`project-group-${projectId}`}
      >
        {collapsed
          ? <ChevronRight className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
          : <ChevronDown className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        }
        <Folder className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400 truncate">
          {name}
        </h2>
        <span className="text-[10px] text-zinc-400 dark:text-zinc-500 tabular-nums shrink-0">
          {items.length}
        </span>
        {needsInput > 0 && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-mono uppercase bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 shrink-0"
            title={`${needsInput} session${needsInput === 1 ? '' : 's'} awaiting input`}
          >
            {needsInput} need input
          </span>
        )}
        {collapsed && running > 0 && (
          <span
            className="text-[10px] px-1.5 py-0.5 rounded font-mono uppercase bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 shrink-0"
            title={`${running} active`}
          >
            {running} active
          </span>
        )}
      </button>
      {!collapsed && (
        <div id={`project-group-${projectId}`} className="flex flex-col gap-3">
          {items.map((s) => renderCard(s, killingIds, onKill, projectNames, projectDefaults, descendantCount, parentLabel))}
        </div>
      )}
    </section>
  )
}
