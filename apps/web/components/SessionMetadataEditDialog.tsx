'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AgentType, EffortLevel } from '@agent-hq-orchestron/shared'
import { modelsFor, effortsFor } from '@/lib/models'
import { useHeadlessEnabled, HEADLESS_DISABLED_TOOLTIP } from '@/lib/server-config'

const RESET: { value: ''; label: string } = { value: '', label: '— Reset to project default' }

interface Props {
  open: boolean
  agentType: AgentType
  currentModel?: string           // session's own override
  currentEffort?: string
  currentUseTmux?: boolean        // undefined = never set = tmux
  defaultModel?: string           // project default (shown as fallback hint)
  defaultEffort?: string
  pending?: boolean
  onClose: () => void
  onConfirm: (opts: { model?: string; effort?: EffortLevel | ''; useTmux?: boolean }) => void
}

/** Small modal to patch model + effort on a session record. No lifecycle
 *  action — this ONLY writes the metadata, which takes effect on next
 *  spawn (Reopen / Respawn / sleep-wake). Parent must only render this
 *  when session state has no live tmux (terminal or sleeping). */
export function SessionMetadataEditDialog({
  open, agentType, currentModel, currentEffort, currentUseTmux, defaultModel, defaultEffort,
  pending, onClose, onConfirm,
}: Props) {
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

  if (!open) return null

  const models = [RESET, ...modelsFor(agentType)]
  const efforts = [RESET, ...effortsFor(agentType)]
  const hasCuratedModels = models.length > 1
  const inputCls = 'w-full px-3 py-2 text-sm bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded focus:outline-none focus:ring-2 focus:ring-blue-500'

  const dirty =
    (model || '') !== (currentModel ?? '') ||
    (effort || '') !== (currentEffort ?? '') ||
    useTmux !== currentUseTmuxResolved

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg"
        onClick={(e) => e.stopPropagation()}
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
            <label className="text-xs font-medium block mb-1 text-zinc-700 dark:text-zinc-300">
              Model {!currentModel && defaultModel && (
                <span className="text-zinc-400 font-normal">(inherits project: {defaultModel})</span>
              )}
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
                placeholder="Leave blank to inherit project default"
                disabled={pending}
              />
            )}
          </div>

          <div>
            <label className="text-xs font-medium block mb-1 text-zinc-700 dark:text-zinc-300">
              Effort {!currentEffort && defaultEffort && (
                <span className="text-zinc-400 font-normal">(inherits project: {defaultEffort})</span>
              )}
            </label>
            <select className={inputCls} value={effort} onChange={(e) => setEffort(e.target.value)} disabled={pending}>
              {efforts.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </div>

          {/* Forced-checked while the global switch is off: the API 400s an
              explicit useTmux:false, so tmux is the only value this session
              can respawn with. `useTmux` state is left untouched, which
              keeps `dirty` false — editing model/effort during an outage
              must not silently rewrite a headless session's record. */}
          <div>
            <label
              className={headlessEnabled ? 'flex items-start gap-2 cursor-pointer' : 'flex items-start gap-2 cursor-not-allowed'}
              title={headlessEnabled ? undefined : HEADLESS_DISABLED_TOOLTIP}
            >
              <input
                type="checkbox"
                checked={headlessEnabled ? useTmux : true}
                onChange={(e) => setUseTmux(e.target.checked)}
                disabled={pending || !headlessEnabled}
                className="mt-0.5 w-4 h-4 rounded border-zinc-300 dark:border-zinc-700 accent-blue-600 disabled:opacity-60"
              />
              <span>
                <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Use tmux</span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">
                  {!headlessEnabled
                    ? HEADLESS_DISABLED_TOOLTIP
                    : useTmux
                      ? 'Next run starts an interactive tmux session.'
                      : `Next run is headless — each turn its own ${agentType === 'codex' ? 'codex exec' : 'claude -p'} process, no live TUI.`}
                </span>
              </span>
            </label>
          </div>
        </div>

        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button
            size="sm"
            disabled={pending || !dirty}
            onClick={() => onConfirm({
              model: (model || '') !== (currentModel ?? '') ? model : undefined,
              effort: (effort || '') !== (currentEffort ?? '') ? (effort as EffortLevel | '') : undefined,
              useTmux: useTmux !== currentUseTmuxResolved ? useTmux : undefined,
            })}
          >
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}
