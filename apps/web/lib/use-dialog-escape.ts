'use client'

import { useEffect } from 'react'
import { bindDialogEscape } from './dialog-escape'

/**
 * Escape closes this dialog while `enabled` (NF21).
 *
 * `enabled` rather than `open` because two callers need more than "is it on
 * screen": the Metadata Edit and Session Action dialogs disable their Cancel
 * button while a mutation is in flight, and Delete Record does the same while
 * deleting. Those components have already decided that the dialog must not be
 * dismissed mid-write; letting Escape do what the disabled button refuses
 * would just be a second way to do the thing they ruled out. They pass
 * `open && !pending`.
 */
export function useDialogEscape(enabled: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!enabled) return
    return bindDialogEscape(document, onClose)
  }, [enabled, onClose])
}
