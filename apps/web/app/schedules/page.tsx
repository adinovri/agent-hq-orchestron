'use client'

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch, fetchJson } from '@/lib/fetcher'
import { Button } from '@/components/ui/button'
import { ScheduleDialog } from '@/components/ScheduleDialog'
import { Skeleton } from '@/components/Skeleton'
import { formatRelative } from '@/lib/time'
import type { ProjectMetadata } from '@agent-hq-orchestron/shared'
import { Plus, Clock, Play, Pencil, Trash2, Pause } from 'lucide-react'

interface Schedule {
  id: string
  cron: string
  projectId: string
  template?: string
  prompt?: string
  vars?: Record<string, string>
  enabled: boolean
  createdAt: string
  lastRunAt?: string
  nextRunAt?: string
}

export default function SchedulesPage() {
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<Schedule | null>(null)

  const { data: schedules = [], isLoading } = useQuery<Schedule[]>({
    queryKey: ['schedules'],
    queryFn: async () => {
      const r = await fetchJson<{ schedules: Schedule[] }>('/api/schedules')
      return r.schedules
    },
    refetchInterval: 10_000,
  })

  const { data: projects = [] } = useQuery<ProjectMetadata[]>({
    queryKey: ['projects'],
    queryFn: async () => {
      const r = await fetchJson<{ projects: ProjectMetadata[] }>('/api/projects')
      return r.projects
    },
  })

  const projectName = (id: string) => projects.find(p => p.id === id)?.name ?? id.slice(0, 8)

  const toggleMutation = useMutation({
    mutationFn: async ({ id, enabled }: { id: string; enabled: boolean }) => {
      const res = await apiFetch(`/api/schedules/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch(`/api/schedules/${id}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  })

  const runMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch(`/api/schedules/${id}/run`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
  })

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Schedules</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            {schedules.length} configured · {schedules.filter(s => s.enabled).length} active
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="shrink-0">
          <Plus className="w-4 h-4 mr-1" /> Schedule
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)}
        </div>
      ) : schedules.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 px-6 text-center bg-white dark:bg-zinc-900 border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg">
          <Clock className="w-10 h-10 text-zinc-300 dark:text-zinc-600 mb-3" />
          <h2 className="text-base font-medium mb-1">No schedules yet</h2>
          <p className="text-sm text-zinc-500 max-w-sm mb-4">
            Auto-spawn a Claude agent on a cron schedule — daily standup, weekly review, hourly checks, etc.
          </p>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Create your first schedule
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {schedules.map((s) => (
            <div key={s.id} className={`bg-white dark:bg-zinc-900 border rounded-lg p-4 ${
              s.enabled ? 'border-zinc-200 dark:border-zinc-800' : 'border-zinc-200 dark:border-zinc-800 opacity-60'
            }`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 font-mono text-xs">
                      {s.cron}
                    </code>
                    <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full ${
                      s.enabled
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                        : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${s.enabled ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-400'}`} />
                      {s.enabled ? 'Active' : 'Paused'}
                    </span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">{projectName(s.projectId)}</span>
                  </div>
                  {s.prompt && (
                    <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300 line-clamp-2">{s.prompt}</p>
                  )}
                  {s.template && (
                    <p className="mt-1 text-xs text-zinc-500">Template: <code className="font-mono">{s.template}</code></p>
                  )}
                  <div className="mt-1.5 flex items-center gap-2 text-xs text-zinc-400 flex-wrap">
                    <span>Created {formatRelative(s.createdAt)}</span>
                    {s.enabled && s.nextRunAt && (
                      <>
                        <span className="text-zinc-300 dark:text-zinc-700">·</span>
                        <span className="text-emerald-600 dark:text-emerald-400">
                          Next: {new Date(s.nextRunAt).toLocaleString()}
                        </span>
                      </>
                    )}
                    {s.lastRunAt && (
                      <>
                        <span className="text-zinc-300 dark:text-zinc-700">·</span>
                        <span>Last: {formatRelative(s.lastRunAt)}</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => runMutation.mutate(s.id)}
                    disabled={runMutation.isPending}
                    className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 hover:text-emerald-600"
                    title="Run now"
                  >
                    <Play className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => toggleMutation.mutate({ id: s.id, enabled: !s.enabled })}
                    disabled={toggleMutation.isPending}
                    className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 hover:text-zinc-700"
                    title={s.enabled ? 'Pause' : 'Resume'}
                  >
                    {s.enabled ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => setEditing(s)}
                    className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 hover:text-zinc-700"
                    title="Edit"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete schedule "${s.cron}"?`)) deleteMutation.mutate(s.id)
                    }}
                    className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-950 text-zinc-500 hover:text-red-600"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <ScheduleDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        onCreated={() => qc.invalidateQueries({ queryKey: ['schedules'] })}
      />

      <ScheduleDialog
        open={!!editing}
        onClose={() => setEditing(null)}
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        onCreated={() => qc.invalidateQueries({ queryKey: ['schedules'] })}
        initial={editing ? {
          id: editing.id,
          cron: editing.cron,
          projectId: editing.projectId,
          prompt: editing.prompt,
          template: editing.template,
        } : undefined}
      />
    </div>
  )
}
