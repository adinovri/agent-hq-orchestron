'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AgentType, EffortLevel } from '@agent-hq-orchestron/shared'
import { modelsFor, effortsFor } from '@/lib/models'
import { useHeadlessEnabled } from '@/lib/server-config'
import { useDialogDismiss } from '@/lib/use-dialog-dismiss'
import { useFocusReturn } from '@/lib/use-focus-return'
import type { SessionActionKind } from '@/lib/session-action-dialog'
import { DialogError } from '@/components/ui/dialog-error'

const KEEP: { value: ''; label: string } = { value: '', label: '— Default / keep' }

// One definition, in the module that owns the dialog's lifecycle (NF24).
// Re-exported here because every existing caller imports it from the
// component.
export type { SessionActionKind }

interface Props {
  open: boolean
  kind: SessionActionKind
  agentType: AgentType
  currentModel?: string      // session's own model
  currentEffort?: string     // session's own effort
  defaultModel?: string      // project default (fallback display hint)
  defaultEffort?: string
  /** The session's own run mode, as stored. `undefined` means tmux — every
   *  record predating the toggle has no field and they are all tmux. */
  currentUseTmux?: boolean
  onClose: () => void
  onConfirm: (opts: { model?: string; effort?: EffortLevel; prompt?: string; useTmux?: boolean }) => void
  pending?: boolean
  /** Why the last attempt failed. `settleSessionAction` already kept the
   *  dialog open on failure with the form intact; this is the half that was
   *  missing — saying what went wrong (NF27). */
  error?: string | null
}

interface ActionMeta {
  title: string
  hint: string
  confirmLabel: string
  showPrompt: boolean
  /** What ticking / unticking "Use tmux" means for THIS action. Reopen and
   *  Fork resume an existing conversation, so the mode only decides how it
   *  comes back; Respawn starts a fresh one either way. */
  modeHint: (useTmux: boolean, harness: string) => string
}

const ACTION_META: Record<SessionActionKind, ActionMeta> = {
  reopen: {
    title: 'Reopen session',
    hint: 'Continues the same conversation via --resume. Same session id, same context.',
    confirmLabel: 'Reopen',
    showPrompt: false,
    modeHint: (useTmux, harness) => useTmux
      ? 'Comes back in an interactive tmux session — live transcript, attach, sleeps when idle.'
      : `Comes back headless and idle, ready for input. Each turn runs as its own ${harness} process; nothing starts until you send one.`,
  },
  fork: {
    title: 'Fork session',
    hint: 'New orchestron session id, inherits this conversation via --resume. Optional new prompt to seed a divergent path.',
    confirmLabel: 'Fork',
    showPrompt: true,
    modeHint: (useTmux, harness) => useTmux
      ? 'The fork runs in an interactive tmux session.'
      : `The fork runs headless — each turn its own ${harness} process. A prompt below becomes its first turn.`,
  },
  respawn: {
    title: 'Respawn session',
    hint: 'Restarts in-place with a fresh conversation. Same session id, same prompt, previous conversation discarded.',
    confirmLabel: 'Respawn',
    showPrompt: false,
    modeHint: (useTmux, harness) => useTmux
      ? 'Restarts in an interactive tmux session.'
      : `Restarts headless — the original prompt runs as one ${harness} process, then the session waits for input.`,
  },
}

