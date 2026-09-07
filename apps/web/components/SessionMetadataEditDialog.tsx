'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AgentType, EffortLevel } from '@agent-hq-orchestron/shared'
import { modelsFor, effortsFor } from '@/lib/models'

const RESET: { value: ''; label: string } = { value: '', label: '— Reset to project default' }

interface Props {
  open: boolean
  agentType: AgentType
  currentModel?: string           // session's own override
  currentEffort?: string
  defaultModel?: string           // project default (shown as fallback hint)
  defaultEffort?: string
  pending?: boolean
  onClose: () => void
  onConfirm: (opts: { model?: string; effort?: EffortLevel | '' }) => void
}

/** Small modal to patch model + effort on a session record. No lifecycle
 *  action — this ONLY writes the metadata, which takes effect on next
 *  spawn (Reopen / Respawn / sleep-wake). Parent must only render this
 *  when session state has no live tmux (terminal or sleeping). */
export function SessionMetadataEditDialog({
  open, agentType, currentModel, currentEffort, defaultModel, defaultEffort,
  pending, onClose, onConfirm,
}: Props) {
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')

  useEffect(() => {
    if (open) {
      setModel(currentModel ?? '')
      setEffort(currentEffort ?? '')
    }
  }, [open, currentModel, currentEffort])

  if (!open) return null

  const models = [RESET, ...modelsFor(agentType)]
  const efforts = [RESET, ...effortsFor(agentType)]
  const hasCuratedModels = models.length > 1
  const inputCls = 'w-full px-3 py-2 text-sm bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded focus:outline-none focus:ring-2 focus:ring-blue-500'

  const dirty = (model || '') !== (currentModel ?? '') || (effort || '') !== (currentEffort ?? '')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-base font-semibold">Edit model &amp; effort</h2>
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
        </div>

        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button
            size="sm"
            disabled={pending || !dirty}
            onClick={() => onConfirm({
              model: (model || '') !== (currentModel ?? '') ? model : undefined,
              effort: (effort || '') !== (currentEffort ?? '') ? (effort as EffortLevel | '') : undefined,
            })}
          >
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  )
}
