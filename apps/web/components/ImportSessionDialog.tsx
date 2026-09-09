'use client'

import { useState, useEffect, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/fetcher'
import { Button } from '@/components/ui/button'
import { useHeadlessEnabled } from '@/lib/server-config'
import { noticeIfCoerced } from '@/lib/notice'
import { X, Loader2, AlertTriangle, Upload, FileArchive, FileText } from 'lucide-react'

interface ProjectSummary {
  id: string
  name: string
  agentType: 'claude' | 'codex' | 'opencode'
  path: string
  configDir?: string
}

interface Props {
  open: boolean
  onClose: () => void
  projects: ProjectSummary[]
}

interface ImportResult {
  id: string
  claudeSessionUuid?: string
  importedFromUuid?: string
  regeneratedUuid?: boolean
  transcriptPath?: string
}

const UUID_RE = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/

export function ImportSessionDialog({ open, onClose, projects }: Props) {
  const router = useRouter()
  const qc = useQueryClient()
  const eligible = projects.filter((p) => p.agentType === 'claude' || p.agentType === 'codex')

  const [projectId, setProjectId] = useState<string>('')
  const [file, setFile] = useState<File | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  // Shown checked, but only SENT once the user touches it. A `.tar.gz`
  // bundle records the mode its session was running in and the server
  // restores that when the field is absent — which the dialog cannot read
  // without unpacking a gzip in the browser, so the choice is deferred
  // rather than guessed. Touch the box and it becomes an explicit override.
  const [useTmux, setUseTmux] = useState(true)
  const [modeTouched, setModeTouched] = useState(false)
  const headlessEnabled = useHeadlessEnabled()

  useEffect(() => {
    if (open) {
      setProjectId(eligible[0]?.id ?? '')
      setFile(null)
      setUseTmux(true)
      setModeTouched(false)
      if (inputRef.current) inputRef.current.value = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const currentProject = eligible.find((p) => p.id === projectId)

  // Best-effort filename parsing so the UI can preview what the server will
  // detect (harness + source UUID). Purely cosmetic — server re-derives from
  // file content on submit.
  const parsedHint = (() => {
    if (!file) return null
    const isTarGz = file.name.endsWith('.tar.gz') || file.name.endsWith('.tgz')
    const isJsonl = file.name.endsWith('.jsonl')
    const format: 'jsonl' | 'tar.gz' | 'unknown' = isTarGz ? 'tar.gz' : (isJsonl ? 'jsonl' : 'unknown')
    let harness: 'claude' | 'codex' | 'unknown' = 'unknown'
    if (file.name.includes('orchestron-claude-')) harness = 'claude'
    else if (file.name.includes('orchestron-codex-')) harness = 'codex'
    const m = file.name.match(UUID_RE)
    return { format, harness, uuid: m?.[1] ?? null }
  })()

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!file || !projectId) throw new Error('missing input')
      const fd = new FormData()
      fd.append('projectId', projectId)
      fd.append('file', file, file.name)
      // Omitted unless the user actually chose, so an untouched dialog lets
      // the bundle's own mode win. Omitted outright while the switch is off:
      // the control is not rendered, so there is no choice to transmit.
      if (headlessEnabled && modeTouched) fd.append('useTmux', String(useTmux))
      const res = await apiFetch(`/api/sessions/import`, { method: 'POST', body: fd })
      if (!res.ok) {
        const text = await res.text()
        try {
          const j = JSON.parse(text) as { error?: string }
          throw new Error(j.error ?? text)
        } catch {
          throw new Error(text || `HTTP ${res.status}`)
        }
      }
      const imported = await res.json() as ImportResult
      noticeIfCoerced(imported)
      return imported
    },
    onSuccess: (session) => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      onClose()
      router.push(`/session/${session.id}`)
    },
  })

  if (!open) return null

  const canSubmit = !!projectId && !!file && !importMutation.isPending
  const harnessMismatch = parsedHint?.harness && parsedHint.harness !== 'unknown'
    && currentProject && parsedHint.harness !== currentProject.agentType

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div className="w-full max-w-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Upload className="w-4 h-4 text-sky-600 dark:text-sky-400" />
            <h2 className="text-base font-semibold">Import session bundle</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Restore a harness session exported from another orchestron host. Accepted formats:
            {' '}<code className="text-[11px] px-1 bg-zinc-100 dark:bg-zinc-800 rounded">.jsonl</code>
            {' '}(claude / codex-exec) or
            {' '}<code className="text-[11px] px-1 bg-zinc-100 dark:bg-zinc-800 rounded">.tar.gz</code>
            {' '}(codex TUI SQLite dump). The transcript is written to the destination project&apos;s
            config dir, then adopted as a fresh orchestron session. UUID collisions are auto-resolved.
          </p>

          <div>
            <label className="text-xs font-medium block mb-1 text-zinc-700 dark:text-zinc-300">Destination project</label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              disabled={importMutation.isPending}
              className="w-full px-3 py-2 text-sm bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded focus:outline-none focus:ring-2 focus:ring-sky-500"
            >
              {eligible.length === 0 && <option value="">— no eligible projects —</option>}
              {eligible.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {currentProject && (() => {
            const isClaudish = currentProject.agentType === 'claude'
            const cfgEnvName = isClaudish ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
            const cfgDefault = isClaudish ? '~/.claude' : '~/.codex'
            const effectiveCfg = currentProject.configDir ?? cfgDefault
            const usingDefault = !currentProject.configDir
            return (
              <div className="text-xs text-zinc-500 dark:text-zinc-400 space-y-0.5 font-mono">
                <div>agent: <span className="text-zinc-800 dark:text-zinc-200">{currentProject.agentType}</span></div>
                <div className="break-all">workspace: <span className="text-zinc-800 dark:text-zinc-200">{currentProject.path}</span></div>
                <div className="break-all" title={`Set via project.agentConfig.env.${cfgEnvName}`}>
                  {cfgEnvName.toLowerCase().replace(/_/g, ' ')}:{' '}
                  <span className="text-zinc-800 dark:text-zinc-200">{effectiveCfg}</span>
                  {usingDefault && (
                    <span className="text-zinc-400 italic ml-1">(harness default)</span>
                  )}
                </div>
              </div>
            )
          })()}

          <div>
            <label className="text-xs font-medium block mb-1 text-zinc-700 dark:text-zinc-300">
              Bundle file
            </label>
            <input
              ref={inputRef}
              type="file"
              accept=".jsonl,.tar.gz,.tgz,application/x-ndjson,application/gzip"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              disabled={importMutation.isPending}
              className="block w-full text-xs text-zinc-700 dark:text-zinc-300 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:text-xs file:font-medium file:bg-sky-50 dark:file:bg-sky-950 file:text-sky-700 dark:file:text-sky-300 hover:file:bg-sky-100 dark:hover:file:bg-sky-900"
            />
            {file && parsedHint && (
              <div className="mt-2 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 px-3 py-2 text-[11px] font-mono space-y-0.5">
                <div className="flex items-center gap-1.5 text-zinc-700 dark:text-zinc-300">
                  {parsedHint.format === 'tar.gz'
                    ? <FileArchive className="w-3 h-3" />
                    : <FileText className="w-3 h-3" />}
                  <span className="truncate">{file.name}</span>
                  <span className="text-zinc-400 ml-auto shrink-0">{Math.round(file.size / 1024)} KB</span>
                </div>
                <div className="text-zinc-500 dark:text-zinc-400 space-y-0.5">
                  <div>format: <span className="text-zinc-700 dark:text-zinc-300">{parsedHint.format}</span></div>
                  <div>
                    detected harness:{' '}
                    <span className="text-zinc-700 dark:text-zinc-300">
                      {parsedHint.harness === 'unknown' ? '(server will detect)' : parsedHint.harness}
                    </span>
                  </div>
                  {parsedHint.uuid && (
                    <div className="break-all">source uuid: <span className="text-zinc-700 dark:text-zinc-300">{parsedHint.uuid}</span></div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Run mode. Hidden while the global switch is off, on the same
              rule as every other "Use tmux" control. The hint changes with
              the bundle format because what "leave it alone" means changes
              with it: a tar.gz carries the source mode, a raw jsonl does
              not. */}
          {headlessEnabled && (
            <div>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useTmux}
                  disabled={importMutation.isPending}
                  onChange={(e) => { setUseTmux(e.target.checked); setModeTouched(true) }}
                  className="mt-0.5 w-4 h-4 rounded border-zinc-300 dark:border-zinc-700 accent-sky-600 disabled:opacity-60"
                />
                <span>
                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Use tmux</span>
                  <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">
                    {useTmux
                      ? 'Restores into an interactive tmux session — live transcript, attach, sleeps when idle.'
                      : `Restores headless: nothing starts until you send a message, and each turn then runs as its own ${currentProject?.agentType === 'codex' ? 'codex exec' : 'claude -p'} process.`}
                    {!modeTouched && (
                      parsedHint?.format === 'tar.gz'
                        ? <span className="block italic">Untouched, a bundle that recorded its own mode is restored in that one instead.</span>
                        : <span className="block italic">A .jsonl bundle records no mode, so this is the choice that applies.</span>
                    )}
                  </span>
                </span>
              </label>
            </div>
          )}

          {harnessMismatch && (
            <div className="rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                Bundle looks like <code className="font-mono">{parsedHint?.harness}</code> but the
                destination project is <code className="font-mono">{currentProject?.agentType}</code>.
                The server will reject with 409.
              </span>
            </div>
          )}

          {importMutation.error && (
            <div className="rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {(importMutation.error as Error).message}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={importMutation.isPending}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => importMutation.mutate()} disabled={!canSubmit}>
            {importMutation.isPending ? (
              <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Importing…</>
            ) : (
              <>Import session</>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
