'use client'

import { AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { dialogErrorAttrs } from '@/lib/dialog-error'

/**
 * The reason a dialog is still on screen after its confirm button came back
 * (NF27), announced as well as drawn (NF30).
 *
 * A dialog that stays open on failure and says nothing is only half a
 * recovery. The operator sees the button return to "Kill", the session still
 * listed as running, and no way to tell whether the request was rejected, timed
 * out, or never sent. `settleSessionAction` wrote the gap down rather than
 * fixing it: "a failure leaves the dialog open with the button back to `Reopen`
 * and nothing said about why."
 *
 * Above the footer, not in it: the message has to survive the operator's eye
 * travelling to the retry button, and sitting between the form and the button
 * is where it gets read on the way.
 *
 * `role="alert"` because this appears in response to an action the operator
 * just took and is the only signal that it failed. The attributes live in
 * `lib/dialog-error` so that one audit can assert no dialog re-invents this
 * element without them.
 *
 * `className` exists for the dialogs whose body is already padded: those render
 * the message inside the scrolling content rather than flush against the
 * dialog's edge, and pass `mx-0 mb-0` to drop the outer gutter.
 */
export function DialogError({
  message,
  className,
}: {
  message?: string | null
  className?: string
}) {
  if (!message) return null
  return (
    <div
      {...dialogErrorAttrs}
      className={cn(
        'mx-4 mb-3 flex items-start gap-2 rounded border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 px-3 py-2',
        className,
      )}
    >
      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-red-600 dark:text-red-400" />
      <p className="text-xs text-red-800 dark:text-red-300 break-words min-w-0">{message}</p>
    </div>
  )
}
