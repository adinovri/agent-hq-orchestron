/**
 * Names that stay true when the content changes (NF37).
 *
 * NF36 gave the `/settings` command block a name so its focus stop would
 * announce something: `aria-label="Restart command"` on the `<pre>`. The
 * component holding it, `CopyableCommand`, has three call sites, and the third
 * is `orchestron token rotate` — a command that invalidates every paired
 * device. So a screen-reader user tabbing that page heard "Restart command"
 * three times, once about a rotation.
 *
 * axe never saw it. `aria-allowed-attr`, `button-name`, `label` and the rest
 * all ask whether a name **exists**; none of them can ask whether it is
 * **true**, because nothing in the DOM says what the element was supposed to
 * be called. A page can be clean at page scope and still lie at every control
 * on it. That is the gap this file stands in.
 *
 * The rule it enforces is narrow enough to check mechanically:
 *
 *   > When an element's entire content is one caller-supplied expression, its
 *   > accessible name must be built from that same expression.
 *
 * A literal name on such an element is a claim about content the component
 * does not control — true for the call site that was in front of whoever
 * wrote it, and silently false for the next one. Deriving the name removes
 * the failure mode rather than documenting it: there is no "forgot to update
 * the label" state to get into.
 *
 * This is why the fix is a *derived default* and not the required prop the
 * finding suggested. A required prop forces the next call site to say
 * something; it does not force it to say something true, and the cheapest way
 * to satisfy a required prop is to copy the neighbour's — which reproduces
 * NF37 exactly.
 */

/**
 * The scrollable command block's name.
 *
 * Defaults to the command itself, in full. That looks redundant next to the
 * visible text, and is not: this `<pre>` exists in a scroll region precisely
 * because the command is wider than its box (NF36), so the visible text is
 * the part that fits and the name is the whole of it.
 *
 * `label` is for a call site that has a better name than the command — it is
 * never needed to make the default *correct*, only to make it shorter or more
 * purposeful.
 */
export function commandRegionLabel(command: string, label?: string): string {
  return label?.trim() || `Command: ${command}`
}

/**
 * The copy button's name.
 *
 * `title="Copy"` alone passes `button-name` and still leaves three buttons on
 * `/settings` with one name between them — the same defect as NF37 in a
 * different shape. The command is long, and saying it is the price of the
 * buttons being tellable apart at all; a truncated name would be ambiguous
 * again at the point it matters.
 *
 * `copied` is carried into the name so the state change the icon shows is
 * also announced, rather than being visual-only.
 */
export function commandCopyLabel(command: string, copied: boolean, label?: string): string {
  return `${copied ? 'Copied' : 'Copy'} ${label?.trim() || command}`
}

export type MisnamedRegionReason =
  /** A string-literal name on an element whose content is a variable. */
  | 'literal-name-on-dynamic-content'
  /** A computed name that shares no data with the content it names. */
  | 'name-unrelated-to-content'

export interface MisnamedRegion {
  file: string
  line: number
  reason: MisnamedRegionReason
  /** The element's content expression, as written. */
  content: string
  /** The `aria-label` value, as written. */
  name: string
}

const TAG_NAME = /^<([a-z][\w.-]*)\b/
/** `aria-label="literal"` — the shape that cannot vary with the content. */
const LITERAL_NAME = /\saria-label="([^"]*)"/
/** `aria-label={expr}`, balanced enough for the single-brace forms used here. */
const EXPR_NAME = /\saria-label=\{([\s\S]*?)\}\s*(?:\n|$)/
/** A name supplied by reference is another element's problem, not this one's. */
const LABELLEDBY = /\saria-labelledby[=\s]/

/** Bare identifiers, minus the property halves of member expressions. */
function identifiers(expr: string): string[] {
  const out: string[] = []
  const re = /(\.)?\b([A-Za-z_$][\w$]*)\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(expr))) if (!m[1]) out.push(m[2])
  return out
}

/**
 * An element's opening tag, which in this codebase is usually split over one
 * line per attribute. Returns the tag text and the index of its last line.
 */
function openingTag(lines: string[], start: number): { text: string; end: number } {
  let text = ''
  for (let i = start; i < lines.length; i++) {
    text += (i > start ? '\n' : '') + lines[i]
    if (/\/?>\s*$/.test(lines[i])) return { text, end: i }
  }
  return { text, end: lines.length - 1 }
}

/**
 * Every named element in `source` whose whole content is one expression and
 * whose name does not come from it.
 *
 * Textual rather than an AST walk, for the reason `findUnreachableScrollRegions`
 * and `findUnnamedFormControls` are: the thing being guarded against is a call
 * site copied from a neighbour, and the copy is textual.
 *
 * Scope is stated as a **property**, not as a list of tags — the batch-18 →
 * batch-19 lesson, where a scanner scoped to "the controls axe has flagged so
 * far" missed the identical defect on a control kind nobody had pointed axe
 * at yet. Here the property is "content is entirely caller-supplied", which is
 * what makes a fixed name unsafe. Elements holding literal text are out of
 * scope because a literal name for literal content cannot drift apart from
 * it; elements holding JSX (an icon, a `<option>` list) are out because their
 * content is not text and the name is the only text there is.
 */
export function findMisnamedDynamicRegions(file: string, source: string): MisnamedRegion[] {
  const lines = source.split('\n')
  const found: MisnamedRegion[] = []

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    const tag = TAG_NAME.exec(trimmed)?.[1]
    if (!tag) continue

    const { text: open, end } = openingTag(lines, i)
    if (/\/>\s*$/.test(open)) continue // self-closing: no content to disagree with
    if (LABELLEDBY.test(open)) continue

    const literal = LITERAL_NAME.exec(open)
    const expr = literal ? null : EXPR_NAME.exec(open)
    if (!literal && !expr) continue

    const close = lines.findIndex((l, n) => n > end && l.includes(`</${tag}>`))
    if (close === -1) continue

    const inner = lines
      .slice(end + 1, close)
      .join('\n')
      .trim()
    // One expression and nothing else, with no JSX inside it: the element's
    // entire content is a value its caller chose.
    if (!/^\{[\s\S]*\}$/.test(inner) || inner.includes('<')) continue

    const at = { file, line: i + 1, content: inner, name: (literal?.[1] ?? expr?.[1] ?? '').trim() }

    if (literal) {
      found.push({ ...at, reason: 'literal-name-on-dynamic-content' })
      continue
    }

    const fromContent = new Set(identifiers(inner))
    if (!identifiers(at.name).some((id) => fromContent.has(id))) {
      found.push({ ...at, reason: 'name-unrelated-to-content' })
    }
  }

  return found
}
