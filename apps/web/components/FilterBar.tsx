'use client'

import { SessionStatus } from '@agent-hq-orchestron/shared'

export interface FilterState {
  search: string
  statuses: SessionStatus[]
  project: string
  tags: string[]
  from: string
  to: string
}

interface Props {
  filters: FilterState
  projects: Array<{ id: string; name: string }>
  allTags: string[]
  onChange: (f: Partial<FilterState>) => void
}

const ALL_STATUSES: SessionStatus[] = [
  'spawning', 'waiting', 'running', 'needs_input', 'idle', 'sleeping', 'completing', 'completed', 'succeeded', 'failed', 'killed',
]

const STATUS_LABELS: Record<SessionStatus, string> = {
  spawning: 'Spawning', waiting: 'Waiting', running: 'Running',
  needs_input: 'Needs input', idle: 'Idle', sleeping: 'Sleeping',
  completing: 'Completing', completed: 'Completed',
  succeeded: 'Succeeded', failed: 'Failed', killed: 'Killed',
}

export function FilterBar({ filters, projects, allTags, onChange }: Props) {
  function toggleStatus(s: SessionStatus) {
    const next = filters.statuses.includes(s)
      ? filters.statuses.filter((x) => x !== s)
      : [...filters.statuses, s]
    onChange({ statuses: next })
  }

  function toggleTag(t: string) {
    const next = filters.tags.includes(t)
      ? filters.tags.filter((x) => x !== t)
      : [...filters.tags, t]
    onChange({ tags: next })
  }

  return (
    <div className="flex flex-wrap gap-3 items-end bg-zinc-50 dark:bg-zinc-900 p-3 rounded-lg border border-zinc-200 dark:border-zinc-800">
      {/* Search */}
      <div className="flex-1 min-w-[180px]">
        <input
          type="text"
          placeholder="Search prompt / UUID…"
          value={filters.search}
          onChange={(e) => onChange({ search: e.target.value })}
          className="w-full h-9 px-3 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400"
        />
      </div>

      {/* Status multi-select */}
      <div className="flex flex-wrap gap-1">
        {ALL_STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => toggleStatus(s)}
            className={`px-2 py-1 rounded text-xs border transition-colors ${
              filters.statuses.includes(s)
                ? 'bg-zinc-800 text-white border-zinc-800 dark:bg-zinc-200 dark:text-zinc-900 dark:border-zinc-200'
                : 'bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800'
            }`}
          >
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {/* Project dropdown */}
      <select
        value={filters.project}
        onChange={(e) => onChange({ project: e.target.value })}
        className="h-9 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm focus:outline-none"
      >
        <option value="">All projects</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>

      {/* Tags multi */}
      {allTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {allTags.map((t) => (
            <button
              key={t}
              onClick={() => toggleTag(t)}
              className={`px-2 py-1 rounded text-xs border transition-colors ${
                filters.tags.includes(t)
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              #{t}
            </button>
          ))}
        </div>
      )}

      {/* Date range */}
      <input
        type="date"
        value={filters.from}
        onChange={(e) => onChange({ from: e.target.value })}
        className="h-9 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm focus:outline-none"
      />
      <span className="text-zinc-400 text-sm self-center">–</span>
      <input
        type="date"
        value={filters.to}
        onChange={(e) => onChange({ to: e.target.value })}
        className="h-9 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm focus:outline-none"
      />

      {/* Reset */}
      <button
        onClick={() => onChange({ search: '', statuses: [], project: '', tags: [], from: '', to: '' })}
        className="h-9 px-3 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors"
      >
        Reset
      </button>
    </div>
  )
}
