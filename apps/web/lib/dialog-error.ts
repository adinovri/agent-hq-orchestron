/**
 * The attributes that make a dialog's failure message *audible*, and a scanner
 * that proves no dialog has drifted back to rendering one without them (NF30).
 *
 * NF27 fixed the sighted half of this: a failed mutation leaves the dialog open
 * and says why. The resweep after batch-16 measured the other seven dialogs for
 * the first time and found the message is only ever *drawn* — a bare
 * `<p class="text-sm text-red-500">` with no role, no live region, no slot. An
 * operator on a screen reader presses Register, the request fails, the dialog
 * stays open, and nothing is announced; because the dialog did not close, the
 * most natural reading is that the action is still in flight.
 *
 * `role="alert"` already implies an assertive live region, so `aria-live` is
 * redundant to a conforming reader. It is set anyway: the combination is what
 * is actually carried across the older screen-reader/browser pairs, and it is
 * what an audit queries for. `data-slot` is the handle the E2E probes use to
 * tell "the dialog explained itself" apart from "something red is on screen".
 */

export const DIALOG_ERROR_ROLE = 'alert'
export const DIALOG_ERROR_ARIA_LIVE = 'assertive'
export const DIALOG_ERROR_SLOT = 'dialog-error'

/** Spread onto the element that renders the message. One source, ten dialogs. */
export const dialogErrorAttrs = {
  role: DIALOG_ERROR_ROLE,
  'aria-live': DIALOG_ERROR_ARIA_LIVE,
  'data-slot': DIALOG_ERROR_SLOT,
} as const

export interface UnannouncedErrorSurface {
  file: string
  line: number
  snippet: string
}

/** A className carrying any red utility — the colour these surfaces are drawn in. */
const RED_CLASS = /className=(?:"[^"]*|\{`[^`]*)\bred-\d/
/** A JSX text interpolation that renders something called `error`. */
const ERROR_INTERPOLATION = /\{[^{}]*\berror\b[^{}]*\}/i
/** The announcement, in any of the forms the component could spell it. */
const ANNOUNCED = /role=(?:"alert"|\{'alert'\})|<DialogError|dialogErrorAttrs/

/** Lines after the opening tag that still count as the same element. */
const WINDOW_AHEAD = 3
/** Lines before it — a wrapper may carry the role for the span inside it. */
const WINDOW_BEHIND = 2

/**
 * Every place a component paints an error red without announcing it.
 *
 * Deliberately textual rather than an AST walk: the invariant being defended is
 * "a human adding a new error surface copies the shared component", and a
 * regex over the source catches exactly the copy-paste that skips it. It is a
 * tripwire, not a type system — a new bare surface will not happen to have
 * `role="alert"` two lines above it.
 */
export function findUnannouncedErrorSurfaces(
  file: string,
  source: string,
): UnannouncedErrorSurface[] {
  const lines = source.split('\n')
  const found: UnannouncedErrorSurface[] = []

  for (let i = 0; i < lines.length; i++) {
    if (!RED_CLASS.test(lines[i])) continue

    const ahead = lines.slice(i, i + WINDOW_AHEAD + 1).join('\n')
    if (!ERROR_INTERPOLATION.test(ahead)) continue

    const context = lines.slice(Math.max(0, i - WINDOW_BEHIND), i + WINDOW_AHEAD + 1).join('\n')
    if (ANNOUNCED.test(context)) continue

    found.push({ file, line: i + 1, snippet: lines[i].trim() })
  }

  return found
}
