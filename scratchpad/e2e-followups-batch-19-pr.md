# batch-19 — name the date inputs, let the keyboard into the scrollers

Base: `8e3c38c` (main). Branch: `feature/e2e-followups-batch-19`.

Two findings from the post-batch-18 resweep, both LOW, both pre-existing, and
both invisible to every sweep before batch-18 for the same reason: **axe had
only ever been run inside `[role="dialog"]`**. Neither defect is in a dialog.

---

## NF35 — four `input[type="date"]` with no accessible name

`label` (impact: **critical**), 4 nodes: the `/dashboard` filter pair
(`FilterBar.tsx`) and the `/metrics` range pair (`DateRangePicker.tsx`). None
had `aria-label`, `label[for]`, a wrapping label or a `title`. A screen-reader
operator tabbing the filter bar heard "date picker, blank" twice, with nothing
separating the start of the range from the end.

**Fix:** `aria-label="From date"` / `aria-label="To date"` on both pairs.

`aria-label` rather than a `<label htmlFor>` because neither pair has visible
label text to point at — the same call batch-18 made for the three selects in
`FilterBar`, the `/projects` group filter and `ThemeSwitcher`. Adding visible
labels would put two new words into a filter row that is already at its width
budget; a visually-hidden `<label>` would be a second naming pattern for the
identical situation. One pattern, applied where it applies.

### The scoping lesson is the more useful half

This is the defect class NF33 fixed, in the one control kind its scanner
deliberately scoped out. That scope was "exactly the control kinds axe
flagged" — sound reasoning over an incomplete input, because axe had never
been pointed at a page and no dialog in this app contains a date input.

`findUnnamedFormControls` now scopes by the **property** instead: the control
kinds for which `placeholder` cannot serve as the accessible name. That is
`<select>` (placeholder is not valid on it), `input[type=file]` (no
placeholder to fall back on), and now `input[type=date]` — browsers render
their own date UI and ignore `placeholder` entirely, so axe's
`non-empty-placeholder` escape is unavailable **by construction**, exactly as
for the other two. Text inputs and textareas stay out for the same reason as
before: axe accepts their placeholder, and a tripwire that cries wolf gets
deleted.

Stated as a property, the next control kind with that property is in scope
before a sweep finds it.

Tests: three unit cases (bare date input flagged; named one accepted; a
`placeholder` on a date input does **not** name it), plus a pinned count of 4
date inputs app-wide so the scanner cannot pass vacuously.

---

## NF36 — a scrollable region with no keyboard route in

`scrollable-region-focusable` (impact: **serious**), 1 node at `/settings`: the
`<pre>` holding the restart command. `overflow-x-auto whitespace-pre`, so it
genuinely scrolls; no `tabIndex`, so a keyboard-only operator could read as far
as the card is wide and had no way to reach the rest of the command.

**Fix:** `tabIndex={0}` + `role="group"` + `aria-label`, plus a
`focus-visible` ring so the new stop is visible when it is reached.

### Two things the fix had to get right that the finding does not say

**The name costs a role.** `tabIndex={0}` alone satisfies the rule, but a focus
stop that announces nothing is worse than no stop. The obvious remedy —
`aria-label` on the `<pre>` — is *prohibited*: `<pre>` maps to the generic
role, `aria-label` is not allowed there, and axe flags it as
`aria-prohibited-attr` (serious). Naming without a role trades one violation
for another. `role="group"` is the cheapest role that legally takes a name and
adds no landmark noise.

**There were two, not one.** The sweep reported `/settings` because that is the
page it had open. `TranscriptPanePoll.tsx:181` — the expanded tool-result block,
`max-h-64 overflow-y-auto` — has the identical defect and only escaped because
no transcript on screen at scan time had a result long enough to overflow 16rem.
Fixed with it. The class, not the node.

**And one that is not a defect.** `TranscriptPanePoll.tsx:162` carries
`overflow-x-auto` but also `whitespace-pre-wrap break-all`: the content wraps,
so it can never produce a horizontal scrollbar and axe never flags it. It gets
no `tabIndex` — a tab stop on a box that does not scroll is noise for exactly
the operator this change is for.

### The scanner

New `lib/scroll-regions.ts`. `scrollAxes(className)` is pure and split by axis
because the evidence differs: sideways needs non-wrapping content, downwards
needs a capped height. `overflow-x-auto` on wrapping text is not a latent NF36,
it is a no-op utility.

Scope is `<pre>`, deliberately. axe's rule is about regions with **no focusable
descendant**, and `<pre>` is the one scrollable element here that holds only
text by construction. Every scrollable `<div>` in this app — the layout
`<main>`, the transcript pane, the tables, the dialog bodies — contains buttons
or links, which is axe's own exemption.

`name-without-role` is a third finding kind so the `aria-prohibited-attr` trap
above cannot be walked into by the next person.

Verified as a tripwire, not just as a green test: run against the source at
`8e3c38c` it reports `settings/page.tsx:44 scrolls-x-unfocusable` and
`TranscriptPanePoll.tsx:181 scrolls-y-unfocusable`, and nothing else.

Tests: 6 `scrollAxes` cases, 5 finder cases, a pinned count of 4 `<pre>`
app-wide, and a clean whole-app scan.

---

## Docs — `00-setup.md` §11, "run axe at **both** scopes"

The convention that produced these two findings existed only in one sweep
prompt. Written down now: **page scope on every route visited, dialog scope on
every dialog opened — not one or the other**, with the route list.

Three things that cost time and are now in the doc:

- **Do not add the two counts.** Base UI puts `role="dialog"` on the same
  element that carries `data-slot="dialog-content"`, so a page-scope run
  already contains every node a dialog-scope run reports. Summing double-counts.
- **Read impact, not just count.** A page-scope baseline is not zero.
  `/dashboard` carries a standing `color-contrast` population (10 nodes at
  `29081b5`) that is a design decision. What a sweep watches is critical and
  serious, and whether contrast *grew*.
- **The two source scanners** and what each stands in for, plus why a failing
  count assertion means re-read the scanner rather than bump the number.

---

## Tests

| workspace | result |
|---|---|
| `scripts/e2e-env.test.sh` | 20/20 |
| `packages/file-store` | 11/11 |
| `apps/api` | 699/699 |
| `apps/cli` | 138/138 |
| `apps/web` | **298/298** (280 → 298) |
| `apps/tui` | FAIL — `ink` not installed, **pre-existing**, identical at `main` |

`apps/api` needs `npm run build` in a fresh worktree before its suite resolves
`@agent-hq-orchestron/file-store`; that is worktree setup, not a regression.
