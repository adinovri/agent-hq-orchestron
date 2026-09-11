'use client'

import { useState, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { apiFetch } from '@/lib/fetcher'
import { Button } from '@/components/ui/button'
import { useHeadlessEnabled } from '@/lib/server-config'
import { noticeIfCoerced } from '@/lib/notice'
import { X, Loader2, CheckCircle2, AlertTriangle, Import } from 'lucide-react'

interface ProjectSummary {
  id: string
  name: string
  agentType: 'claude' | 'codex' | 'opencode'
  path: string
  /** Effective config dir surfaced from project.agentConfig.env
   *  (CLAUDE_CONFIG_DIR for claude, CODEX_HOME for codex). Falls back to
   *  the harness default when unset so the UI hint stays accurate. */
  configDir?: string
  /** Project's configured run mode. Undefined means the project expresses
   *  no preference, which reads as tmux. */
  defaultUseTmux?: boolean
}

interface Props {
  open: boolean
  onClose: () => void
  projects: ProjectSummary[]
}

interface ValidateResult {
  ok: boolean
  error?: string
  agent?: string
  workspace?: string
  jsonlPath?: string
  warning?: string
}

export function AdoptSessionDialog({ open, onClose, projects }: Props) {
  const router = useRouter()
  const qc = useQueryClient()
  const eligible = projects.filter((p) => p.agentType === 'claude' || p.agentType === 'codex')

  const [projectId, setProjectId] = useState<string>('')
  const [uuid, setUuid] = useState<string>('')
  const [validation, setValidation] = useState<ValidateResult | null>(null)
  const [validating, setValidating] = useState(false)
  // null = untouched, so the selected project's default shows through and
  // keeps updating if the user switches project. Same shape as the spawn
  // dialog: derived rather than mirrored into state via an effect, so there
  // is no cascading render and no stale value. Adopt has no source mode to
  // inherit — the record is created here — so the project's setting is the
  // only default with anything behind it.
  const [useTmuxOverride, setUseTmuxOverride] = useState<boolean | null>(null)
  const headlessEnabled = useHeadlessEnabled()

  useEffect(() => {
    if (open) {
      setProjectId(eligible[0]?.id ?? '')
      setUuid('')
      setValidation(null)
      setUseTmuxOverride(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const currentProject = eligible.find((p) => p.id === projectId)
  // `?? true`: a project with no stored preference means tmux.
  const projectDefaultUseTmux = currentProject?.defaultUseTmux ?? true
  // With the global switch off, tmux is the only reachable value — force it
  // over both the user's override and a headless project default. The
  // checkbox is hidden in that state, so this only feeds the helper text.
  const useTmux = headlessEnabled ? (useTmuxOverride ?? projectDefaultUseTmux) : true

  const doValidate = async () => {
    if (!projectId || !uuid.trim()) {
      setValidation(null)
      return
    }
    setValidating(true)
    try {
      const res = await apiFetch(`/api/sessions/adopt/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId, harnessSessionId: uuid.trim() }),
      })
      const data = (await res.json()) as ValidateResult
      setValidation(data)
    } catch (err) {
      setValidation({ ok: false, error: (err as Error).message })
    } finally {
      setValidating(false)
    }
  }

  const adoptMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`/api/sessions/adopt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Sent only when it differs from the project default, so the
        // project stays the one place the default lives and the server
        // resolves it. Must not use `||` anywhere near this — false is
        // the payload.
        //
        // Omitted outright while the switch is off: the control is not
        // rendered, so there is no user choice to transmit, and letting the
        // server coerce the project's own headless default is what puts
        // `coerced` on the response — which is how the user finds out.
        body: JSON.stringify({
          projectId,
          harnessSessionId: uuid.trim(),
          ...(headlessEnabled && useTmux !== projectDefaultUseTmux ? { useTmux } : {}),
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      const session = await res.json() as { id: string }
      // Raised before the dialog closes, same as the spawn dialog.
      noticeIfCoerced(session)
      return session
    },
    onSuccess: (session) => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      onClose()
      router.push(`/session/${session.id}`)
    },
  })

  if (!open) return null

  const canSubmit = !!projectId && !!uuid.trim() && validation?.ok === true && !adoptMutation.isPending

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Import className="w-4 h-4 text-violet-600 dark:text-violet-400" />
            <h2 className="text-base font-semibold">Adopt existing session</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Import a Claude or Codex session that was started outside orchestron
            (via <code className="text-[11px] px-1 bg-zinc-100 dark:bg-zinc-800 rounded">claude --resume</code>, a background job, etc.)
            into a new orchestron record. Confirm no other process is still resuming this session
            or the transcript will race — that holds in either mode, since a headless adopt only
            defers its first resume to your next message.
          </p>

          <div>
            <label className="text-xs font-medium block mb-1 text-zinc-700 dark:text-zinc-300">Project</label>
            <select
              value={projectId}
              onChange={(e) => { setProjectId(e.target.value); setValidation(null) }}
              disabled={adoptMutation.isPending}
              className="w-full px-3 py-2 text-sm bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded focus:outline-none focus:ring-2 focus:ring-violet-500"
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
            // Mangle workspace like Claude does (replace / with -) so the hint
            // path matches the real jsonl location the user should have.
            const mangled = currentProject.path.replace(/\//g, '-')
            const claudeHint = `${effectiveCfg}/projects/${mangled}/<uuid>.jsonl`
            const codexHint = `${effectiveCfg}/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl`
            return (
              <>
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

                <div>
                  <label className="text-xs font-medium block mb-1 text-zinc-700 dark:text-zinc-300">
                    Harness session UUID
                  </label>
                  <input
                    type="text"
                    autoFocus
                    value={uuid}
                    onChange={(e) => { setUuid(e.target.value); setValidation(null) }}
                    onBlur={doValidate}
                    disabled={adoptMutation.isPending}
                    placeholder="e.g. 45b75ffc-156f-45f9-bf7f-77083b07af16"
                    className="w-full px-3 py-2 text-sm font-mono bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded focus:outline-none focus:ring-2 focus:ring-violet-500"
                  />
                  <p className="mt-1 text-[10px] text-zinc-500 break-all">
                    Expected transcript at{' '}
                    <code className="text-zinc-600 dark:text-zinc-400">{isClaudish ? claudeHint : codexHint}</code>
                  </p>
                </div>
              </>
            )
          })()}

          {!currentProject && (
            <div>
              <label className="text-xs font-medium block mb-1 text-zinc-700 dark:text-zinc-300">
                Harness session UUID
              </label>
              <input
                type="text"
                disabled
                placeholder="Pick a project first"
                className="w-full px-3 py-2 text-sm font-mono bg-zinc-50 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded opacity-60"
              />
            </div>
          )}

          {/* Run mode. Hidden while the global switch is off, on the same
              rule as every other "Use tmux" control: headless is
              unavailable, the server coerces regardless, and a
              checked-and-disabled box only invites the question of what it
              would have done. */}
          {headlessEnabled && (
            <div>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useTmux}
                  disabled={adoptMutation.isPending}
                  onChange={(e) => setUseTmuxOverride(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-zinc-300 dark:border-zinc-700 accent-violet-600 disabled:opacity-60"
                />
                <span>
                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Use tmux</span>
                  <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">
                    {useTmux
                      ? 'Resumes now in an interactive tmux session — live transcript, attach, sleeps when idle.'
                      : `Adopts headless: nothing starts until you send a message, and each turn then runs as its own ${currentProject?.agentType === 'codex' ? 'codex exec' : 'claude -p'} process.`}
                    <span className="block italic">
                      {useTmux !== projectDefaultUseTmux
                        ? 'Overrides the project default.'
                        : 'Follows the project default. The source session’s own mode does not constrain it — one transcript store, read the same way by both.'}
                    </span>
                  </span>
                </span>
              </label>
            </div>
          )}

          {validating && (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <Loader2 className="w-3 h-3 animate-spin" /> validating…
            </div>
          )}

          {validation && !validating && (
            validation.ok ? (
              <div className="rounded border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 px-3 py-2 text-xs">
                <div className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300 font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Session found — ready to adopt
                </div>
                {validation.jsonlPath && (
                  <div className="mt-1 font-mono text-[11px] text-zinc-600 dark:text-zinc-400 break-all">
                    transcript: {validation.jsonlPath}
                  </div>
                )}
                {validation.warning && (
                  <div className="mt-1 text-amber-700 dark:text-amber-400 flex items-start gap-1">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                    <span>{validation.warning}</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-xs">
                <div className="flex items-start gap-2 text-red-700 dark:text-red-300">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{validation.error ?? 'Validation failed'}</span>
                </div>
              </div>
            )
          )}

          {adoptMutation.error && (
            <div className="rounded border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-3 py-2 text-xs text-red-700 dark:text-red-300">
              {(adoptMutation.error as Error).message}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={adoptMutation.isPending}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => adoptMutation.mutate()} disabled={!canSubmit}>
            {adoptMutation.isPending ? (
              <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Adopting…</>
            ) : (
              <>Adopt session</>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
