'use client'

import { useEffect, useState, useId } from 'react'
import { Button } from '@/components/ui/button'
import type { AgentType, EffortLevel, SessionStatus } from '@agent-hq-orchestron/shared'
import { modelsFor, effortsFor } from '@/lib/models'
import { useHeadlessEnabled } from '@/lib/server-config'
import { useDialogDismiss } from '@/lib/use-dialog-dismiss'
import { useFocusReturn } from '@/lib/use-focus-return'
import { DialogError } from '@/components/ui/dialog-error'

const RESET: { value: ''; label: string } = { value: '', label: '— Reset to project default' }

/** Every resting state of a headless session. Its next turn is delivered by
 *  sendInput rather than by a spawn — including out of `sleeping`, whose
 *  sleep released nothing and whose wake costs no spawn either — so a mode
 *  flip here would never become real. The API refuses it, and this dialog
 *  says so up front rather than letting the user find out at Save.
 *
 *  Only applied to headless records: a sleeping TMUX session really did give
 *  up its window, and waking it does spawn, so its mode stays editable. */
const MODE_LOCKED_STATES: SessionStatus[] = ['idle', 'needs_input', 'sleeping']

interface Props {
  open: boolean
  agentType: AgentType
  status: SessionStatus
  currentModel?: string           // session's own override
  currentEffort?: string
  currentUseTmux?: boolean        // undefined = never set = tmux
  defaultModel?: string           // project default (shown as fallback hint)
  defaultEffort?: string
  pending?: boolean
  /** Why the last save failed. Same contract as the lifecycle dialogs: the
   *  dialog stays open with the form intact, and this says why (NF27). */
  error?: string | null
  onClose: () => void
  onConfirm: (opts: { model?: string; effort?: EffortLevel | ''; useTmux?: boolean }) => void
}

/** Small modal to patch model + effort on a session record. No lifecycle
 *  action — this ONLY writes the metadata, which takes effect on next
 *  spawn (Reopen / Respawn / sleep-wake). Parent must only render this
 *  when session state has no live tmux (terminal or sleeping). */
