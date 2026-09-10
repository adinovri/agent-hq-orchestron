'use client'

import { SessionMetadata } from '@agent-hq-orchestron/shared'
import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/StatusPill'
import { isActive } from '@/lib/status'
import { formatRelative, formatDuration } from '@/lib/time'
import { X, Check, GitBranch, ChevronDown, ChevronUp, Play, GitFork, RotateCcw, Copy, ClipboardCheck, Trash2, Download, Loader2, Pencil, Zap } from 'lucide-react'
import { useState } from 'react'
import { implicitDefaultModel, implicitDefaultEffort } from '@/lib/models'
import { apiFetch } from '@/lib/fetcher'
import { useHeadlessBadgeVisible } from '@/lib/server-config'
import { buildSessionDetailSections } from '@/lib/session-details'

interface Props {
  session: SessionMetadata
  descendantCount?: number
  /** Prompt preview of the parent session (first N chars of its
   *  initialPrompt). Rendered as hover title on the parent chip so
   *  the user has context without leaving the page. */
  parentPrompt?: string
  readOnly?: boolean
  onKill: () => void
  onArchive?: () => void
  onReopen?: () => void
  onClone?: () => void
  onRespawn?: () => void
  killing: boolean
  archiving?: boolean
  reopening?: boolean
  cloning?: boolean
  respawning?: boolean
  projectName?: string
  projectPath?: string
  projectDefaultModel?: string
  projectDefaultEffort?: string
  onDeleteRecord?: () => void
  deletingRecord?: boolean
  onEditMetadata?: () => void
}

/** Tiny copy-to-clipboard button. Renders as a low-contrast icon that
 *  briefly swaps to a checkmark after copy so mobile users get feedback
 *  without a toast. Falls back silently on non-secure contexts. */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      // clipboard API needs secure context — silently no-op
    }
  }
  return (
    <button
      onClick={onClick}
      title={`Copy ${label}`}
      className="inline-flex items-center justify-center w-4 h-4 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition align-middle ml-1"
    >
      {copied ? <ClipboardCheck className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
    </button>
  )
}

/** Auth-aware download for the session export endpoint. A plain <a href>
 *  triggers browser navigation without the Bearer token → API 401 page.
 *  We fetch as a blob, then trigger a synthetic anchor click so the
 *  browser's save-file UI still runs. */
