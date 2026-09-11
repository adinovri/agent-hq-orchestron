'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { createOpenChangeGuard } from '@/lib/dialog-dismiss'
import { apiFetch } from '@/lib/fetcher'
import type { ProjectMetadata } from '@agent-hq-orchestron/shared'

interface Props {
  project: ProjectMetadata | null
  onClose: () => void
  onDeleted: () => void
  sessionCount?: { total: number; active: number }
}

export function DeleteProjectDialog({ project, onClose, onDeleted, sessionCount }: Props) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleDelete() {
    if (!project) return
    setDeleting(true)
    setError(null)
    try {
      const res = await apiFetch(`/api/projects/${project.id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      onDeleted()
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  // One `onOpenChange` covers Escape, the backdrop and the built-in × — all
  // three wait for the delete, as Cancel already does (NF25).
  return (
    <Dialog open={!!project} onOpenChange={createOpenChangeGuard(!deleting, onClose)}>
      <DialogContent className="max-w-sm" closeDisabled={deleting}>
        <DialogHeader>
          <DialogTitle>Delete project?</DialogTitle>
        </DialogHeader>
        <div className="py-2 space-y-3">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Delete project <span className="font-semibold text-zinc-900 dark:text-zinc-100">{project?.name}</span>?
          </p>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded p-2 space-y-1">
            <p className="font-semibold text-zinc-700 dark:text-zinc-300">What happens:</p>
            <ul className="list-disc list-inside space-y-0.5 leading-relaxed">
              <li>Project record removed from registry.</li>
              <li>Existing session records stay — but show only the project uuid, not the name.</li>
              <li>Running tmux + Claude processes are <strong>not</strong> killed. Kill them from the dashboard first if needed.</li>
              <li>New spawns targeting this project id will fail.</li>
              <li>Files on disk at <code className="font-mono">{project?.path}</code> are untouched.</li>
            </ul>
          </div>
          {sessionCount && sessionCount.total > 0 && (
            <div className="text-xs bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-200 rounded p-2">
              This project has <strong>{sessionCount.total}</strong> session{sessionCount.total === 1 ? '' : 's'}
              {sessionCount.active > 0 && <> — <strong>{sessionCount.active}</strong> still active</>}.
            </div>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
