/**
 * Proof that a form control the operator can reach has a name they can hear
 * (NF33).
 *
 * The axe pass added for NF30 found `select-name` (impact: **critical**) on
 * ten dialogs. Every `<select>` in the app was labelled the same way — an
 * adjacent `<label>` with no `for`, no `id` on the control, no `aria-label`.
 * Sighted operators read the pairing off the layout; a screen reader announces
 * "combobox, e2e-claude" and nothing about what is being chosen. NF30 made a
 * dialog's *failure* audible; this is the *form* still being partly mute.
 *
 * Scope is the control kinds for which a `placeholder` cannot stand in as the
 * accessible name — which is the property axe is actually measuring, not the
 * list of nodes it happened to flag on one run:
 *
 *   • **`<select>`** — `placeholder` is not valid on it, so an unassociated
 *     label is the whole accessible name story. Ten dialogs, nineteen nodes.
 *   • **`<input type="file">`** — Import's, the one text-ish control in any
 *     dialog with no placeholder to fall back on (`label`, critical).
 *   • **`<input type="date">`** — added for NF35. Browsers render their own
 *     date UI and **ignore `placeholder` entirely** on this type, so axe's
 *     `non-empty-placeholder` escape is unavailable by construction, exactly
 *     as it is for the two above. Four nodes: the `/dashboard` filter pair and
 *     the `/metrics` range pair.
 *
 * NF35 is worth reading as a scoping lesson rather than a miss. The original
 * scope — "the kinds axe flagged" — was sound reasoning over an incomplete
 * input: axe had only ever been run inside `[role="dialog"]`, and there is no
 * date input in any dialog. Page-scope axe found them the moment it was run.
 * The scope is now stated as the *property* (no placeholder fallback), so the
 * next control kind with that property is in scope before a sweep finds it.
 *
 * Text inputs and textareas are still left out on purpose rather than by
 * oversight: axe's `label` rule accepts `non-empty-placeholder`, every one of
 * them has a placeholder, and widening the scanner to them would report
 * failures axe does not — a tripwire that cries wolf gets deleted. Checkboxes
 * are out for the opposite reason: they are wrapped in their `<label>`, which
 * is an implicit association a regex cannot see, so they would be false
 * positives.
 */

/**
 * `display: none` — the control is not in the accessibility tree at all, so
 * there is nothing to name and axe does not report it.
 *
 * Three file inputs in this app are `className="hidden"` and driven by a
 * labelled button next to them; that is a correct pattern, not a gap. The
 * responsive guard matters: `hidden sm:block` is only hidden on small screens
 * and is reachable everywhere else, so it does not earn the exemption.
 */
const VISUALLY_REMOVED = /className="[^"]*\bhidden\b[^"]*"/
const UNHIDDEN_AT_BREAKPOINT = /:(?:block|flex|inline|inline-block|inline-flex|grid|table)\b/

/** The attributes that name a control outright. */
const DIRECT_NAME = /\saria-label(?:ledby)?[=\s]/
/** `id={`${uid}-model`}` / `id="theme"` — captures the value as written. */
const ID_ATTR = /\sid=(\{[^}]*\}|"[^"]*")/
/** `htmlFor={…}` in the same file, spelled exactly as the `id` is. */
const HTML_FOR = /\shtmlFor=(\{[^}]*\}|"[^"]*")/g

export interface UnnamedControl {
  file: string
  line: number
  tag: string
  /** Why it has no name — the distinction a fixer needs. */
  reason: 'no-id-no-aria' | 'id-without-label'
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

/** The `input` types in scope — those where `placeholder` names nothing. */
const NAMEABLE_INPUT_TYPES = /type="(file|date)"/

/**
 * Every `<select>`, file input or date input a screen reader would announce
 * unnamed.
 *
 * Textual rather than an AST walk, for the same reason as
 * `findUnannouncedErrorSurfaces`: the invariant is "whoever adds the next
 * control copies a labelled one", and a regex over the source catches exactly
 * the copy-paste that skips it.
 */
export function findUnnamedFormControls(file: string, source: string): UnnamedControl[] {
  const lines = source.split('\n')

  const labelled = new Set<string>()
  for (const m of source.matchAll(HTML_FOR)) labelled.add(m[1])

  const found: UnnamedControl[] = []

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!/^<(select|input)\b/.test(trimmed)) continue

    const open = openingTag(lines, i)
    const tag = /^<(select|input)\b/.exec(trimmed)![1]
    if (tag === 'input' && !NAMEABLE_INPUT_TYPES.test(open)) continue

    if (VISUALLY_REMOVED.test(open) && !UNHIDDEN_AT_BREAKPOINT.test(open)) continue
    if (DIRECT_NAME.test(open)) continue

    const id = ID_ATTR.exec(open)
    if (!id) {
      found.push({ file, line: i + 1, tag, reason: 'no-id-no-aria', snippet: trimmed })
      continue
    }
    if (!labelled.has(id[1])) {
      found.push({ file, line: i + 1, tag, reason: 'id-without-label', snippet: trimmed })
    }
  }

  return found
}
