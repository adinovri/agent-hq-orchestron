/**
 * The three ways an operator dismisses a hand-rolled dialog — as plain
 * functions, minus React.
 *
 * NF21 gave Escape a guard: a dialog whose mutation is in flight has already
 * disabled its own Cancel button, and letting Escape do what Cancel refuses
 * would just be a second way to do the thing the dialog ruled out. NF24 gave
 * Session Action a `pending` that actually reaches the mounted dialog, so the
 * guard had a window to close.
 *
 * NF25 is what that left behind. Escape was one of *three* dismissal vectors
 * and the only one that ever learned about `pending`. Clicking the backdrop
 * (`onClick={onClose}` straight on the overlay `div`) and clicking the header
 * `×` both went to `onClose` unconditionally, in every hand-rolled dialog —
 * including the Session Action dialog whose window NF24 had just created.
 * Mid-mutation either one tore the dialog off the screen while the request
 * stayed in flight: no progress, no result, no way to cancel.
 *
 * So the fix is not "add a guard to the backdrop". It is that there is exactly
 * one place a dialog decides whether it may be dismissed, and every vector
 * asks it. Escape, backdrop and × are the same question.
 *
 * These live outside the hook so they can be tested: this app's vitest runs in
 * `node` with no DOM, and a hook needs a renderer. Plain functions over
 * structurally-typed events need neither.
 */

/** The slice of `document` this needs — anything that can take a keydown. */
export interface KeyTarget {
  addEventListener(type: 'keydown', listener: (e: KeyboardEvent) => void): void
  removeEventListener(type: 'keydown', listener: (e: KeyboardEvent) => void): void
}

/**
 * The slice of a React click event the backdrop check needs.
 *
 * `target`/`currentTarget` are `unknown` rather than `EventTarget` so a test
 * can pass two sentinel objects; the check is identity, never a DOM method.
 */
export interface ClickLike {
  target: unknown
  currentTarget: unknown
}

/** The slice of a React click event the panel needs to swallow a bubble. */
export interface StoppableClick {
  stopPropagation(): void
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

/** Handlers a dialog spreads onto its overlay, its panel and its × button. */
export interface DialogDismissHandlers {
  /** Overlay `onClick` — dismisses only on a click that landed on the backdrop. */
  onBackdropClick(e: ClickLike): void
  /** Panel `onClick` — stops an in-panel click from reaching the backdrop. */
  onPanelClick(e: StoppableClick): void
  /** The header `×` — `onClose` routed through the same guard. */
  onCloseButtonClick(): void
  /** `disabled` + tooltip for that same `×`, so a refused click looks
   *  refused rather than missed (NF26). Spread onto the button. */
  closeButton: CloseButtonGuard
}

/**
 * Build the dismissal handlers for one dialog, all gated by `enabled`.
 *
 * `enabled` rather than `open` because the callers pass `open && !pending`:
 * being on screen is not the same question as being dismissible. When it is
 * false every handler is inert — the dialog stays mounted and the mutation
 * keeps its one place on screen.
 *
 * The backdrop test is `target === currentTarget`, not "the panel called
 * stopPropagation". Both are wired, because either alone has a hole: without
 * the identity test a click inside a child that forgets to stop bubbling
 * closes the dialog, and without `stopPropagation` a nested overlay's click
 * still reaches this one.
 */
export function createDialogDismiss(
  enabled: boolean,
  onClose: () => void,
): DialogDismissHandlers {
  return {
    onBackdropClick(e: ClickLike): void {
      if (!enabled) return
      if (e.target !== e.currentTarget) return
      onClose()
    },
    onPanelClick(e: StoppableClick): void {
      e.stopPropagation()
    },
    onCloseButtonClick(): void {
      if (!enabled) return
      onClose()
    },
    closeButton: closeButtonGuard(enabled),
  }
}

/**
 * The same guard for a dialog built on the Base UI primitive.
 *
 * Those three (Project, Delete Project, Kill Confirm) never had the NF21 bug —
 * the primitive binds Escape itself — but they had the NF25 one in its purest
 * form: Escape, the backdrop *and* the built-in × all arrive as a single
 * `onOpenChange(false)`, and `(v) => !v && onClose()` forwarded every one of
 * them while the disabled Cancel button sat right there saying no.
 *
 * Refusing to forward is enough because the primitive is controlled: `open`
 * stays true, so the dialog stays on screen. Returning a handler rather than
 * inlining the clause is what lets the decision be tested at all — these
 * components need a DOM to render and this app's vitest does not have one.
 */
export function createOpenChangeGuard(
  enabled: boolean,
  onClose: () => void,
): (nextOpen: boolean) => void {
  return (nextOpen: boolean): void => {
    if (nextOpen) return
    if (!enabled) return
    onClose()
  }
}

/**
 * NF26: making the refusal visible.
 *
 * NF25 gave every dismissal vector the same answer. It did not give the
 * operator any way to see it. Click the × mid-mutation and the guard declines
 * to forward `onOpenChange(false)` — correct, and completely silent. Nothing
 * moves, no message appears, and the most natural reading of a button that
 * does nothing when clicked is that the click was missed. So the operator
 * clicks again.
 *
 * The six hand-rolled dialogs were half-right already: their × carries
 * `disabled={pending}` and `disabled:opacity-40 disabled:cursor-not-allowed`,
 * so the glyph dims and the cursor says no. The three Base UI ones (Kill
 * Confirm, Project, Delete Project) render the primitive's built-in × which
 * never learned about `pending` at all — it is fully lit, takes hover, and
 * silently does nothing.
 *
 * What was missing everywhere is words. A dimmed glyph says "no"; it does not
 * say "because a request is in flight", which is the part that tells the
 * operator to wait rather than to reload the page.
 */

/** Tooltip on a × that is refusing. Says what to do, not what went wrong. */
export const CLOSE_BLOCKED_TITLE = 'Please wait for the request to finish'

/** The attributes that make a × legibly refuse. */
export interface CloseButtonGuard {
  /** Native `disabled`: stops the click and arms every `disabled:` rule. */
  disabled: boolean
  /** Present only while blocked. An always-on "Close" tooltip on a button
   *  that already has `aria-label="Close"` is noise read twice. */
  title?: string
}

/**
 * Close-button attributes for a dialog that may or may not be dismissible.
 *
 * Takes the same `enabled` the dismissal handlers take, so a caller cannot
 * wire a × that refuses the click but still looks clickable — the two come
 * from one expression.
 */
export function closeButtonGuard(enabled: boolean): CloseButtonGuard {
  return enabled ? { disabled: false } : { disabled: true, title: CLOSE_BLOCKED_TITLE }
}