export function SessionActionDialog({
  open, kind, agentType, currentModel, currentEffort, defaultModel, defaultEffort, currentUseTmux,
  onClose, onConfirm, pending, error,
}: Props) {
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [prompt, setPrompt] = useState('')
  // `?? true` — a record with no field is a tmux session.
  const sessionUseTmux = currentUseTmux ?? true
  const [useTmux, setUseTmux] = useState(true)
  const headlessEnabled = useHeadlessEnabled()

  useEffect(() => {
    if (open) {
      setModel(currentModel ?? '')
      setEffort(currentEffort ?? '')
      setPrompt('')
      // Default to the session's CURRENT mode, not to tmux. The action is
      // "bring this session back", so the neutral choice is the one that
      // changes nothing — same principle as the model and effort pickers
      // starting on the session's own values.
      setUseTmux(sessionUseTmux)
    }
  }, [open, currentModel, currentEffort, sessionUseTmux])

  // Same as Cancel, which is disabled while the action is in flight — for
  // Escape, for the backdrop, and for the × alike (NF25).
  const dismiss = useDialogDismiss(open && !pending, onClose)

  // Whatever closed this dialog, focus does not get left on <body> (NF28).
  // The confirm button disables itself while the mutation runs, so the
  // browser has already dropped focus by the time `onSuccess` closes us.
  useFocusReturn(open)

  if (!open) return null

  const meta = ACTION_META[kind]
  const models = [KEEP, ...modelsFor(agentType)]
  const efforts = [KEEP, ...effortsFor(agentType)]
  const hasCuratedModels = models.length > 1
  const inputCls = 'w-full px-3 py-2 text-sm bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded focus:outline-none focus:ring-2 focus:ring-blue-500'

  const inheritedModel = currentModel ?? defaultModel
  const inheritedEffort = currentEffort ?? defaultEffort

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={dismiss.onBackdropClick}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg"
        onClick={dismiss.onPanelClick}
      >
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-base font-semibold">{meta.title}</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{meta.hint}</p>
        </div>

        <div className="px-4 py-3 space-y-3">
          <div>
            <label className="text-xs font-medium block mb-1 text-zinc-700 dark:text-zinc-300">
              Model {inheritedModel && <span className="text-zinc-400 font-normal">(current: {inheritedModel})</span>}
            </label>
            {hasCuratedModels ? (
              <select className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} disabled={pending}>
                {models.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
              </select>
            ) : (
              <input
                type="text"
                className={inputCls}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Leave blank to keep current"
                disabled={pending}
              />
            )}
          </div>

          <div>
            <label className="text-xs font-medium block mb-1 text-zinc-700 dark:text-zinc-300">
              Effort {inheritedEffort && <span className="text-zinc-400 font-normal">(current: {inheritedEffort})</span>}
            </label>
            <select className={inputCls} value={effort} onChange={(e) => setEffort(e.target.value)} disabled={pending}>
              {efforts.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </div>

          {/* Run mode. Same control as the spawn dialog, and hidden on the
            * same rule: with headless disabled globally there is one mode
            * left, and the session comes back in tmux whatever this said.
            * The server raises a toast when that coercion happens, so the
            * outcome is still announced — just not pre-announced by a
            * control offering a choice with no consequence. */}
          {headlessEnabled && (
            <div>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useTmux}
                  disabled={pending}
                  onChange={(e) => setUseTmux(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-zinc-300 dark:border-zinc-700 accent-blue-600 disabled:opacity-60"
                />
                <span>
                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Use tmux</span>
                  <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">
                    {meta.modeHint(useTmux, agentType === 'codex' ? 'codex exec' : 'claude -p')}
                    {useTmux !== sessionUseTmux && (
                      <span className="block italic">
                        Switches this session from {sessionUseTmux ? 'tmux to headless' : 'headless to tmux'}.
                      </span>
                    )}
                  </span>
                </span>
              </label>
            </div>
          )}

          {meta.showPrompt && (
            <div>
              <label className="text-xs font-medium block mb-1 text-zinc-700 dark:text-zinc-300">
                Optional new prompt
              </label>
              <textarea
                className={`${inputCls} min-h-[64px] resize-y`}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Leave empty to just re-enter the shared context"
                disabled={pending}
              />
            </div>
          )}
        </div>

        <DialogError message={error} />

        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button
            size="sm"
            onClick={() => onConfirm({
              model: model || undefined,
              effort: (effort as EffortLevel) || undefined,
              prompt: prompt || undefined,
              // Send it only when it actually differs. Omitted means "keep
              // the session's mode" server-side, so an unchanged checkbox
              // must not look like a deliberate override — and while the
              // switch is off the control is not rendered at all, so there
              // is nothing to send and the server does the coercing.
              useTmux: headlessEnabled && useTmux !== sessionUseTmux ? useTmux : undefined,
            })}
            disabled={pending}
          >
            {pending ? `${meta.confirmLabel}…` : meta.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
