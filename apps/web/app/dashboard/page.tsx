'use client'

import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { FilterBar, FilterState } from '@/components/FilterBar'
import { SessionList } from '@/components/SessionList'
import { SpawnDialog } from '@/components/SpawnDialog'
import { AdoptSessionDialog } from '@/components/AdoptSessionDialog'
import { ImportSessionDialog } from '@/components/ImportSessionDialog'
import { SpawnActionsMenu } from '@/components/SpawnActionsMenu'
import { SessionListSkeleton } from '@/components/Skeleton'
import { fetchJson, apiFetch } from '@/lib/fetcher'
import type { SessionMetadata, ProjectMetadata } from '@agent-hq-orchestron/shared'
import { Plus, Rocket, Inbox, Rows3, FolderTree } from 'lucide-react'
import { useEffect } from 'react'

function fuzzyMatch(haystack: string, needle: string): boolean {
  if (!needle) return true
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  let hi = 0
  for (let ni = 0; ni < n.length; ni++) {
    hi = h.indexOf(n[ni], hi)
    if (hi === -1) return false
    hi++
  }
  return true
}

const DEFAULT_FILTERS: FilterState = {
  search: '', statuses: [], project: '', tags: [], from: '', to: '',
}

export default function DashboardPage() {
  const qc = useQueryClient()
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS)
  const [spawnOpen, setSpawnOpen] = useState(false)
  const [adoptOpen, setAdoptOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [killingIds, setKillingIds] = useState<Set<string>>(new Set())
  const [groupBy, setGroupBy] = useState<'project' | 'none'>('none')

  // Persist grouping preference locally (per browser).
  useEffect(() => {
    try {
      const v = localStorage.getItem('orchestron.dashboard.groupBy')
      if (v === 'project' || v === 'none') setGroupBy(v)
    } catch { /* private mode */ }
  }, [])
  useEffect(() => {
    try { localStorage.setItem('orchestron.dashboard.groupBy', groupBy) } catch { /* noop */ }
  }, [groupBy])

  const { data: sessions = [], isLoading: sessionsLoading } = useQuery<SessionMetadata[]>({
    queryKey: ['sessions'],
    queryFn: async () => {
      const r = await fetchJson<{ sessions: SessionMetadata[] }>('/api/sessions')
      return r.sessions
    },
    refetchInterval: 5_000,
  })

  const { data: projects = [] } = useQuery<ProjectMetadata[]>({
    queryKey: ['projects'],
    queryFn: async () => {
      const r = await fetchJson<{ projects: ProjectMetadata[] }>('/api/projects')
      return r.projects
    },
  })

  const { data: templates = [] } = useQuery<Array<{ name: string; description?: string }>>({
    queryKey: ['templates'],
    queryFn: async () => {
      const r = await fetchJson<{ templates: Array<{ name: string; description?: string }> }>(
        '/api/templates',
      )
      return r.templates
    },
  })

  const killMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/sessions/${id}`, { method: 'DELETE' }),
    onMutate: (id) => setKillingIds((s) => new Set(s).add(id)),
    onSettled: (_, __, id) => {
      setKillingIds((s) => { const n = new Set(s); n.delete(id); return n })
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  const projectOptions = useMemo(() => projects.map((p) => ({ id: p.id, name: p.name })), [projects])
  const projectNameMap = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects])
  const projectDefaultsMap = useMemo(
    () => new Map(projects.map((p) => [p.id, { model: p.defaultModel, effort: p.defaultEffort }])),
    [projects],
  )
  const allTags = useMemo(() => {
    const tags = new Set<string>()
    projects.forEach((p) => p.tags?.forEach((t) => tags.add(t)))
    return Array.from(tags)
  }, [projects])

  const filtered = useMemo(() => {
    return sessions.filter((s) => {
      if (filters.statuses.length && !filters.statuses.includes(s.status)) return false
      if (filters.project && s.projectId !== filters.project) return false
      if (filters.from && s.startedAt < filters.from) return false
      if (filters.to && s.startedAt > filters.to + 'T23:59:59') return false
      if (filters.search) {
        const match = fuzzyMatch(s.initialPrompt ?? '', filters.search) ||
          fuzzyMatch(s.id, filters.search)
        if (!match) return false
      }
      return true
    })
  }, [sessions, filters])

  const activeSessions = sessions.filter((s) =>
    ['spawning', 'waiting', 'running'].includes(s.status),
  ).length
  const needsInputCount = sessions.filter((s) => s.status === 'needs_input').length

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            {activeSessions} active
            {needsInputCount > 0 && (
              <> · <span className="text-amber-600 dark:text-amber-400 font-medium">{needsInputCount} need input</span></>
            )}
            {sessions.length > 0 && ` · ${sessions.length} total`}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden">
            <button
              type="button"
              onClick={() => setGroupBy('none')}
              className={`p-1.5 transition-colors ${
                groupBy === 'none'
                  ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
              }`}
              title="Flat view"
              aria-pressed={groupBy === 'none'}
            >
              <Rows3 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setGroupBy('project')}
              className={`p-1.5 transition-colors border-l border-zinc-200 dark:border-zinc-800 ${
                groupBy === 'project'
                  ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
              }`}
              title="Group by project"
              aria-pressed={groupBy === 'project'}
            >
              <FolderTree className="w-4 h-4" />
            </button>
          </div>
          <SpawnActionsMenu
            onSpawn={() => setSpawnOpen(true)}
            onAdopt={() => setAdoptOpen(true)}
            onImport={() => setImportOpen(true)}
          />
        </div>
      </div>

      {/* Stats row — surface attention state prominently */}
      <div className="grid grid-cols-4 gap-2 sm:gap-3">
        {(
          [
            { key: 'needs_input', label: 'Needs input', color: 'text-amber-600 dark:text-amber-400' },
            { key: 'running', label: 'Running', color: 'text-emerald-600 dark:text-emerald-400' },
            { key: 'succeeded', label: 'Succeeded', color: 'text-emerald-600 dark:text-emerald-400' },
            { key: 'failed', label: 'Failed', color: 'text-red-600 dark:text-red-400' },
          ] as const
        ).map(({ key, label, color }) => {
          const count = sessions.filter((s) => s.status === key).length
          return (
            <div key={key} className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-2.5 sm:p-3 text-center">
              <p className={`text-xl sm:text-2xl font-bold tabular-nums ${color}`}>{count}</p>
              <p className="text-[10px] sm:text-xs text-zinc-500 mt-0.5">{label}</p>
            </div>
          )
        })}
      </div>

      {/* Filters */}
      <FilterBar
        filters={filters}
        projects={projectOptions}
        allTags={allTags}
        onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
      />

      {/* List */}
      {sessionsLoading ? (
        <SessionListSkeleton count={4} />
      ) : sessions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 px-6 text-center bg-white dark:bg-zinc-900 border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg">
          <Rocket className="w-10 h-10 text-zinc-300 dark:text-zinc-600 mb-3" />
          <h2 className="text-base font-medium mb-1">No sessions yet</h2>
          <p className="text-sm text-zinc-500 max-w-xs mb-4">
            Spawn a Claude agent on one of your projects to get started.
          </p>
          <Button onClick={() => setSpawnOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Spawn your first session
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 px-6 text-center text-zinc-500">
          <Inbox className="w-8 h-8 text-zinc-300 dark:text-zinc-600 mb-2" />
          <p className="text-sm">No sessions match your filters</p>
          <button
            onClick={() => setFilters(DEFAULT_FILTERS)}
            className="mt-2 text-xs text-blue-600 hover:underline"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <SessionList
          sessions={filtered}
          killingIds={killingIds}
          onKill={(id) => killMutation.mutate(id)}
          projectNames={projectNameMap}
          projectDefaults={projectDefaultsMap}
          groupBy={groupBy}
        />
      )}

      {/* Spawn dialog */}
      <SpawnDialog
        open={spawnOpen}
        onClose={() => setSpawnOpen(false)}
        projects={projects.map((p) => ({
          id: p.id,
          name: p.name,
          agentType: p.agentType,
          path: p.path,
          defaultModel: p.defaultModel,
          defaultEffort: p.defaultEffort,
          defaultUseTmux: p.defaultUseTmux,
          configDir: p.agentType === 'codex'
            ? p.agentConfig?.env?.['CODEX_HOME']
            : p.agentConfig?.env?.['CLAUDE_CONFIG_DIR'],
        }))}
        templates={templates}
        onSpawned={() => qc.invalidateQueries({ queryKey: ['sessions'] })}
      />

      {/* Adopt existing harness session dialog */}
      <AdoptSessionDialog
        open={adoptOpen}
        onClose={() => setAdoptOpen(false)}
        projects={projects.map((p) => ({
          id: p.id,
          name: p.name,
          agentType: p.agentType,
          path: p.path,
          configDir: p.agentType === 'codex'
            ? p.agentConfig?.env?.['CODEX_HOME']
            : p.agentConfig?.env?.['CLAUDE_CONFIG_DIR'],
        }))}
      />

      {/* Import bundle exported from another orchestron host */}
      <ImportSessionDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        projects={projects.map((p) => ({
          id: p.id,
          name: p.name,
          agentType: p.agentType,
          path: p.path,
          configDir: p.agentType === 'codex'
            ? p.agentConfig?.env?.['CODEX_HOME']
            : p.agentConfig?.env?.['CLAUDE_CONFIG_DIR'],
        }))}
      />
    </div>
  )
}
