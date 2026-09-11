/**
 * Where the keyboard goes when a dialog closes (NF28).
 *
 * Every dialog in this app already agrees on when it may be dismissed (NF25)
 * and on saying so out loud when it refuses (NF26, NF27). None of them had an
 * answer for the question that comes immediately after: the dialog is gone —
 * what is focused now?
 *
 * On the submit path the answer was `<body>`, and it is worth being precise
 * about why, because it explains why only that one path was affected:
 *
 *   1. The operator clicks Confirm / Save / Kill. That button takes focus.
 *   2. The mutation starts, so `pending` flips true, so that same button gets
 *      `disabled` — every dialog here disables its own confirm while in
 *      flight. A browser will not leave focus on a control that has just
 *      become disabled, so it drops focus to `<body>`.
 *   3. The mutation succeeds and `onSuccess` closes the dialog.
 *
 * By step 3 focus is already adrift, and nothing puts it back. The hand-rolled
 * dialogs never had focus management at all — they `return null` and the
 * subtree simply disappears. The Base UI ones do have it: `FloatingFocusManager`
 * remembers the element focused before the popup opened and returns focus
 * there. That works whenever the trigger is still on the page and fails
 * silently when it is not — after a Delete, a Spawn, or anything else whose
 * success navigates away or removes the row the operator clicked from.
 *
 * Escape and Tab stayed correct throughout, which is the tell: neither ever
 * disables anything, so focus was still on a real element when the dialog
 * closed and the existing machinery had something to return to.
 *
 * The fix is deliberately an *audit* rather than a replacement. It does not
 * take focus management away from Base UI, and it does not try to out-guess a
 * primitive that is usually right. It states one rule and enforces only that
 * rule: **after a dialog closes, focus is never left on `<body>`.** If the
 * primitive already put focus somewhere real, this does nothing at all.
 *
 * Where the element to go back to comes from is `focus-origin.ts`; this module
 * is only the decision of whether to move focus, where to, and when.
 *
 * As with `dialog-dismiss.ts`, the decisions live here as plain functions over
 * structurally-typed DOM slices: this app's vitest runs in `node` with no DOM,
 * and a hook needs a renderer. Functions over interfaces need neither.
 */

/** What counts as "inside a dialog" when deciding whether a focus event is
 *  the operator moving around the page or the dialog focusing its own guts.
 *
 *  Both selectors, because the two families announce themselves differently
 *  and neither alone is safe: the hand-rolled panels carry `role="dialog"`
 *  themselves, while `[data-slot="dialog-content"]` is what `DialogContent`
 *  stamps on the Base UI popup regardless of what role the primitive picks. */
export const DIALOG_SCOPE_SELECTOR = '[role="dialog"],[data-slot="dialog-content"]'

/** The slice of an element needed to ask where it sits in the tree. */
export interface ScopedElement {
  closest(selectors: string): unknown
}

/** Is this element part of some dialog rather than part of the page? */
export function isInsideDialog(el: ScopedElement): boolean {
  return el.closest(DIALOG_SCOPE_SELECTOR) != null
}

/** The slice of an element this needs. Never a DOM method beyond these. */
export interface FocusableLike {
  /** Still in the document. A detached node can be focused all day and the
   *  active element stays `<body>`. */
  isConnected: boolean
  /** Uppercase, as `Element.tagName` gives it. */
  tagName: string
  focus(options?: { preventScroll?: boolean }): void
  hasAttribute(name: string): boolean
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
}

/** The slice of `document` this needs. */
export interface DocumentLike {
  activeElement: FocusableLike | null
  body: FocusableLike
  querySelector(selectors: string): FocusableLike | null
}

/**
 * Focus is nowhere: no active element, or `<body>`.
 *
 * This is the entire trigger condition for the audit. Anything else — the
 * trigger, a toast, a field the operator tabbed to in the half-second since —
 * is somebody's deliberate choice and is left alone.
 */
export function focusIsAdrift(doc: DocumentLike): boolean {
  const el = doc.activeElement
  return el === null || el === doc.body
}