export function SessionMetadataEditDialog({
  open, agentType, status, currentModel, currentEffort, currentUseTmux, defaultModel, defaultEffort,
  pending, error, onClose, onConfirm,
}: Props) {
  /* Ids for the label/control pairs below. Every `<select>` in this app was
   * labelled only by an adjacent `<label>` with no `for`, so a screen reader
   * announced an unnamed combobox (NF33, axe `select-name`, critical).
   * `useId` rather than a literal: this is a component, and a literal id is a
   * duplicate the moment one is mounted twice — at which point every label
   * silently points at the first copy's control. It is also what keeps the id
   * stable across the server render Next does before hydration. */
  const uid = useId()
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [useTmux, setUseTmux] = useState(true)
  const headlessEnabled = useHeadlessEnabled()

  // `?? true` throughout — a record written before the toggle existed has no
  // field, and those are all tmux sessions.
  const currentUseTmuxResolved = currentUseTmux ?? true

  useEffect(() => {
    if (open) {
      setModel(currentModel ?? '')
      setEffort(currentEffort ?? '')
      setUseTmux(currentUseTmux ?? true)
    }
  }, [open, currentModel, currentEffort, currentUseTmux])

  // `!pending` mirrors the Cancel button, which this dialog already
  // disables mid-save. Escape, the backdrop and the × must not be three more
  // ways past that (NF21, NF25).
  const dismiss = useDialogDismiss(open && !pending, onClose)

  // Whatever closed this dialog, focus does not get left on <body> (NF28).
  // The confirm button disables itself while the mutation runs, so the
  // browser has already dropped focus by the time `onSuccess` closes us.
  useFocusReturn(open)

  if (!open) return null

  const models = [RESET, ...modelsFor(agentType)]
  const efforts = [RESET, ...effortsFor(agentType)]
  const hasCuratedModels = models.length > 1
  const inputCls = 'w-full px-3 py-2 text-sm bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded focus:outline-none focus:ring-2 focus:ring-blue-500'

  const modeLocked = !currentUseTmuxResolved && MODE_LOCKED_STATES.includes(status)

  // `useTmux` drops out of the comparison while the switch is off: the
  // control is hidden, so the state can never diverge, and leaving it in
  // would make `dirty` depend on a value the user cannot see. Same for the
  // locked states — the control is inert there, so it cannot contribute a
  // change, and Save must not send a field the API would refuse.
  const useTmuxDirty = headlessEnabled && !modeLocked && useTmux !== currentUseTmuxResolved
  const dirty =
    (model || '') !== (currentModel ?? '') ||
    (effort || '') !== (currentEffort ?? '') ||
    useTmuxDirty

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={dismiss.onBackdropClick}>
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg"
        onClick={dismiss.onPanelClick}
      >
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-base font-semibold">Edit session defaults</h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            Metadata-only. Applies the next time this session spawns a tmux
            (Reopen / Respawn / wake from sleep).
          </p>
        </div>

        <div className="px-4 py-3 space-y-3">
          <div>
            <label htmlFor={`${uid}-model`} className="text-xs font-medium block mb-1 text-zinc-700 dark:text-zinc-300">
              Model {!currentModel && defaultModel && (
                <span className="text-zinc-400 font-normal">(inherits project: {defaultModel})</span>
              )}
            </label>
            {/* One id on both branches: only one of them is ever mounted, so
              * the label lands on whichever control the harness earned. */}
            {hasCuratedModels ? (
              <select id={`${uid}-model`} className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} disabled={pending}>
                {models.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
              </select>
            ) : (
              <input
                id={`${uid}-model`}
                type="text"
                className={inputCls}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Leave blank to inherit project default"
                disabled={pending}
              />
            )}
          </div>

          <div>
            <label htmlFor={`${uid}-effort`} className="text-xs font-medium block mb-1 text-zinc-700 dark:text-zinc-300">
              Effort {!currentEffort && defaultEffort && (
                <span className="text-zinc-400 font-normal">(inherits project: {defaultEffort})</span>
              )}
            </label>
            <select id={`${uid}-effort`} className={inputCls} value={effort} onChange={(e) => setEffort(e.target.value)} disabled={pending}>
              {efforts.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </div>

          {/* Hidden while the global switch is off. This dialog is
              metadata-only and takes effect on the next spawn, and that
              spawn will be tmux whatever the record says — so the control
              would be offering a choice with no consequence. The stored
              `useTmux` is left as it is; Respawn is what converts a
              headless record, and it does so on its own. */}
          {headlessEnabled && (
            <div>
              {/* Disabled rather than hidden while the mode is locked. The
                  choice still exists and still matters — it has just moved to
                  a different door. A control that vanishes teaches nothing;
                  one that greys out and names Reopen / Fork / Respawn sends
                  the user to the dialog that can actually make the change. */}
              <label className={`flex items-start gap-2 ${modeLocked ? 'cursor-default opacity-70' : 'cursor-pointer'}`}>
                <input
                  type="checkbox"
                  checked={useTmux}
                  onChange={(e) => setUseTmux(e.target.checked)}
                  disabled={pending || modeLocked}
                  className="mt-0.5 w-4 h-4 rounded border-zinc-300 dark:border-zinc-700 accent-blue-600 disabled:opacity-60"
                />
                <span>
                  <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Use tmux</span>
                  <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">
                    {modeLocked
                      ? `Mode is locked while the session is ${status}. Use Reopen, Fork, or Respawn to change mode.`
                      : useTmux
                        ? 'Next run starts an interactive tmux session.'
                        : `Next run is headless — each turn its own ${agentType === 'codex' ? 'codex exec' : 'claude -p'} process, no live TUI.`}
                  </span>
                </span>
              </label>
            </div>
          )}
        </div>

        <DialogError message={error} />

        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button
            size="sm"
            disabled={pending || !dirty}
            onClick={() => onConfirm({
              model: (model || '') !== (currentModel ?? '') ? model : undefined,
              effort: (effort || '') !== (currentEffort ?? '') ? (effort as EffortLevel | '') : undefined,
              useTmux: useTmuxDirty ? useTmux : undefined,
            })}
          >
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}
