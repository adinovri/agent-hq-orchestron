'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { fetchJson } from '@/lib/fetcher'
import { X } from 'lucide-react'

interface TemplateInfo {
  name: string
  description?: string
  variables?: Record<string, { type: string; required: boolean; prompt?: string; default?: string | number | boolean }>
}

interface Props {
  open: boolean
  onClose: () => void
  projects: Array<{ id: string; name: string }>
  templates: TemplateInfo[]
  onSpawned: () => void
}

export function SpawnDialog({ open, onClose, projects, templates, onSpawned }: Props) {
  const [projectId, setProjectId] = useState('')
  const [template, setTemplate] = useState('')
  const [prompt, setPrompt] = useState('')
  const [vars, setVars] = useState<Record<string, string>>({})
  const [spawning, setSpawning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedTemplate = templates.find((t) => t.name === template)
  const varSpec = selectedTemplate?.variables ?? {}

  // Auto-select first project when opening if only one exists
  useEffect(() => {
    if (open && !projectId && projects.length === 1) {
      setProjectId(projects[0]!.id)
    }
  }, [open, projectId, projects])

  // Reset state when closing
  useEffect(() => {
    if (!open) {
      setError(null)
    }
  }, [open])

  // Body scroll lock while open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
      return () => { document.body.style.overflow = '' }
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  async function handleSpawn() {
    if (!projectId) { setError('Select a project'); return }
    if (!prompt.trim() && !template) { setError('Enter a prompt or select a template'); return }
    setSpawning(true)
    setError(null)
    try {
      await fetchJson('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          prompt: prompt || undefined,
          template: template || undefined,
          vars: Object.keys(vars).length > 0 ? vars : undefined,
        }),
      })
      // Clear + close
      setPrompt('')
      setTemplate('')
      setVars({})
      onSpawned()
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSpawning(false)
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
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Spawn New Session</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-4 space-y-4">
          {/* Project */}
          <div>
            <label className="text-sm font-medium block mb-1 text-zinc-700 dark:text-zinc-300">Project</label>
            {projects.length === 0 ? (
              <p className="text-sm text-zinc-500">
                No projects registered.{' '}
                <a href="/projects" className="underline text-blue-600 hover:text-blue-700" onClick={onClose}>
                  Register a project first →
                </a>
              </p>
            ) : (
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full h-9 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-400"
              >
                <option value="">Select project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Template (only if any exist) */}
          {templates.length > 0 && (
            <div>
              <label className="text-sm font-medium block mb-1 text-zinc-700 dark:text-zinc-300">Template (optional)</label>
              <select
                value={template}
                onChange={(e) => { setTemplate(e.target.value); setVars({}) }}
                className="w-full h-9 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100"
              >
                <option value="">None — use prompt directly</option>
                {templates.map((t) => (
                  <option key={t.name} value={t.name}>{t.name}{t.description ? ` — ${t.description}` : ''}</option>
                ))}
              </select>
            </div>
          )}

          {/* Template variables */}
          {Object.entries(varSpec).map(([key, spec]) => (
            <div key={key}>
              <label className="text-sm font-medium block mb-1 text-zinc-700 dark:text-zinc-300">
                {spec.prompt ?? key}
                {spec.required && <span className="text-red-500 ml-1">*</span>}
              </label>
              <input
                type="text"
                placeholder={String(spec.default ?? '')}
                value={vars[key] ?? ''}
                onChange={(e) => setVars({ ...vars, [key]: e.target.value })}
                className="w-full h-9 px-3 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100"
              />
            </div>
          ))}

          {/* Prompt */}
          <div>
            <label className="text-sm font-medium block mb-1 text-zinc-700 dark:text-zinc-300">
              {template ? 'Additional prompt (appended to template)' : 'Prompt'}
            </label>
            <textarea
              rows={5}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the task Claude should work on…"
              autoFocus
              className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100 resize-none focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            <p className="text-[10px] text-zinc-400 mt-1">
              {prompt.length} chars
            </p>
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded p-2">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950">
          <Button variant="outline" onClick={onClose} disabled={spawning}>Cancel</Button>
          <Button onClick={handleSpawn} disabled={spawning || !projectId || (!prompt.trim() && !template)}>
            {spawning ? 'Spawning…' : 'Spawn'}
          </Button>
        </div>
      </div>
    </div>
  )
}
