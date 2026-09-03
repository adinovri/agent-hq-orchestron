'use client'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'

interface Props {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  descendantCount: number
  killing: boolean
}

export function KillConfirmDialog({ open, onClose, onConfirm, descendantCount, killing }: Props) {
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Kill session?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 py-2">
          This will terminate the session.
          {descendantCount > 0 && (
            <> It has <strong>{descendantCount}</strong> descendant session{descendantCount !== 1 ? 's' : ''} that will also be killed.</>
          )}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={killing}>Cancel</Button>
          <Button
            className="bg-red-600 hover:bg-red-700 text-white"
            onClick={onConfirm}
            disabled={killing}
          >
            {killing ? 'Killing…' : 'Kill'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
