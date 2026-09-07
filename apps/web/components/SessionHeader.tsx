'use client'

import { SessionMetadata } from '@agent-hq-orchestron/shared'
import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/StatusPill'
import { isActive } from '@/lib/status'
import { formatRelative, formatDuration } from '@/lib/time'
import { X, Check, GitBranch, ChevronDown, ChevronUp, Play, GitFork, RotateCcw, Copy, ClipboardCheck } from 'lucide-react'
import { useState } from 'react'
import { implicitDefaultModel, implicitDefaultEffort } from '@/lib/models'

interface Props {
  session: SessionMetadata
  descendantCount?: number
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

export function SessionHeader({ session, descendantCount, readOnly, onKill, onArchive, onReopen, onClone, onRespawn, killing, archiving, reopening, cloning, respawning, projectName, projectPath, projectDefaultModel, projectDefaultEffort }: Props) {
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
                <span className="inline-flex items-center gap-1 text-xs text-zinc-500">
                  <GitBranch className="w-3 h-3" />
                  {descendantCount}
                </span>
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
            {expanded && (
              <div className="mt-2 text-xs text-zinc-500 dark:text-zinc-400 space-y-0.5 font-mono break-all">
                <div>
                  id: {session.id}
                  <CopyButton value={session.id} label="session id" />
                </div>
                <div>project: {projectName ?? session.projectId}</div>
                <div>agent: {session.agentType}</div>
                {session.claudeSessionUuid && (() => {
                  const resumeCmd = session.agentType === 'codex'
                    ? `codex resume ${session.claudeSessionUuid}`
                    : `claude --resume ${session.claudeSessionUuid}`
                  return (
                    <>
                      <div title={`Resume: ${resumeCmd}`}>
                        {session.agentType} session: {session.claudeSessionUuid}
                        <CopyButton value={session.claudeSessionUuid} label="harness session id" />
                      </div>
                      <div title="Full resume command">
                        resume: <span className="text-zinc-600 dark:text-zinc-300">{resumeCmd}</span>
                        <CopyButton value={resumeCmd} label="resume command" />
                      </div>
                    </>
                  )
                })()}
                {projectPath && (
                  <div title="Workspace directory — cd here before running the resume command">
                    workspace: {projectPath}
                    <CopyButton value={projectPath} label="workspace path" />
                  </div>
                )}
                {session.tmuxName && (() => {
                  const attachCmd = `tmux attach -rt ${session.tmuxName}`
                  return (
                    <>
                      <div title={`Attach read-only: ${attachCmd}`}>
                        tmux: {session.tmuxName}
                        <CopyButton value={session.tmuxName} label="tmux name" />
                      </div>
                      <div title="Full read-only attach command">
                        attach: <span className="text-zinc-600 dark:text-zinc-300">{attachCmd}</span>
                        <CopyButton value={attachCmd} label="attach command" />
                      </div>
                    </>
                  )
                })()}
                <div>started: {new Date(session.startedAt).toLocaleString()}</div>
                {session.endedAt && <div>ended: {new Date(session.endedAt).toLocaleString()}</div>}
                {session.costUsd != null && <div>cost: ${session.costUsd.toFixed(4)}</div>}
              </div>
            )}
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
                  title="Reopen session — resume with same context"
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
                  title="Clone/fork — new session inheriting this conversation"
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
                  title="Respawn — fresh Claude session with the same prompt (does NOT continue the previous conversation)"
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
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
