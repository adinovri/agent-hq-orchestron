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

/* ------------------------------------------------------------------------ *
 * Where the box sits, as opposed to whether it speaks (NF32).
 * ------------------------------------------------------------------------ */

/**
 * `DialogError`'s default `mx-4 mb-3` is a gutter for the shells that have no
 * padding of their own — the hand-rolled panels, where the message sits flush
 * between a padded body and a padded footer. Render it somewhere the panel has
 * *already* inset its content and that gutter stacks on top: 32 px in, while
 * every sibling sits at 16.
 *
 * That is NF32, and it is the mirror image of what NF30 fixed. The seven
 * dialogs batch-17 converted all pass `mx-0 mb-0` for exactly this reason;
 * Kill, the one dialog the batch had no reason to open, did not — its
 * `DialogError` is a direct child of `DialogContent`, which is `p-4`.
 *
 * The rule is not about the immediate parent — Delete Project's is `py-2`,
 * with the 16 px coming from the `DialogContent` above it. It is about the
 * whole chain: **drop the gutter if and only if some ancestor between the
 * message and the dialog panel already insets it horizontally.** Nothing in
 * the type system can say that, so this scanner does — the same tripwire shape
 * as `findUnannouncedErrorSurfaces`, applied to the other half of the element.
 */

/** Tags whose padding lives in the component rather than at the call site. */
const SELF_PADDED_TAGS = new Set(['DialogContent'])
/** A horizontal padding utility — `p-4`, `px-3`, `pl-2`, `px-[2px]`. */
const PADS_HORIZONTALLY = /\bp[xl]?-(?:\d|\[)/
/** The opt-out of the default gutter. */
const GUTTER_DROPPED = /\bmx-0\b/
/**
 * Where the walk stops. Above the panel is the backdrop, whose own `p-4` is
 * the gap between the dialog and the viewport, not an inset on its content.
 */
const PANEL_TAGS = new Set(['DialogContent'])
const PANEL_ATTR = /role="dialog"/

export interface DialogErrorInset {
  file: string
  line: number
  /** The chain from the message out to the dialog panel, innermost first. */
  ancestors: string[]
  /** Does anything in that chain already inset the message horizontally? */
  insetByAncestor: boolean
  /** Does the call site drop `DialogError`'s own gutter? */
  gutterDropped: boolean
}

/** An element's full opening tag, which may span several lines. */
function openingTagFrom(lines: string[], start: number): string {
  let open = ''
  for (let j = start; j < lines.length; j++) {
    open += lines[j]
    if (/>\s*$/.test(lines[j])) break
  }
  return open
}

/**
 * The chain of enclosing elements, innermost first, up to and including the
 * dialog panel.
 *
 * Indentation is the nesting signal: these files are uniformly formatted, and
 * an AST walk would be a parser's worth of machinery to answer one question.
 * Lines that open no element — `) : (`, `{cond && (`, a closing tag — are
 * stepped over rather than treated as ancestors, which is what makes a message
 * inside a ternary branch resolve to the element that branch renders into.
 */
function ancestorChain(lines: string[], from: number, indent: number): { tag: string; open: string }[] {
  const chain: { tag: string; open: string }[] = []
  let ceiling = indent

  for (let i = from - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.trim()) continue
    const lineIndent = line.length - line.trimStart().length
    if (lineIndent >= ceiling) continue

    const opens = /^<([A-Za-z][\w.]*)/.exec(line.trim())
    if (!opens) continue

    const open = openingTagFrom(lines, i)
    chain.push({ tag: opens[1], open })
    ceiling = lineIndent

    if (PANEL_TAGS.has(opens[1]) || PANEL_ATTR.test(open)) break
  }

  return chain
}

/** Every `<DialogError` call site, with the two facts that have to agree. */
export function findDialogErrorInsets(file: string, source: string): DialogErrorInset[] {
  const lines = source.split('\n')
  const sites: DialogErrorInset[] = []

  for (let i = 0; i < lines.length; i++) {
    if (!/^<DialogError\b/.test(lines[i].trim())) continue

    // The call itself may be one line or four.
    let call = ''
    for (let j = i; j < lines.length; j++) {
      call += lines[j]
      if (/\/>\s*$/.test(lines[j])) break
    }

    const indent = lines[i].length - lines[i].trimStart().length
    const chain = ancestorChain(lines, i, indent)

    sites.push({
      file,
      line: i + 1,
      ancestors: chain.map((a) => a.tag),
      insetByAncestor: chain.some(
        (a) => SELF_PADDED_TAGS.has(a.tag) || PADS_HORIZONTALLY.test(a.open),
      ),
      gutterDropped: GUTTER_DROPPED.test(call),
    })
  }

  return sites
}

/** The sites whose gutter does not match the inset they already sit in. */
export function findMisinsetDialogErrors(file: string, source: string): DialogErrorInset[] {
  return findDialogErrorInsets(file, source).filter((s) => s.insetByAncestor !== s.gutterDropped)
}
