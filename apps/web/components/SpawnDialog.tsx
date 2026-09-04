'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { fetchJson } from '@/lib/fetcher'

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

  async function handleSpawn() {
    if (!projectId) { setError('Select a project'); return }
    setSpawning(true)
    setError(null)
    try {
      await fetchJson('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          initialPrompt: prompt,
          template: template || undefined,
          vars: Object.keys(vars).length > 0 ? vars : undefined,
        }),
      })
      onSpawned()
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSpawning(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Spawn New Session</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Project */}
          <div>
            <label className="text-sm font-medium block mb-1">Project</label>
            {projects.length === 0 ? (
              <p className="text-sm text-zinc-500">
                No projects registered.{' '}
                <a href="/projects" className="underline text-zinc-700 dark:text-zinc-300 hover:text-zinc-900">
                  Register a project first →
                </a>
              </p>
            ) : (
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full h-9 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm"
              >
                <option value="">Select project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Template */}
          <div>
            <label className="text-sm font-medium block mb-1">Template (optional)</label>
            <select
              value={template}
              onChange={(e) => { setTemplate(e.target.value); setVars({}) }}
              className="w-full h-9 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm"
            >
              <option value="">None — use prompt directly</option>
              {templates.map((t) => (
                <option key={t.name} value={t.name}>{t.name}{t.description ? ` — ${t.description}` : ''}</option>
              ))}
            </select>
          </div>

          {/* Template variables */}
          {Object.entries(varSpec).map(([key, spec]) => (
            <div key={key}>
              <label className="text-sm font-medium block mb-1">
                {spec.prompt ?? key}
                {spec.required && <span className="text-red-500 ml-1">*</span>}
              </label>
              <input
                type="text"
                placeholder={String(spec.default ?? '')}
                value={vars[key] ?? ''}
                onChange={(e) => setVars({ ...vars, [key]: e.target.value })}
                className="w-full h-9 px-3 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm"
              />
            </div>
          ))}

          {/* Prompt */}
          <div>
            <label className="text-sm font-medium block mb-1">
              {template ? 'Additional prompt (appended to template)' : 'Prompt'}
            </label>
            <textarea
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe the task…"
              className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={spawning}>Cancel</Button>
          <Button onClick={handleSpawn} disabled={spawning}>
            {spawning ? 'Spawning…' : 'Spawn'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
