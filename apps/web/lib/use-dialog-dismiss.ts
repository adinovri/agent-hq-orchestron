'use client'

import { useEffect, useMemo } from 'react'
import { bindDialogEscape, createDialogDismiss } from './dialog-dismiss'
import type { DialogDismissHandlers } from './dialog-dismiss'

/**
 * The one place a hand-rolled dialog decides it may be dismissed (NF25).
 *
 * Binds Escape and returns the backdrop / panel / × handlers, all gated by the
 * same `enabled`. Callers pass `open && !pending`: while a mutation is in
 * flight the dialog has already disabled Cancel, and every other exit is held
 * to that same decision rather than quietly outflanking it.
 *
 * This replaces `useDialogEscape`, which guarded one vector of three. There is
 * deliberately no back-compat alias — an alias would leave the old name as a
 * live way to wire up a dialog that guards Escape and nothing else, which is
 * precisely the shape NF25 was.
 */
export function useDialogDismiss(enabled: boolean, onClose: () => void): DialogDismissHandlers {
  useEffect(() => {
    if (!enabled) return
    return bindDialogEscape(document, onClose)
  }, [enabled, onClose])

  return useMemo(() => createDialogDismiss(enabled, onClose), [enabled, onClose])
}
