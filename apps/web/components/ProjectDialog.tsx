'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { fetchJson } from '@/lib/fetcher'
import type { ProjectMetadata } from '@agent-hq-orchestron/shared'

interface Props {
  open: boolean
  onClose: () => void
  project?: ProjectMetadata | null
  onSaved: () => void
}

interface FormState {
  name: string
  path: string
  agentType: 'claude' | 'codex' | 'opencode'
  defaultModel: string
  defaultEffort: string
  claudeConfigDir: string
  group: string
  tags: string
  extraEnvKey: string
  extraEnvVal: string
  extraEnvPairs: Array<{ key: string; value: string }>
  extraArgs: string
}

const BLANK: FormState = {
  name: '',
  path: '',
  agentType: 'claude',
  defaultModel: '',
  defaultEffort: '',
  claudeConfigDir: '',
  group: '',
  tags: '',
  extraEnvKey: '',
  extraEnvVal: '',
  extraEnvPairs: [],
  extraArgs: '',
}

export function ProjectDialog({ open, onClose, project, onSaved }: Props) {
  const [form, setForm] = useState<FormState>(BLANK)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)

  useEffect(() => {
    if (!open) return
    if (project) {
      const env = project.agentConfig?.env ?? {}
      setForm({
        name: project.name,
        path: project.path,
        agentType: project.agentType,
        defaultModel: project.defaultModel ?? '',
        defaultEffort: project.defaultEffort ?? '',
        claudeConfigDir: env['CLAUDE_CONFIG_DIR'] ?? '',
        group: project.group ?? '',
        tags: (project.tags ?? []).join(', '),
        extraEnvKey: '',
        extraEnvVal: '',
        extraEnvPairs: Object.entries(env)
          .filter(([k]) => k !== 'CLAUDE_CONFIG_DIR')
          .map(([key, value]) => ({ key, value })),
        extraArgs: (project.agentConfig?.extraArgs ?? []).join(', '),
      })
    } else {
      setForm(BLANK)
    }
    setError(null)
    setAdvanced(false)
  }, [open, project])

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function addEnvPair() {
    if (!form.extraEnvKey.trim()) return
    setForm((f) => ({
      ...f,
      extraEnvPairs: [...f.extraEnvPairs, { key: f.extraEnvKey.trim(), value: f.extraEnvVal }],
      extraEnvKey: '',
      extraEnvVal: '',
    }))
  }

  function removeEnvPair(i: number) {
    setForm((f) => ({ ...f, extraEnvPairs: f.extraEnvPairs.filter((_, idx) => idx !== i) }))
  }

  async function handleSave() {
    if (!form.name.trim()) { setError('Name is required'); return }
    if (!form.path.trim()) { setError('Path is required'); return }

    setSaving(true)
    setError(null)

    const env: Record<string, string> = {}
    if (form.claudeConfigDir.trim()) env['CLAUDE_CONFIG_DIR'] = form.claudeConfigDir.trim()
    form.extraEnvPairs.forEach(({ key, value }) => { if (key) env[key] = value })

    const agentConfig = {
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(form.extraArgs.trim()
        ? { extraArgs: form.extraArgs.split(',').map((s) => s.trim()).filter(Boolean) }
        : {}),
    }

    const body = {
      name: form.name.trim(),
      path: form.path.trim(),
      agentType: form.agentType,
      ...(form.defaultModel ? { defaultModel: form.defaultModel } : {}),
      ...(form.defaultEffort ? { defaultEffort: form.defaultEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
      group: form.group.trim() || null,
      tags: form.tags.split(',').map((s) => s.trim()).filter(Boolean),
      ...(Object.keys(agentConfig).length > 0 ? { agentConfig } : {}),
    }

    try {
      if (project) {
        await fetchJson(`/api/projects/${project.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } else {
        await fetchJson('/api/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      }
      onSaved()
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const inputCls =
    'w-full h-9 px-3 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm focus:outline-none focus:ring-2 focus:ring-zinc-400'

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{project ? 'Edit Project' : 'Register Project'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <label className="text-sm font-medium block mb-1">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="agent-hq-orchestron"
              className={inputCls}
            />
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">
              Path <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={form.path}
              onChange={(e) => set('path', e.target.value)}
              placeholder="/home/user/Works/my-project"
              className={inputCls}
            />
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">
              Agent Type <span className="text-red-500">*</span>
            </label>
            <select
              value={form.agentType}
              onChange={(e) => set('agentType', e.target.value as FormState['agentType'])}
              className={inputCls}
            >
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="opencode">opencode</option>
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium block mb-1">Default Model</label>
              <select
                value={form.defaultModel}
                onChange={(e) => set('defaultModel', e.target.value)}
                className={inputCls}
              >
                <option value="">— Claude default</option>
                <option value="claude-opus-5">Opus 5</option>
                <option value="claude-sonnet-5">Sonnet 5</option>
                <option value="claude-fable-5-1">Fable 5.1</option>
                <option value="claude-fable-5">Fable 5</option>
                <option value="claude-opus-4-8">Opus 4.8</option>
                <option value="claude-sonnet-4-6">Sonnet 4.6</option>
                <option value="claude-haiku-4-5">Haiku 4.5</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Default Effort</label>
              <select
                value={form.defaultEffort}
                onChange={(e) => set('defaultEffort', e.target.value)}
                className={inputCls}
              >
                <option value="">— Claude default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra high</option>
                <option value="max">Max</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">CLAUDE_CONFIG_DIR</label>
            <input
              type="text"
              value={form.claudeConfigDir}
              onChange={(e) => set('claudeConfigDir', e.target.value)}
              placeholder="~/ClaudeConfigs/adi.novriansyah"
              className={inputCls}
            />
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">Group</label>
            <input
              type="text"
              value={form.group}
              onChange={(e) => set('group', e.target.value)}
              placeholder="backend"
              className={inputCls}
            />
          </div>

          <div>
            <label className="text-sm font-medium block mb-1">Tags (comma-separated)</label>
            <input
              type="text"
              value={form.tags}
              onChange={(e) => set('tags', e.target.value)}
              placeholder="java, spring, nanovest"
              className={inputCls}
            />
          </div>

          {/* Advanced */}
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 flex items-center gap-1"
          >
            <span>{advanced ? '▼' : '▶'}</span> Advanced options
          </button>

          {advanced && (
            <div className="space-y-4 pl-3 border-l-2 border-zinc-200 dark:border-zinc-700">
              {/* Extra env vars */}
              <div>
                <label className="text-sm font-medium block mb-1">Extra env vars</label>
                {form.extraEnvPairs.map((pair, i) => (
                  <div key={i} className="flex gap-2 mb-1 items-center">
                    <span className="text-xs font-mono text-zinc-600 dark:text-zinc-400 flex-1 truncate">
                      {pair.key}={pair.value}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeEnvPair(i)}
                      className="text-xs text-red-500 hover:text-red-700 shrink-0"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <div className="flex gap-2 mt-1">
                  <input
                    type="text"
                    placeholder="KEY"
                    value={form.extraEnvKey}
                    onChange={(e) => set('extraEnvKey', e.target.value)}
                    className="flex-1 h-8 px-2 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-xs font-mono"
                  />
                  <input
                    type="text"
                    placeholder="value"
                    value={form.extraEnvVal}
                    onChange={(e) => set('extraEnvVal', e.target.value)}
                    className="flex-1 h-8 px-2 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-xs"
                  />
                  <button
                    type="button"
                    onClick={addEnvPair}
                    className="h-8 px-2 rounded bg-zinc-100 dark:bg-zinc-800 text-xs"
                  >
                    Add
                  </button>
                </div>
              </div>

              {/* Extra args */}
              <div>
                <label className="text-sm font-medium block mb-1">
                  Extra args (comma-separated)
                </label>
                <input
                  type="text"
                  value={form.extraArgs}
                  onChange={(e) => set('extraArgs', e.target.value)}
                  placeholder="--verbose, --model claude-opus-5"
                  className={inputCls}
                />
              </div>
            </div>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : project ? 'Save Changes' : 'Register'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
