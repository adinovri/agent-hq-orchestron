/**
 * Escape closes a dialog — the binding, minus React.
 *
 * NF21: Escape dismissed the Spawn dialog and nothing else. Adopt, Import,
 * Metadata Edit, Session Action and Delete Record all trapped the operator
 * into finding the × or the backdrop, because each hand-rolled overlay carried
 * its own copy of the keydown effect and only two of them had ever been given
 * one. The dialogs built on the Radix `Dialog` primitive were never affected —
 * it binds Escape itself — so the split was never a decision, it was whichever
 * dialogs happened to be written by hand.
 *
 * The listener lives here rather than in the hook so it can be tested: this
 * app's vitest runs in `node` with no DOM, and a hook needs a renderer. A
 * plain `EventTarget`-shaped argument needs neither, and registration and
 * cleanup are most of what there is to get wrong.
 */

/** The slice of `document` this needs — anything that can take a keydown. */
export interface KeyTarget {
  addEventListener(type: 'keydown', listener: (e: KeyboardEvent) => void): void
  removeEventListener(type: 'keydown', listener: (e: KeyboardEvent) => void): void
}

/**
 * Call `onClose` when Escape is pressed on `target`. Returns the unsubscribe.
 *
 * `defaultPrevented` is honoured: a combobox or a menu inside the dialog that
 * takes Escape for itself has already called `preventDefault`, and closing the
 * whole dialog out from under it would be the second thing to happen on one
 * key press.
 */
export function bindDialogEscape(target: KeyTarget, onClose: () => void): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    if (e.defaultPrevented) return
    onClose()
  }
  target.addEventListener('keydown', onKey)
  return () => target.removeEventListener('keydown', onKey)
}