/**
 * The landmark focus falls back to when the origin is gone.
 *
 * `<main>` rather than `<h1>`: the heading is per-page and some pages render
 * theirs inside a component that a successful mutation has just unmounted,
 * whereas the landmark is in `app/layout.tsx` and outlives every route. It is
 * also where a skip link would have put the operator, so a screen reader
 * announces the region they are now in rather than the whole document.
 */
export const FOCUS_FALLBACK_SELECTOR = 'main'

/** Elements the browser will focus without being given a `tabindex`. */
const NATIVELY_FOCUSABLE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'])

/**
 * Can focus actually land on this element?
 *
 * `disabled` is the case that matters here and it is not hypothetical: the
 * confirm button that lost focus in step 2 above is very often still
 * `disabled` when the audit runs, because `pending` only clears once the
 * mutation settles. Handing focus back to it would move the active element
 * precisely nowhere, and the audit would report success having done nothing.
 */
function canTakeFocus(el: FocusableLike): boolean {
  if (!el.isConnected) return false
  if (el.hasAttribute('disabled')) return false
  return true
}

/**
 * Which element this close should hand focus to, or `null` if there is
 * nothing sensible left on the page.
 *
 * The origin first — it is where the operator was, and returning them there
 * is the behaviour every dialog primitive is trying to produce. The landmark
 * second, for the case the origin did not survive its own success: Delete
 * removes the row its trigger lived in, Spawn navigates to the new session.
 * Those are not failures to correct, they are the point of the action, and
 * "somewhere in the main content" is the honest answer for them.
 */
export function resolveFocusReturn(
  origin: FocusableLike | null,
  doc: DocumentLike,
): FocusableLike | null {
  if (origin && canTakeFocus(origin)) return origin
  const fallback = doc.querySelector(FOCUS_FALLBACK_SELECTOR)
  if (!fallback || !fallback.isConnected) return null
  return fallback
}

/**
 * Run one audit pass. Returns the element focused, or `null` if the pass
 * decided to leave things alone.
 *
 * `tabindex="-1"` on the landmark is the standard skip-link arrangement: it
 * makes the element programmatically focusable without putting it into the tab
 * order, so nothing about sequential navigation changes.
 */
export function auditFocusReturn(
  origin: FocusableLike | null,
  doc: DocumentLike,
): FocusableLike | null {
  if (!focusIsAdrift(doc)) return null
  const target = resolveFocusReturn(origin, doc)
  if (!target) return null
  if (!NATIVELY_FOCUSABLE.has(target.tagName) && target.getAttribute('tabindex') === null) {
    target.setAttribute('tabindex', '-1')
  }
  target.focus({ preventScroll: true })
  return target
}

/**
 * When the audit runs after `open` goes false, in milliseconds.
 *
 * Two passes, because the two dialog families close on different clocks.
 *
 * A hand-rolled dialog is gone in the same commit that set `open` false, so
 * by the first macrotask focus has already landed on `<body>` and the first
 * pass is the one that fixes it.
 *
 * A Base UI dialog has an exit animation (`duration-100`), so the popup stays
 * mounted while it fades and `FloatingFocusManager` does not run its own
 * restore until after that. The first pass fires during the fade and puts
 * focus back; the primitive then does its restore, usually onto the same
 * element. The second pass exists for the case where the primitive had no
 * element to restore to either, dropped focus back onto `<body>`, and left it
 * there — 250ms is comfortably past a 100ms transition.
 *
 * Both passes are no-ops unless focus is adrift, so the common case of "the
 * first pass already fixed it" costs one property read.
 */
export const FOCUS_RETURN_PASSES_MS: readonly number[] = [0, 250]

/** Schedules `fn` after `delayMs` and returns a function that cancels it. */
export type FocusReturnScheduler = (fn: () => void, delayMs: number) => () => void

/**
 * Schedule every audit pass for one dialog close. Returns a cancel for all of
 * them, so a dialog that reopens before the passes land does not yank focus
 * out of its own reopened self.
 */
export function scheduleFocusReturn(
  origin: FocusableLike | null,
  doc: DocumentLike,
  schedule: FocusReturnScheduler,
): () => void {
  const cancels = FOCUS_RETURN_PASSES_MS.map((ms) =>
    schedule(() => {
      auditFocusReturn(origin, doc)
    }, ms),
  )
  return () => {
    for (const cancel of cancels) cancel()
  }
}