function ExportButton({ sessionId }: { sessionId: string }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const onClick = async () => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}/export`)
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(text || `HTTP ${res.status}`)
      }
      // Filename from Content-Disposition (RFC 6266 form: attachment; filename="...").
      const cd = res.headers.get('content-disposition') ?? ''
      const m = cd.match(/filename\s*=\s*"?([^";]+)"?/i)
      const fallbackExt = (res.headers.get('content-type') ?? '').includes('gzip') ? '.tar.gz' : '.jsonl'
      const name = m?.[1] ?? `orchestron-session-${sessionId}${fallbackExt}`
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    } catch (e) {
      setErr((e as Error).message ?? 'download failed')
      setTimeout(() => setErr(null), 4000)
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={err ?? 'Export session bundle (jsonl or tar.gz) — import into another orchestron host with the Import button'}
      className={`inline-flex items-center justify-center h-8 w-8 rounded transition ${
        err
          ? 'text-red-600 hover:bg-red-50 dark:hover:bg-red-950'
          : 'text-sky-600 hover:text-sky-700 hover:bg-sky-50 dark:hover:bg-sky-950'
      } disabled:opacity-50`}
    >
      {busy
        ? <Loader2 className="w-4 h-4 animate-spin" />
        : <Download className="w-4 h-4" />}
    </button>
  )
}

export function SessionHeader({ session, descendantCount, parentPrompt, readOnly, onKill, onArchive, onReopen, onClone, onRespawn, onDeleteRecord, onEditMetadata, killing, archiving, reopening, cloning, respawning, deletingRecord, projectName, projectPath, projectDefaultModel, projectDefaultEffort }: Props) {
  const harnessDefaultModel = implicitDefaultModel(session.agentType)
  const harnessDefaultEffort = implicitDefaultEffort(session.agentType)
  const effectiveModel = session.model ?? projectDefaultModel ?? harnessDefaultModel
  const effectiveEffort = session.effort ?? projectDefaultEffort ?? harnessDefaultEffort
  const modelFromProject = !session.model && !!projectDefaultModel
  const modelFromHarness = !session.model && !projectDefaultModel && !!harnessDefaultModel
  const effortFromProject = !session.effort && !!projectDefaultEffort
  const effortFromHarness = !session.effort && !projectDefaultEffort && !!harnessDefaultEffort
  const active = isActive(session.status)
  const canArchive = ['needs_input', 'idle', 'waiting', 'running', 'sleeping'].includes(session.status)
  // Reopen + Fork are for truly-done sessions only.
  // - Sleeping is excluded from Reopen because the wake-on-input flow
  //   already spawns a fresh tmux transparently; Reopen would be redundant.
  // - Sleeping is excluded from Fork because a later wake of the parent
  //   would spawn a second tmux writing to the same JSONL as the fork
  //   (both share claudeSessionUuid). Terminal-only is the safe rule.
  const TERMINAL = ['succeeded', 'killed', 'failed'] as const
  const isTerminal = TERMINAL.includes(session.status as (typeof TERMINAL)[number])
  // Reopen + Fork both need the Claude JSONL to exist so `claude --resume`
  // has something to load. hasTranscript is populated by the API; undefined
  // means the check wasn't done (older list responses) — default to true so
  // the buttons don't disappear silently for older API versions.
  const hasTranscript = session.hasTranscript !== false
  // Reopen + Fork are available whatever mode the session ran in — both
  // directions of the tmux/headless jump resume cleanly on both harnesses,
  // and the dialog's "Use tmux" checkbox is where the target mode is picked.
  // `?? true` — sessions predating the toggle are tmux sessions.
  // Badge visibility is a separate question from the record's mode: the
  // global switch hides the badge on a terminal session, but Reopen and
  // Fork are no longer gated on mode at all — both directions of the
  // tmux/headless jump resume cleanly, and the dialog's "Use tmux"
  // checkbox is where the target mode is picked.
  const showHeadlessBadge = useHeadlessBadgeVisible(session.useTmux, session.status)
  const canReopen = isTerminal && hasTranscript
  const canClone = isTerminal && hasTranscript
  // Respawn always available on terminal — doesn't need the old JSONL.
  const canRespawn = isTerminal
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
      {readOnly && (
        <div className="mx-3 mt-3 px-3 py-2 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded text-xs text-amber-800 dark:text-amber-200">
          Snapshot mode — transcript is read-only
        </div>
      )}
      <div className="px-3 sm:px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <StatusPill status={session.status} />
              {projectName && (
                <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300">
                  {projectName}
                </span>
              )}
              <span
                className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-mono uppercase bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300"
                title={`Agent harness: ${session.agentType}`}
              >
                {session.agentType}
              </span>
              {showHeadlessBadge && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-mono uppercase bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                  title={`Headless session — each turn runs as its own ${session.agentType === 'codex' ? 'codex exec' : 'claude -p'} process, with no tmux. Takes follow-up input and rests in idle between turns, then sleeps once left alone — symbolically, since it holds nothing to release. No live TUI to attach to.`}
                >
                  <Zap className="w-3 h-3" />
                  headless
                </span>
              )}
              {effectiveModel && (
                <span
                  className={`text-xs font-mono ${modelFromProject || modelFromHarness ? 'text-zinc-400 dark:text-zinc-500 italic' : 'text-zinc-500 dark:text-zinc-400'}`}
                  title={
                    modelFromHarness ? `harness default (${session.agentType})`
                    : modelFromProject ? 'inherited from project default'
                    : undefined
                  }
                >
                  {effectiveModel}
                </span>
              )}
              {effectiveEffort && (
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded font-mono uppercase ${
                    effortFromProject || effortFromHarness
                      ? 'bg-zinc-50 dark:bg-zinc-900 text-zinc-400 dark:text-zinc-500 italic'
                      : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'
                  }`}
                  title={
                    effortFromHarness ? `harness default (${session.agentType})`
                    : effortFromProject ? 'inherited from project default'
                    : undefined
                  }
                >
                  effort:{effectiveEffort}
                </span>
              )}
              {/* Pencil to patch model+effort — only when tmux is dead
               *  (terminal or sleeping). Server also enforces this, but
               *  hiding here keeps the UX clean. */}
              {/* Editable whenever nothing live is bound to the current
                *  values: terminal or sleeping for tmux, plus idle /
                *  needs_input for headless, which holds no process between
                *  turns. Without the second case the pencil would be
                *  unreachable for the whole life of a headless session.
                *  Server enforces the same rule. (A headless session reaches
                *  `sleeping` too, and is covered by the first case — the
                *  dialog locks the mode control there, not the pencil.) */}
              {onEditMetadata && !readOnly && (
                ['succeeded', 'killed', 'failed', 'sleeping'].includes(session.status) ||
                (!(session.useTmux ?? true) && ['idle', 'needs_input'].includes(session.status))
              ) && (
                <button
                  onClick={onEditMetadata}
                  className="inline-flex items-center justify-center w-5 h-5 rounded text-zinc-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 transition"
                  title="Edit model / effort — applies on next spawn"
                >
                  <Pencil className="w-3 h-3" />
                </button>
              )}
              {session.idleSince && (session.status === 'idle' || session.status === 'needs_input') && (() => {
                const idleMs = Date.now() - new Date(session.idleSince).getTime()
                const idleMin = Math.floor(idleMs / 60_000)
                // Threshold match: idleTimeoutMs default 15 min. Warn at >=10 min.
                const nearSleep = idleMin >= 10
                return (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                      nearSleep
                        ? 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300'
                        : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400'
                    }`}
                    title={`Idle since ${new Date(session.idleSince).toLocaleTimeString()}. Auto-sleeps at 15 min.`}
                  >
                    idle {idleMin}m
                  </span>
                )
              })()}
              {descendantCount != null && descendantCount > 0 && (
                <span
                  className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                  title={`${descendantCount} direct child ${descendantCount === 1 ? 'agent' : 'agents'} spawned — see menu Graph for tree view`}
                >
                  <GitBranch className="w-3 h-3" />
                  {descendantCount}
                </span>
              )}
              {session.parentSessionId && (
                <a
                  href={`/session/${session.parentSessionId}`}
                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200 dark:hover:bg-zinc-700 transition"
                  title={
                    parentPrompt
                      ? `Child of parent session ${session.parentSessionId} — "${parentPrompt}"`
                      : `Child of parent session ${session.parentSessionId}`
                  }
                >
                  <GitBranch className="w-3 h-3 rotate-180" />
                  parent: {session.parentSessionId.slice(0, 8)}
                </a>
              )}
            </div>
            <p className="mt-2 text-sm text-zinc-800 dark:text-zinc-200 line-clamp-2 leading-snug">
              {session.initialPrompt || <span className="italic text-zinc-400">no prompt</span>}
            </p>
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-1.5 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
            >
              <span>{formatRelative(session.startedAt)} · {formatDuration(session.startedAt, session.endedAt)}</span>
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
          </div>
          {!readOnly && (
            <div className="flex items-center gap-1 shrink-0">
              {canReopen && onReopen && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950 h-8 w-8 p-0"
                  disabled={reopening}
                  onClick={onReopen}
                  title="Reopen session — resume with same context (the dialog picks tmux or headless)"
                >
                  <Play className="w-4 h-4" />
                </Button>
              )}
              {canClone && onClone && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950 h-8 w-8 p-0"
                  disabled={cloning}
                  onClick={onClone}
                  title="Clone/fork — new session inheriting this conversation (the dialog picks tmux or headless)"
                >
                  <GitFork className="w-4 h-4" />
                </Button>
              )}
              {canRespawn && onRespawn && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-orange-600 hover:text-orange-700 hover:bg-orange-50 dark:hover:bg-orange-950 h-8 w-8 p-0"
                  disabled={respawning}
                  onClick={onRespawn}
                  title="Respawn — fresh conversation with the same prompt (does NOT continue the previous one)"
                >
                  <RotateCcw className="w-4 h-4" />
                </Button>
              )}
              {canArchive && onArchive && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950 h-8 w-8 p-0"
                  disabled={archiving}
                  onClick={onArchive}
                  title="Mark session as succeeded (archives + kills tmux)"
                >
                  <Check className="w-4 h-4" />
                </Button>
              )}
              {/* Export harness transcript. Auth-aware: fetch as blob so
               *  the Bearer token gets injected — a plain <a href> would
               *  navigate without auth and hit the API's 401 page. Filename
               *  parsed from Content-Disposition, falls back to session id
               *  with the correct extension. */}
              {session.claudeSessionUuid && (
                <ExportButton sessionId={session.id} />
              )}
              {active && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950 h-8 w-8 p-0"
                  disabled={killing}
                  onClick={onKill}
                  title={`Kill session${descendantCount ? ` (${descendantCount} children)` : ''}`}
                >
                  <X className="w-4 h-4" />
                </Button>
              )}
              {/* Delete orchestron record — only for terminal / sleeping. Kill first for active states. */}
              {['succeeded', 'killed', 'failed', 'sleeping'].includes(session.status) && onDeleteRecord && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-700 hover:text-red-800 hover:bg-red-50 dark:hover:bg-red-950 h-8 w-8 p-0"
                  disabled={deletingRecord}
                  onClick={onDeleteRecord}
                  title="Delete orchestron record — harness transcript stays on disk (re-adopt later with same UUID)"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              )}
            </div>
          )}
        </div>
        {/* Full width, and deliberately outside the flex row above: as a
         *  sibling of the action-button column this panel only ever got
         *  `flex-1` of the leftovers, and the column is `shrink-0` at
         *  5 x 32px. On a 390px phone that is 184px of a 334px card spent
         *  on buttons, so every value wrapped at ~20 characters against a
         *  half-empty card. Out here it gets the whole width at every
         *  breakpoint, and the buttons keep their row untouched. */}
        {expanded && (
          <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-800 space-y-3">
            {buildSessionDetailSections({
              session,
              projectName,
              projectPath,
              effectiveModel,
              effectiveEffort,
              modelHint: modelFromHarness ? `harness default (${session.agentType})`
                : modelFromProject ? 'project default'
                : undefined,
              effortHint: effortFromHarness ? `harness default (${session.agentType})`
                : effortFromProject ? 'project default'
                : undefined,
            }).map((section) => (
              // A rule between groups, not just a gap: at `space-y-3` the
              // 12px between sections was the same order as the gap between
              // rows, so the four groups read as one flat list. `pt-3` puts
              // the same 12px on the far side of the rule, which centres it
              // between the groups it divides.
              <section
                key={section.title}
                className="border-t border-zinc-100 pt-3 first:border-0 first:pt-0 dark:border-zinc-800"
              >
                <h3 className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
                  {section.title}
                </h3>
                <dl className="mt-1 space-y-2 sm:space-y-0.5">
                  {section.rows.map((row) => (
                    <div
                      key={row.label}
                      title={row.title}
                      className="sm:grid sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-x-3"
                    >
                      <dt className="text-xs text-zinc-400 dark:text-zinc-500 sm:text-right">
                        {row.label}
                      </dt>
                      <dd className="mt-0.5 sm:mt-0 flex items-start gap-1 min-w-0 text-xs text-zinc-600 dark:text-zinc-300">
                        {/* `flex-1` so the value owns the rest of the row.
                            Sized to its content it left a short value's copy
                            button stranded mid-row and the right half of the
                            panel empty; grown, every button in the panel
                            lands on the same right edge. `min-w-0` is what
                            keeps `break-words` able to wrap a long path.
                            The hint sits inside the growing span rather than
                            beside it — it annotates the value ($0.1234 USD),
                            so pushing it to the right edge would read as a
                            second value, and inline it wraps with the text
                            instead of squeezing it. */}
                        <span className="flex-1 min-w-0 break-words">
                          <span className={row.mono ? 'font-mono' : ''}>{row.value}</span>
                          {row.hint && (
                            <span className="ml-1.5 italic text-zinc-400 dark:text-zinc-500">
                              {row.hint}
                            </span>
                          )}
                        </span>
                        {row.copy && (
                          <CopyButton value={row.copy} label={row.copyLabel ?? row.label} />
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
