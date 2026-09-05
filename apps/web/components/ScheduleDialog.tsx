'use client'

import { useState, useEffect, useMemo } from 'react'
import cronstrue from 'cronstrue'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/fetcher'
import { X, CalendarClock, AlertCircle } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  projects: Array<{ id: string; name: string }>
  onCreated: () => void
  initial?: {
    id: string
    cron: string
    projectId: string
    prompt?: string
    template?: string
  }
}

/**
 * Cheap client-side next-fire simulator for a 5-field cron expression.
 * Not a full cron engine — walks minute-by-minute up to 60 days ahead.
 * Handles: `*`, integers, comma lists `1,15,30`, ranges `1-5`, and
 * step syntax `* /5` `10-30/2`. Field order: min hour dom month dow (0-6, 0=Sun).
 */
function simulateNextFires(expr: string, count: number): Date[] {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return []
  const [min, hour, dom, mon, dow] = parts

  const inField = (val: number, field: string, min: number, max: number): boolean => {
    for (const chunk of field.split(',')) {
      const [range, stepStr] = chunk.split('/')
      const step = stepStr ? parseInt(stepStr, 10) : 1
      if (isNaN(step) || step <= 0) return false

      let lo = min
      let hi = max
      if (range && range !== '*') {
        if (range.includes('-')) {
          const [loStr, hiStr] = range.split('-')
          lo = parseInt(loStr!, 10)
          hi = parseInt(hiStr!, 10)
        } else {
          lo = hi = parseInt(range, 10)
        }
        if (isNaN(lo) || isNaN(hi)) return false
      }
      for (let v = lo; v <= hi; v += step) {
        if (v === val) return true
      }
    }
    return false
  }

  const out: Date[] = []
  const start = new Date(Date.now() + 60_000)
  start.setSeconds(0, 0)
  const end = start.getTime() + 60 * 24 * 60 * 60 * 1000
  const cur = new Date(start)

  while (cur.getTime() < end && out.length < count) {
    const minute = cur.getMinutes()
    const hour24 = cur.getHours()
    const day = cur.getDate()
    const month = cur.getMonth() + 1
    const weekday = cur.getDay()
    if (
      inField(minute, min!, 0, 59) &&
      inField(hour24, hour!, 0, 23) &&
      inField(day, dom!, 1, 31) &&
      inField(month, mon!, 1, 12) &&
      inField(weekday, dow!, 0, 6)
    ) {
      out.push(new Date(cur))
    }
    cur.setMinutes(cur.getMinutes() + 1)
  }
  return out
}

const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Daily at 9 AM', cron: '0 9 * * *' },
  { label: 'Weekdays at 9 AM', cron: '0 9 * * 1-5' },
  { label: 'Weekly (Monday 9 AM)', cron: '0 9 * * 1' },
  { label: 'Monthly (1st, 9 AM)', cron: '0 9 1 * *' },
]

