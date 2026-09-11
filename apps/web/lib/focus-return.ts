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

/**
 * The bookkeeping around `scheduleFocusReturn`: when a close actually starts a
 * return, and what is allowed to call one off (NF29).
 *
 * The passes above are scheduled from a `useEffect` that watches `open`, and
 * the first cut of that effect returned the cancel as its cleanup. That reads
 * correctly — "this dialog's close is no longer the current state of affairs,
 * drop its scheduled work" — and it is wrong for the one shape that needed the
 * return most.
 *
 * A React effect cleanup fires for two quite different reasons and cannot tell
 * them apart from the inside: the effect is re-running with new deps, or the
 * component is going away. Three dialogs close and navigate in the same
 * callback:
 *
 *     setDeleteOpen(false)          // Delete Record
 *     router.push('/dashboard')
 *
 * So `open` flips false, the effect re-runs and schedules both passes — and
 * then the route transition lands, the page that owns the dialog unmounts, the
 * cleanup runs, and both passes are cancelled some milliseconds before the
 * first of them was due. Focus stays on `<body>`, which is where step 2 of the
 * story at the top of this file left it. Instrumenting `setTimeout` and
 * `clearTimeout` across the ten dialogs showed exactly that split: one pass
 * cleared on Spawn, Delete Record and Fork, none cleared on the dialogs whose
 * success stays on the page, and only the latter ever recovered.
 *
 * The `<main>` fallback was not broken — it never got a turn.
 *
 * The fix is to stop treating unmount as a reason to cancel, because it is
 * not one. A scheduled return is invalidated by exactly one event: **the same
 * dialog opening again** before the passes land, which is the case the cancel
 * was written for ("does not yank focus out of its own reopened self"). A
 * dialog that has gone away cannot reopen, has no focus of its own to protect,
 * and is precisely the case where the operator is left with nothing.
 *
 * So the cancel moves from the cleanup to the reopen, and unmount gets the
 * opposite treatment: if the dialog is torn down while still on screen — a
 * navigation that never bothered to close it — that is a close that never got
 * announced, and it schedules a return rather than cancelling one.
 *
 * The passes outliving their component is the point, and it is bounded: the
 * last of them is due 250ms later, both are no-ops unless focus is adrift, and
 * both resolve their target against the live document rather than anything
 * captured from the page that is gone. `<main>` lives in `app/layout.tsx` and
 * survives the route change, so by the time the second pass runs it is the new
 * route's main content that focus lands in — the honest answer for an action
 * whose whole purpose was to take the operator somewhere else.
 */
export interface FocusReturnLifecycle {
  /** Called with the dialog's `open` every time it changes, and once on mount. */
  sync(open: boolean): void
  /** Called once, when the dialog is unmounted. Never cancels. */
  dispose(): void
}

/**
 * @param startReturn Begins one return and hands back its cancel — in the app,
 *   `scheduleFocusReturn` bound to the live document. Injected so the whole
 *   lifecycle is reachable from a `node` vitest with a fake clock.
 */
export function createFocusReturnLifecycle(startReturn: () => () => void): FocusReturnLifecycle {
  /** Has this dialog actually been on screen? Without it every always-mounted
   *  dialog would return focus on page load — and the session page mounts four
   *  of them closed, all of which would race to pull focus onto `<main>`
   *  before the operator had touched anything. */
  let wasShown = false
  let cancelPending: (() => void) | null = null

  /** One close, however it was signalled. */
  const closed = (): void => {
    wasShown = false
    cancelPending = startReturn()
  }

  return {
    sync(open: boolean): void {
      if (open) {
        // The only event that invalidates a return in flight. Calling a cancel
        // whose passes have already run is a no-op, so there is no need to
        // track whether this one is still live.
        cancelPending?.()
        cancelPending = null
        wasShown = true
        return
      }
      if (!wasShown) return
      closed()
    },
    dispose(): void {
      // Deliberately no `cancelPending?.()`: a return already scheduled by a
      // close is exactly what NF29 was cancelling, and it has to survive this.
      if (!wasShown) return
      closed()
    },
  }
}
