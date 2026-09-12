'use client'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { createOpenChangeGuard } from '@/lib/dialog-dismiss'
import { useFocusReturn } from '@/lib/use-focus-return'
import { DialogError } from '@/components/ui/dialog-error'

interface Props {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  descendantCount: number
  killing: boolean
  /** Why the last attempt failed, if it did. The dialog stays open on
   *  failure so the operator can retry; this is what tells them to (NF27). */
  error?: string | null
}

export function KillConfirmDialog({ open, onClose, onConfirm, descendantCount, killing, error }: Props) {
  // The primitive returns focus to whatever was focused before it opened,
  // which covers the ordinary case and quietly does nothing when that
  // element did not survive the action. This is the floor under it: focus is
  // never left on <body> (NF28). It only acts if the primitive did not.
  useFocusReturn(open)

  // Base UI routes Escape, the backdrop and its own × through one
  // `onOpenChange`. Guarding it there is how this dialog says the same "not
  // mid-kill" that its disabled Cancel already says; the dialog is controlled,
  // so a refused change leaves `open` true and the dialog on screen (NF25).
  return (
    <Dialog open={open} onOpenChange={createOpenChangeGuard(!killing, onClose)}>
      <DialogContent className="max-w-sm" closeDisabled={killing}>
        <DialogHeader>
          <DialogTitle>Kill session?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 py-2">
          This will terminate the session.
          {descendantCount > 0 && (
            <> It has <strong>{descendantCount}</strong> descendant session{descendantCount !== 1 ? 's' : ''} that will also be killed.</>
          )}
        </p>
        {/*
          * `mx-0 mb-0` because this dialog's body is `DialogContent`'s own
          * `p-4`, not a padded wrapper inside it. `DialogError` defaults to
          * `mx-4 mb-3` for the hand-rolled shells, which have no padding of
          * their own; a direct child of `DialogContent` adds that gutter on
          * top of the padding and lands 32 px in while every sibling sits at
          * 16 px (NF32). Same override, same reason, as the two other
          * dialogs built on the primitive — Delete Project and Project.
          */}
        <DialogError message={error} className="mx-0 mb-0" />
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
