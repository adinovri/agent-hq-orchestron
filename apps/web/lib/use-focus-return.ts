'use client'

import { useEffect, useRef } from 'react'
import { createFocusReturnLifecycle, scheduleFocusReturn } from './focus-return'
import type { DocumentLike, FocusReturnLifecycle } from './focus-return'
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

/** Begin one return against the live document. */
function startFocusReturn(): () => void {
  return scheduleFocusReturn(
    focusOriginTracker().current(),
    document as unknown as DocumentLike,
    (fn, ms) => {
      const id = window.setTimeout(fn, ms)
      return () => window.clearTimeout(id)
    },
  )
}

/**
 * Give one dialog somewhere to put focus when it closes (NF28, NF29).
 *
 * Call it with the same `open` the dialog renders from, next to
 * `useDialogDismiss` in a hand-rolled dialog or next to `createOpenChangeGuard`
 * in a Base UI one. It takes nothing else on purpose: a dialog should not have
 * to be told where its trigger is, and ten call sites threading a ref through
 * are ten chances to thread it wrong. `focus-origin.ts` knows the answer
 * already.
 *
 * What it guarantees is narrow and worth stating exactly: **after this dialog
 * closes, focus is not left on `<body>`** — including when closing it was the
 * prelude to navigating away from the page it lived on. It does not take focus
 * management away from Base UI and it does not run at all if something already
 * put focus somewhere real — so on the paths that were never broken (Escape,
 * Cancel, Tab) it is a property read and nothing more.
 *
 * The hook is only the adapter. Which close starts a return, and what may call
 * one off, is `createFocusReturnLifecycle` — where it can be tested without a
 * renderer, and where the reason unmount does not cancel is written down.
 */
export function useFocusReturn(open: boolean): void {
  const lifecycleRef = useRef<FocusReturnLifecycle | null>(null)

  // Declared before the `open` effect so that its cleanup runs first on
  // unmount: `dispose` reads the origin tracker, and `release` is what empties
  // it when the last dialog lets go.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const release = focusOriginTracker().retain()
    return () => {
      lifecycleRef.current?.dispose()
      release()
    }
  }, [])

  useEffect(() => {
    if (typeof document === 'undefined') return
    // No cleanup, deliberately — see `createFocusReturnLifecycle` (NF29).
    lifecycleRef.current ??= createFocusReturnLifecycle(startFocusReturn)
    lifecycleRef.current.sync(open)
  }, [open])
}
