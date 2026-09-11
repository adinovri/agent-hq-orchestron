'use client'

import { X } from 'lucide-react'
import type { CloseButtonGuard } from '@/lib/dialog-dismiss'

/**
 * The header `×` of a hand-rolled dialog, refusing legibly (NF26).
 *
 * Five dialogs had five copies of this button, all identical apart from a
 * couple of colour classes, and all with the same hole: `disabled` dimmed the
 * glyph but said nothing about why. A dimmed × tells the operator "no"; it
 * does not tell them "a request is in flight, wait" — which is the half that
 * distinguishes "wait a moment" from "this page is broken, reload it".
 *
 * The tooltip lives on the wrapper rather than the button because Chrome and
 * Firefox do not show `title` on a disabled form control. Put it on the button
 * and it renders in exactly the state where nobody needs it. The wrapper is a
 * plain span, always in the layout, and is the element the pointer actually
 * lands on once the button stops taking events — so it is the one that can
 * carry both the tooltip and the `not-allowed` cursor.
 */
export function DialogCloseButton({
  guard,
  onClick,
  className = '',
}: {
  /** From `useDialogDismiss(...).closeButton` — `disabled` plus the tooltip
   *  text, so the look and the behaviour come from one expression. */
  guard: CloseButtonGuard
  onClick: () => void
  /** Per-dialog colour classes. The dimming rules are added here. */
  className?: string
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={guard.disabled}
      aria-label="Close"
      className={`p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent ${className}`}
    >
      <X className="w-4 h-4" />
    </button>
  )

  if (!guard.disabled) return button

  return (
    <span
      data-slot="dialog-close-blocked"
      title={guard.title}
      className="inline-flex cursor-not-allowed"
    >
      {button}
    </span>
  )
}
