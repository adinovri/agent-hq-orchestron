'use client'

import { X, Trash2, AlertTriangle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'

interface Props {
  open: boolean
  session: SessionMetadata
  workspacePath?: string
  onClose: () => void
  onConfirm: () => void
  deleting: boolean
}

export function DeleteRecordDialog({ open, session, workspacePath, onClose, onConfirm, deleting }: Props) {
  if (!open) return null

  const jsonlPath = session.jsonlPath || '(no transcript path recorded)'
  const isClaude = session.agentType === 'claude'
  const historyDir = isClaude && session.configDir && session.claudeSessionUuid
    ? `${session.configDir.replace(/\/$/, '')}/file-history/${session.claudeSessionUuid}/`
    : null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={onClose}>
      <div className="w-full max-w-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
            <h2 className="text-base font-semibold">Delete orchestron record</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 space-y-3 text-sm">
          <p className="text-zinc-700 dark:text-zinc-300">
            Removes this session from the orchestron dashboard permanently. The
            harness transcript stays on disk — you can bring it back later via
            <span className="font-medium"> Adopt</span> using the same UUID.
          </p>

          <div className="rounded border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/20 p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-medium text-red-800 dark:text-red-300">
              <AlertTriangle className="w-3.5 h-3.5" /> Will be deleted
            </div>
            <ul className="text-[11px] font-mono text-red-700 dark:text-red-400 space-y-0.5 pl-4 list-disc break-all">
              <li>~/.orchestron/sessions/{session.id}.json (+ .bak)</li>
              <li>~/.orchestron/mcp-configs/{session.id}.json (+ .bak)</li>
            </ul>
          </div>

          <div className="rounded border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/20 p-3 space-y-1">
            <div className="text-xs font-medium text-emerald-800 dark:text-emerald-300">
              Will be preserved
            </div>
            <ul className="text-[11px] font-mono text-emerald-700 dark:text-emerald-400 space-y-0.5 pl-4 list-disc break-all">
              <li>{jsonlPath} <span className="text-emerald-600/70 italic">(harness transcript)</span></li>
              {historyDir && (
                <li>{historyDir}<span className="text-emerald-600/70 italic"> (claude file-edit history)</span></li>
              )}
              <li>~/.orchestron/metrics/sessions.jsonl <span className="text-emerald-600/70 italic">(historical aggregate)</span></li>
              <li>~/.orchestron/delegation/*.jsonl <span className="text-emerald-600/70 italic">(parent/child edges become orphans)</span></li>
            </ul>
          </div>

          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Session id <code className="font-mono">{session.id.slice(0, 8)}…</code>,
            harness session <code className="font-mono">{session.claudeSessionUuid?.slice(0, 8) ?? '?'}…</code>,
            workspace <code className="font-mono">{workspacePath ?? session.projectId}</code>.
          </p>
        </div>

        <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={onConfirm}
            disabled={deleting}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            {deleting ? (
              <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Deleting…</>
            ) : (
              <><Trash2 className="w-3 h-3 mr-1" /> Delete record</>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
