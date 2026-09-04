'use client'

import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { FilterBar, FilterState } from '@/components/FilterBar'
import { SessionList } from '@/components/SessionList'
import { SpawnDialog } from '@/components/SpawnDialog'
import { fetchJson, apiFetch } from '@/lib/fetcher'
import type { SessionMetadata, ProjectMetadata } from '@agent-hq-orchestron/shared'

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
  const [killingIds, setKillingIds] = useState<Set<string>>(new Set())

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
      apiFetch(`/api/sessions/${id}/kill`, { method: 'POST' }),
    onMutate: (id) => setKillingIds((s) => new Set(s).add(id)),
    onSettled: (_, __, id) => {
      setKillingIds((s) => { const n = new Set(s); n.delete(id); return n })
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  const projectNames = useMemo(() => projects.map((p) => p.id), [projects])
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
    ['spawning', 'waiting', 'running', 'completing'].includes(s.status),
  ).length

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Dashboard</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            {activeSessions} active · {sessions.length} total
          </p>
        </div>
        <Button onClick={() => setSpawnOpen(true)}>+ Spawn</Button>
      </div>

      {/* Filters */}
      <FilterBar
        filters={filters}
        projects={projectNames}
        allTags={allTags}
        onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
      />

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3 text-center">
        {(['running', 'completed', 'failed'] as const).map((status) => {
          const count = sessions.filter((s) => s.status === status).length
          return (
            <div key={status} className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3">
              <p className="text-2xl font-bold">{count}</p>
              <p className="text-xs text-zinc-500 capitalize">{status}</p>
            </div>
          )
        })}
      </div>

      {/* List */}
      {sessionsLoading ? (
        <div className="text-center py-12 text-zinc-400">Loading…</div>
      ) : (
        <SessionList
          sessions={filtered}
          killingIds={killingIds}
          onKill={(id) => killMutation.mutate(id)}
        />
      )}

      {/* Spawn dialog */}
      <SpawnDialog
        open={spawnOpen}
        onClose={() => setSpawnOpen(false)}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        templates={templates}
        onSpawned={() => qc.invalidateQueries({ queryKey: ['sessions'] })}
      />
    </div>
  )
}
