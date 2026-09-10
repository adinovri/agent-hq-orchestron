'use client'

import { useRef, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch, fetchJson } from '@/lib/fetcher'
import { Button } from '@/components/ui/button'
import { ScheduleDialog } from '@/components/ScheduleDialog'
import { type ScheduleProjectOption } from '@/lib/schedule-fields'
import { Skeleton } from '@/components/Skeleton'
import { formatRelative } from '@/lib/time'
import type { ProjectMetadata } from '@agent-hq-orchestron/shared'
import { Plus, Clock, Play, PlayCircle, Pencil, Trash2, Pause, Download, Upload } from 'lucide-react'

import type { ScheduleEntry } from '@agent-hq-orchestron/shared'

type Schedule = ScheduleEntry

/** The dialog needs the project's harness and its three defaults, not just a
 *  label — that is what the "Default — …" rows in its dropdowns name. */
function toScheduleProject(p: ProjectMetadata): ScheduleProjectOption {
  return {
    id: p.id,
    name: p.name,
    agentType: p.agentType,
    defaultModel: p.defaultModel,
    defaultEffort: p.defaultEffort,
    defaultUseTmux: p.defaultUseTmux,
  }
}

export default function SchedulesPage() {
  const qc = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [editing, setEditing] = useState<Schedule | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

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

  async function handleExport() {
    const res = await apiFetch('/api/schedules/export')
    if (!res.ok) { alert(`Export failed: HTTP ${res.status}`); return }
    const yaml = await res.text()
    const blob = new Blob([yaml], { type: 'application/x-yaml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `orchestron-schedules-${new Date().toISOString().slice(0, 10)}.yml`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  async function handleImportFile(file: File) {
    const mode = confirm(
      `Import ${file.name}?\n\nOK = MERGE (add new, update existing by ID)\nCancel = REPLACE (delete all schedules first, then import)`,
    ) ? 'merge' : 'replace'
    setImportBusy(true)
    try {
      const yamlText = await file.text()
      const res = await apiFetch(`/api/schedules/import?mode=${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-yaml' },
        body: yamlText,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      const result = await res.json() as { total: number; created: number; updated: number; skipped: number; errors: Array<{ error: string }> }
      alert(`Imported ${result.total} entries (${mode})\nCreated: ${result.created}\nUpdated: ${result.updated}\nSkipped: ${result.skipped}${result.errors.length ? '\n\nErrors:\n' + result.errors.map(e => e.error).join('\n') : ''}`)
      qc.invalidateQueries({ queryKey: ['schedules'] })
    } catch (err) {
      alert(`Import failed: ${(err as Error).message}`)
    } finally {
      setImportBusy(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Schedules</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            {schedules.length} configured · {schedules.filter(s => s.enabled).length} active
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleExport}
            disabled={schedules.length === 0}
            className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Download all schedules as YAML"
          >
            <Download className="w-3.5 h-3.5" /> Export
          </button>
          <button
            onClick={() => importInputRef.current?.click()}
            disabled={importBusy}
            className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-sm text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Import schedules from YAML file"
          >
            <Upload className="w-3.5 h-3.5" /> {importBusy ? 'Importing…' : 'Import'}
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".yml,.yaml,application/x-yaml"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) handleImportFile(f)
              e.target.value = ''
            }}
          />
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Schedule
          </Button>
        </div>
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
                  {/* Run now = circled play (one-off trigger, common in
                   *  scheduler UIs). Pause/Resume = bare play/pause
                   *  triangle. Split icons so they don't read as two
                   *  identical Play buttons on mobile. */}
                  <button
                    onClick={() => runMutation.mutate(s.id)}
                    disabled={runMutation.isPending}
                    className="p-1.5 rounded hover:bg-amber-50 dark:hover:bg-amber-950 text-zinc-500 hover:text-amber-600 dark:hover:text-amber-400"
                    title="Run now (one-off — doesn't change enabled state)"
                  >
                    <PlayCircle className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => toggleMutation.mutate({ id: s.id, enabled: !s.enabled })}
                    disabled={toggleMutation.isPending}
                    className={`p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 ${
                      s.enabled ? 'hover:text-zinc-700' : 'hover:text-emerald-600 dark:hover:text-emerald-400'
                    }`}
                    title={s.enabled ? 'Pause schedule' : 'Resume schedule'}
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
        projects={projects.map(toScheduleProject)}
        onCreated={() => qc.invalidateQueries({ queryKey: ['schedules'] })}
      />

      <ScheduleDialog
        open={!!editing}
        onClose={() => setEditing(null)}
        projects={projects.map(toScheduleProject)}
        onCreated={() => qc.invalidateQueries({ queryKey: ['schedules'] })}
        initial={editing ? {
          id: editing.id,
          cron: editing.cron,
          projectId: editing.projectId,
          prompt: editing.prompt,
          template: editing.template,
          enabled: editing.enabled,
          model: editing.model,
          effort: editing.effort,
          useTmux: editing.useTmux,
        } : undefined}
      />
    </div>
  )
}
