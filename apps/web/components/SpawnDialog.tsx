'use client'

import { useState, useEffect, useRef, DragEvent } from 'react'
import { Button } from '@/components/ui/button'
import { apiFetch, fetchJson } from '@/lib/fetcher'
import { X, Paperclip, FileText, Image as ImageIcon, FileCode, File as FileIcon } from 'lucide-react'

interface AttachedFile {
  id: string
  file: File
  preview?: string
}

function fileIcon(mime: string, name: string) {
  if (mime.startsWith('image/')) return <ImageIcon className="w-4 h-4" />
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|sh|rb|md|json|yaml|yml|toml|html|css)$/i.test(name)) {
    return <FileCode className="w-4 h-4" />
  }
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return <FileText className="w-4 h-4" />
  return <FileIcon className="w-4 h-4" />
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

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

const MODEL_OPTIONS = [
  { value: '', label: 'Default (project setting)' },
  // Latest tier — Claude 5 family
  { value: 'claude-opus-5', label: 'Opus 5 (most capable)' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1 (fast experimental)' },
  { value: 'claude-fable-5', label: 'Fable 5' },
  // Prior generation
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (balanced)' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5 (fast + cheap)' },
]

const EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low (quick answers)' },
  { value: 'medium', label: 'Medium (balanced)' },
  { value: 'high', label: 'High (thorough)' },
  { value: 'xhigh', label: 'Extra high (deep reasoning)' },
  { value: 'max', label: 'Max (heaviest)' },
]

export function SpawnDialog({ open, onClose, projects, templates, onSpawned }: Props) {
  const [projectId, setProjectId] = useState('')
  const [template, setTemplate] = useState('')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [vars, setVars] = useState<Record<string, string>>({})
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [spawning, setSpawning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const addFiles = (files: FileList | File[]) => {
    const arr = Array.from(files)
    if (arr.length === 0) return
    const next: AttachedFile[] = arr.map(f => ({
      id: crypto.randomUUID(),
      file: f,
      preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
    }))
    setAttachments(prev => [...prev, ...next].slice(0, 10))
  }

  const removeFile = (id: string) => {
    setAttachments(prev => {
      const target = prev.find(a => a.id === id)
      if (target?.preview) URL.revokeObjectURL(target.preview)
      return prev.filter(a => a.id !== id)
    })
  }

  // Cleanup preview URLs on close
  useEffect(() => {
    if (!open) {
      attachments.forEach(a => a.preview && URL.revokeObjectURL(a.preview))
      setAttachments([])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

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
    if (!prompt.trim() && !template && attachments.length === 0) {
      setError('Enter a prompt, select a template, or attach files')
      return
    }
    setSpawning(true)
    setError(null)
    try {
      const payload = {
        projectId,
        prompt: prompt || undefined,
        template: template || undefined,
        vars: Object.keys(vars).length > 0 ? vars : undefined,
        model: model || undefined,
        effort: effort || undefined,
      }
      let res: Response
      if (attachments.length > 0) {
        // Multipart — spawn endpoint accepts `body` field as JSON blob + files
        const fd = new FormData()
        fd.append('body', JSON.stringify(payload))
        attachments.forEach(a => fd.append('file', a.file, a.file.name))
        res = await apiFetch('/api/sessions', { method: 'POST', body: fd })
      } else {
        res = await apiFetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      await res.json()
      // Clear + close
      setPrompt('')
      setTemplate('')
      setVars({})
      setModel('')
      setEffort('')
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
              onPaste={(e) => {
                const items = Array.from(e.clipboardData.files)
                if (items.length > 0) { e.preventDefault(); addFiles(items) }
              }}
              placeholder="Describe the task Claude should work on…"
              autoFocus
              className="w-full px-3 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100 resize-none focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
            <p className="text-[10px] text-zinc-400 mt-1">
              {prompt.length} chars · drag/paste/📎 to attach files
            </p>
          </div>

          {/* Model + Effort */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium block mb-1 text-zinc-700 dark:text-zinc-300">Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full h-9 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100"
              >
                {MODEL_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1 text-zinc-700 dark:text-zinc-300">Effort</label>
              <select
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
                className="w-full h-9 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm text-zinc-900 dark:text-zinc-100"
              >
                {EFFORT_OPTIONS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
              </select>
            </div>
          </div>

          {/* Attachments */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e: DragEvent<HTMLDivElement>) => {
              e.preventDefault()
              setDragOver(false)
              if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files)
            }}
            className={`rounded-md border border-dashed p-2 transition-colors ${
              dragOver
                ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/40'
                : 'border-zinc-300 dark:border-zinc-700'
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <label className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Attachments <span className="text-xs text-zinc-400 font-normal">({attachments.length}/10 · max 20MB each)</span>
              </label>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-zinc-300 dark:border-zinc-700"
              >
                <Paperclip className="w-3 h-3" /> Choose
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files)
                  e.target.value = ''
                }}
              />
            </div>
            {attachments.length === 0 ? (
              <p className="text-xs text-zinc-400 dark:text-zinc-500 text-center py-2">
                Drag files here, paste from clipboard, or click Choose
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {attachments.map(a => (
                  <div key={a.id} className="relative inline-flex items-center gap-1.5 pl-1.5 pr-6 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-xs">
                    {a.preview ? (
                      <img src={a.preview} alt={a.file.name} className="w-6 h-6 object-cover rounded" />
                    ) : (
                      <span className="text-zinc-500 dark:text-zinc-400">{fileIcon(a.file.type, a.file.name)}</span>
                    )}
                    <span className="text-zinc-700 dark:text-zinc-300 max-w-[140px] truncate" title={a.file.name}>{a.file.name}</span>
                    <span className="text-zinc-400 text-[10px]">{formatSize(a.file.size)}</span>
                    <button
                      onClick={() => removeFile(a.id)}
                      type="button"
                      className="absolute right-0.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-950 text-zinc-400 hover:text-red-600"
                      title="Remove"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 rounded p-2">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950">
          <Button variant="outline" onClick={onClose} disabled={spawning}>Cancel</Button>
          <Button onClick={handleSpawn} disabled={spawning || !projectId || (!prompt.trim() && !template && attachments.length === 0)}>
            {spawning ? 'Spawning…' : 'Spawn'}
          </Button>
        </div>
      </div>
    </div>
  )
}
