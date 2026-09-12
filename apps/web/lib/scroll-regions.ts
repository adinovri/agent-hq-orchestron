/**
 * Proof that a region the operator can scroll, the operator can also reach
 * (NF36).
 *
 * axe reports `scrollable-region-focusable` (impact: **serious**) on an
 * element that scrolls but is neither focusable nor contains anything
 * focusable: a mouse or a trackpad reaches the hidden content, a keyboard
 * never does. On `/settings` that was the `<pre>` holding the restart command
 * — visible up to the width of the card, and the rest unreachable without a
 * pointer.
 *
 * Scope is `<pre>`, deliberately. The rule is about regions with **no
 * focusable descendant**, and `<pre>` is the one scrollable element in this
 * app that holds only text by construction. The scrollable `<div>`s — the
 * layout `<main>`, the transcript pane, the tables, the dialog bodies — all
 * contain buttons or links, which is axe's own exemption; adding them to the
 * scanner would report failures axe does not.
 *
 * The second half is the trap this scanner exists to hold shut. `tabIndex={0}`
 * alone satisfies the rule, but a focus stop that announces nothing is a worse
 * experience than no stop: a screen reader lands somewhere and says "group"
 * or nothing at all. The obvious remedy — `aria-label` on the `<pre>` — is
 * *prohibited*: `<pre>` maps to the generic role, `aria-label` is not allowed
 * on it, and axe flags that as `aria-prohibited-attr` (serious). So a name
 * here costs a role as well (`role="group"`), and naming without one trades
 * one violation for another. That is why `name-without-role` is a finding.
 */

/** Which overflow utilities put an axis in play. */
const OVERFLOW_X = /(?:^|\s)overflow-(?:x-)?(?:auto|scroll)(?=\s|$)/
const OVERFLOW_Y = /(?:^|\s)overflow-(?:y-)?(?:auto|scroll)(?=\s|$)/

/**
 * Content that wraps cannot overflow horizontally, so `overflow-x-auto` on it
 * never produces a scrollbar and axe never flags it. `whitespace-pre-wrap` and
 * `break-all` are exactly that case — matched before `whitespace-pre`, which
 * is the one that does not wrap.
 */
const WRAPS = /(?:^|\s)(?:whitespace-(?:pre-wrap|pre-line|normal)|break-all|break-words|text-wrap)(?=\s|$)/
/** A vertical scrollbar needs a ceiling; without one the box just grows. */
const HEIGHT_CAPPED = /(?:^|\s)(?:max-)?h-(?!auto|full\b)[\w.[\]/-]+(?=\s|$)/

const CLASS_NAME = /className="([^"]*)"/
const TAB_INDEX = /\stabIndex[=\s]/
const ARIA_LABEL = /\saria-label(?:ledby)?[=\s]/
const ROLE = /\srole="/

export type ScrollRegionReason =
  /** Scrolls sideways, no keyboard way in. */
  | 'scrolls-x-unfocusable'
  /** Scrolls vertically under a height cap, no keyboard way in. */
  | 'scrolls-y-unfocusable'
  /** Focusable and named, but named through an attribute its role forbids. */
  | 'name-without-role'

export interface UnreachableScrollRegion {
  file: string
  line: number
  reason: ScrollRegionReason
  snippet: string
}

/** An element's full opening tag, which may span several lines. */
function openingTag(lines: string[], start: number): string {
  let open = ''
  for (let i = start; i < lines.length; i++) {
    open += lines[i]
    if (/\/?>\s*$/.test(lines[i])) break
  }
  return open
}

/**
 * Whether a `className` describes a box that can actually produce a
 * scrollbar — pure, and the half of this scanner worth testing on its own.
 *
 * Split by axis because the evidence differs: sideways needs non-wrapping
 * content, downwards needs a capped height. An `overflow-x-auto` on wrapping
 * text is not a latent NF36, it is a no-op utility.
 */
export function scrollAxes(className: string): { x: boolean; y: boolean } {
  const cls = ` ${className} `
  return {
    x: OVERFLOW_X.test(cls) && !WRAPS.test(cls),
    y: OVERFLOW_Y.test(cls) && HEIGHT_CAPPED.test(cls),
  }
}

/**
 * Every `<pre>` that scrolls without a keyboard route in, plus every one that
 * bought its name with a prohibited attribute.
 *
 * Textual rather than an AST walk, for the same reason as
 * `findUnnamedFormControls` and `findUnannouncedErrorSurfaces`: the invariant
 * is "whoever adds the next scrollable block copies a reachable one", and a
 * regex over the source catches exactly the copy-paste that skips it.
 */
export function findUnreachableScrollRegions(
  file: string,
  source: string,
): UnreachableScrollRegion[] {
  const lines = source.split('\n')
  const found: UnreachableScrollRegion[] = []

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!/^<pre\b/.test(trimmed)) continue

    const open = openingTag(lines, i)
    const cls = CLASS_NAME.exec(open)?.[1] ?? ''
    const axes = scrollAxes(cls)
    const at = { file, line: i + 1, snippet: trimmed.slice(0, 120) }

    if (!TAB_INDEX.test(open)) {
      if (axes.x) found.push({ ...at, reason: 'scrolls-x-unfocusable' })
      else if (axes.y) found.push({ ...at, reason: 'scrolls-y-unfocusable' })
      continue
    }

    if (ARIA_LABEL.test(open) && !ROLE.test(open)) {
      found.push({ ...at, reason: 'name-without-role' })
    }
  }

  return found
}