export function ScheduleDialog({ open, onClose, projects, onCreated, initial }: Props) {
  const [projectId, setProjectId] = useState(initial?.projectId ?? '')
  const [cron, setCron] = useState(initial?.cron ?? '0 9 * * 1')
  const [prompt, setPrompt] = useState(initial?.prompt ?? '')
  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isEdit = !!initial?.id

  // Human-readable cron description + next-3-fire preview.
  const cronPreview = useMemo(() => {
    const trimmed = cron.trim()
    if (!trimmed) return { human: '', nextRuns: [] as Date[], error: null as string | null }
    let human = ''
    try {
      human = cronstrue.toString(trimmed, { verbose: false, throwExceptionOnParseError: true })
    } catch (err) {
      return { human: '', nextRuns: [], error: (err as Error).message }
    }
    // Compute next 3 runs client-side using minimal cron next-fire logic.
    // We call cronstrue for humanization + a light forward-walk simulator
    // that steps minute-by-minute up to 60d ahead — good enough for common
    // patterns; UI-only preview so accuracy isn't critical.
    const nextRuns = simulateNextFires(trimmed, 3)
    return { human, nextRuns, error: null }
  }, [cron])

  useEffect(() => {
    if (open && !projectId && projects.length === 1) setProjectId(projects[0]!.id)
  }, [open, projectId, projects])

  useEffect(() => {
    if (!open) { setError(null); return }
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = '' }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  async function handleSave() {
    if (!projectId) { setError('Select a project'); return }
    if (!cron.trim()) { setError('Cron expression required'); return }
    if (!prompt.trim()) { setError('Prompt required'); return }
    setSaving(true)
    setError(null)
    try {
      const payload = { projectId, cron: cron.trim(), prompt: prompt.trim(), enabled }
      const url = isEdit ? `/api/schedules/${initial!.id}` : '/api/schedules'
      const method = isEdit ? 'PATCH' : 'POST'
      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      onCreated()
      onClose()
      setPrompt('')
      setCron('0 9 * * 1')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg bg-white dark:bg-zinc-900 rounded-xl shadow-2xl border border-zinc-200 dark:border-zinc-800 max-h-[calc(100vh-2rem)] overflow-y-auto"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {isEdit ? 'Edit Schedule' : 'New Schedule'}
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-4 space-y-4">
          <div>
            <label className="text-sm font-medium block mb-1 text-zinc-700 dark:text-zinc-300">Project</label>
            {projects.length === 0 ? (
              <p className="text-sm text-zinc-500">
                No projects. <a href="/projects" className="underline text-blue-600" onClick={onClose}>Register first →</a>
              </p>
            ) : (
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full h-9 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100"
              >
                <option value="">Select project…</option>
                {projects.map((p) => (<option key={p.id} value={p.id}>{p.name}</option>))}
              </select>
            )}
          </div>

          <div>
            <label className="text-sm font-medium block mb-1 text-zinc-700 dark:text-zinc-300">Cron expression</label>
            <input
              type="text"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 9 * * 1"
              className="w-full h-9 px-3 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm font-mono text-zinc-900 dark:text-zinc-100"
            />
            <div className="flex flex-wrap gap-1 mt-1.5">
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.cron}
                  type="button"
                  onClick={() => setCron(p.cron)}
                  className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                    cron === p.cron
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-500'
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-zinc-400 mt-1">
              Format: <code>minute hour day-of-month month day-of-week</code>
            </p>

            {/* Cron preview */}
            {cronPreview.error ? (
              <div className="mt-2 flex items-start gap-1.5 rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-2 text-xs text-red-700 dark:text-red-300">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium">Invalid cron expression</div>
                  <div className="text-[11px] opacity-80">{cronPreview.error}</div>
                </div>
              </div>
            ) : cronPreview.human ? (
              <div className="mt-2 rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/30 p-2 text-xs">
                <div className="flex items-start gap-1.5 text-emerald-800 dark:text-emerald-300">
                  <CalendarClock className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{cronPreview.human}</div>
                    {cronPreview.nextRuns.length > 0 && (
                      <div className="mt-1 text-emerald-700 dark:text-emerald-400 text-[11px] space-y-0.5">
                        {cronPreview.nextRuns.map((d, i) => (
                          <div key={i} className="font-mono">
                            {i === 0 ? 'Next: ' : '     · '}{d.toLocaleString()}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div>
            <label className="text-sm font-medium block mb-1 text-zinc-700 dark:text-zinc-300">Prompt</label>
            <textarea
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should Claude do when this schedule fires?"
              className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100 resize-none"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="schedule-enabled"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="w-4 h-4 rounded border-zinc-300"
            />
            <label htmlFor="schedule-enabled" className="text-sm text-zinc-700 dark:text-zinc-300">
              Enabled (fires on cron; disable to pause without deleting)
            </label>
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded p-2">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !projectId || !cron.trim() || !prompt.trim()}>
            {saving ? 'Saving…' : isEdit ? 'Save' : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  )
}
