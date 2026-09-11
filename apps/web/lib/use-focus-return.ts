'use client'

import { useEffect, useRef } from 'react'
import { scheduleFocusReturn } from './focus-return'
import type { DocumentLike } from './focus-return'
import { createFocusOriginTracker } from './focus-origin'
import type { FocusOriginHost, FocusOriginTracker } from './focus-origin'

/**
 * One tracker for the whole tab, created the first time a dialog asks.
 *
 * Lazily, because this module is imported during the server render of every
 * page that has a dialog on it and `document` does not exist there.
 */
let tracker: FocusOriginTracker | null = null

function focusOriginTracker(): FocusOriginTracker {
  tracker ??= createFocusOriginTracker(document as unknown as FocusOriginHost)
  return tracker
}

/**
 * Give one dialog somewhere to put focus when it closes (NF28).
 *
 * Call it with the same `open` the dialog renders from, next to
 * `useDialogDismiss` in a hand-rolled dialog or next to `createOpenChangeGuard`
 * in a Base UI one. It takes nothing else on purpose: a dialog should not have
 * to be told where its trigger is, and ten call sites threading a ref through
 * are ten chances to thread it wrong. `focus-origin.ts` knows the answer
 * already.
 *
 * What it guarantees is narrow and worth stating exactly: **after this dialog
 * closes, focus is not left on `<body>`.** It does not take focus management
 * away from Base UI and it does not run at all if something already put focus
 * somewhere real — so on the paths that were never broken (Escape, Cancel,
 * Tab) it is a property read and nothing more.
 */
export function useFocusReturn(open: boolean): void {
  /** Whether this dialog has actually been on screen. Without it every
   *  always-mounted dialog would audit on page load — and the session page
   *  mounts four of them closed, all of which would race to pull focus onto
   *  `<main>` before the operator had touched anything. */
  const wasShownRef = useRef(false)

  useEffect(() => {
    if (typeof document === 'undefined') return
    return focusOriginTracker().retain()
  }, [])

  useEffect(() => {
    if (open) {
      wasShownRef.current = true
      return
    }
    if (!wasShownRef.current) return
    wasShownRef.current = false
    if (typeof document === 'undefined') return

    const origin = focusOriginTracker().current()
    return scheduleFocusReturn(origin, document as unknown as DocumentLike, (fn, ms) => {
      const id = window.setTimeout(fn, ms)
      return () => window.clearTimeout(id)
    })
  }, [open])
}
