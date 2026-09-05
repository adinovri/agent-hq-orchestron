'use client'

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AgentType, EffortLevel } from '@agent-hq-orchestron/shared'

// Per-harness model options. Codex/OpenCode fall back to free-text.
const CLAUDE_MODELS = [
  { value: '', label: '— Default / keep' },
  { value: 'claude-opus-5', label: 'Opus 5 (most capable)' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-fable-5-2', label: 'Fable 5.2 (fast experimental)' },
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (balanced)' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5 (fast + cheap)' },
]

const EFFORTS = [
  { value: '', label: '— Default / keep' },
  { value: 'low', label: 'Low (quick answers)' },
  { value: 'medium', label: 'Medium (balanced)' },
  { value: 'high', label: 'High (thorough)' },
  { value: 'xhigh', label: 'Extra high (deep reasoning)' },
  { value: 'max', label: 'Max (exhaustive)' },
]

export type SessionActionKind = 'reopen' | 'fork' | 'respawn'

interface Props {
  open: boolean
  kind: SessionActionKind
  agentType: AgentType
  currentModel?: string      // session's own model
  currentEffort?: string     // session's own effort
  defaultModel?: string      // project default (fallback display hint)
  defaultEffort?: string
  onClose: () => void
  onConfirm: (opts: { model?: string; effort?: EffortLevel; prompt?: string }) => void
  pending?: boolean
}

const ACTION_META: Record<SessionActionKind, { title: string; hint: string; confirmLabel: string; showPrompt: boolean }> = {
  reopen: {
    title: 'Reopen session',
    hint: 'Continues the same Claude conversation via --resume. Same session id, same context.',
    confirmLabel: 'Reopen',
    showPrompt: false,
  },
  fork: {
    title: 'Fork session',
    hint: 'New orchestron session id, inherits this conversation via --resume. Optional new prompt to seed a divergent path.',
    confirmLabel: 'Fork',
    showPrompt: true,
  },
  respawn: {
    title: 'Respawn session',
    hint: 'Restarts in-place with a fresh Claude conversation. Same session id, same prompt, previous conversation discarded.',
    confirmLabel: 'Respawn',
    showPrompt: false,
  },
}

export function SessionActionDialog({
  open, kind, agentType, currentModel, currentEffort, defaultModel, defaultEffort,
  onClose, onConfirm, pending,
}: Props) {
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [prompt, setPrompt] = useState('')

  useEffect(() => {
    if (open) {
      setModel(currentModel ?? '')
      setEffort(currentEffort ?? '')
      setPrompt('')
    }
  }, [open, currentModel, currentEffort])

  if (!open) return null

  const meta = ACTION_META[kind]
  const isClaude = agentType === 'claude'
  const inputCls = 'w-full px-3 py-2 text-sm bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded focus:outline-none focus:ring-2 focus:ring-blue-500'

  const inheritedModel = currentModel ?? defaultModel
  const inheritedEffort = currentEffort ?? defaultEffort

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div
        className="w-full max-w-md bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg"
        onClick={(e) => e.stopPropagation()}
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
            {isClaude ? (
              <select className={inputCls} value={model} onChange={(e) => setModel(e.target.value)} disabled={pending}>
                {CLAUDE_MODELS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
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
              {EFFORTS.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
            </select>
          </div>

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

        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>Cancel</Button>
          <Button
            size="sm"
            onClick={() => onConfirm({
              model: model || undefined,
              effort: (effort as EffortLevel) || undefined,
              prompt: prompt || undefined,
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
