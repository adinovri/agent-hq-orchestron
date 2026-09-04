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
import { apiFetch } from '@/lib/fetcher'
import type { ProjectMetadata } from '@agent-hq-orchestron/shared'

interface Props {
  project: ProjectMetadata | null
  onClose: () => void
  onDeleted: () => void
}

export function DeleteProjectDialog({ project, onClose, onDeleted }: Props) {
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

  return (
    <Dialog open={!!project} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete project?</DialogTitle>
        </DialogHeader>
        <div className="py-2 space-y-2">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Delete project <span className="font-semibold text-zinc-900 dark:text-zinc-100">{project?.name}</span>? This will not delete session records tied to it, but new session spawns targeting this project will fail.
          </p>
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
