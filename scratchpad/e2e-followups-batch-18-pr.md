# batch-18 — three follow-ups from the post-batch-17 resweep

Base: `9237117` (main). Branch: `feature/e2e-followups-batch-18`.

Fixes NF32, NF33 and NF34, all filed LOW and all pre-existing. Each one is
paired with a source-level tripwire, because `apps/web`'s vitest has no DOM
(see `vitest.config.mts`) and none of these three properties can be asserted by
rendering. That is the same shape as NF30's `findUnannouncedErrorSurfaces`.

`apps/web` **254 → 280** tests, 19 files. Root `npm test` otherwise unchanged;
`apps/tui` still fails on a missing `ink`, identically to main.

---

## NF32 — Kill's error box was double-padded

`KillConfirmDialog` renders `<DialogError>` as a direct child of
`DialogContent`, which is `p-4`. `DialogError`'s default `mx-4` then added a
second 16 px, so the box sat 32 px from the dialog edge while its sibling
paragraph sat at 16.

The fix is the one the finding suggested: Kill passes `mx-0 mb-0`, like the two
other dialogs built on the primitive.

The interesting part is the guard. The obvious rule — "a `DialogError` whose
parent is padded must drop its gutter" — is **wrong**, and writing the test
first is what surfaced that: Delete Project's immediate parent is `py-2`, and
its 16 px comes from the `DialogContent` two levels up. The real invariant is
about the whole chain out to the dialog panel, and the walk has to *stop* at the
panel, because a hand-rolled backdrop carries its own `p-4` that is the gap
between the dialog and the viewport, not an inset on the content.

`findDialogErrorInsets` resolves all eleven call sites in the tree, including
the two rendered from inside a ternary branch, and
`findMisinsetDialogErrors` is empty. A test also pins the count at eleven, so a
scanner that silently stops matching fails rather than passing vacuously.

## NF33 — no `<select>` in the app had an accessible name

axe reported `select-name` (**critical**) on ten dialogs. The finding scoped it
to those, but the cause is app-wide: **all nineteen** `<select>` elements were
labelled only by an adjacent `<label>` with no `for`. Fixing the ten would have
left the identical defect in the dashboard filter bar, the projects filter and
the theme switcher, so all nineteen are fixed.

- Sixteen have a visible label → `htmlFor` + `id`, the semantic association.
- Three have none (`FilterBar`, projects group filter, `ThemeSwitcher`) →
  `aria-label`.
- Import's file input is also fixed: axe flagged it `label` (critical), and it
  is the one control in any dialog with no `placeholder` to fall back on.

Ids come from `useId`, not literals — a literal id in a component is a
duplicate the moment one is mounted twice, at which point every label points at
the first copy.

`findUnnamedFormControls` covers exactly the two control kinds axe flagged.
Text inputs and textareas are **out of scope on purpose**: axe's `label` rule
accepts `non-empty-placeholder`, every one of them has a placeholder, and a
scanner that reports failures axe does not is a scanner that gets deleted.
Checkboxes are out for the opposite reason — they are wrapped in their label,
an implicit association a regex cannot see. Three `className="hidden"` file
inputs driven by a labelled button are exempt: `display:none` keeps them out of
the accessibility tree entirely, which is why axe never flagged them.

## NF34 — Import dropped the `HTTP nnn:` prefix

Import was the one dialog of the seven that hand-rolled its own `.ok` check
instead of going through `throwIfNotOk`, and it was wrong twice:

1. It never prefixed the status, so a failed import rendered a bare JSON blob
   and an operator could not tell a 404 from a 500 without devtools. That is
   the filed finding.
2. Its `throw` sat **inside** the `try` that was meant to parse the body, so
   its own `catch` caught it, discarded the parsed `error` field, and re-threw
   the raw text. The JSON branch was unreachable from the day it was written.
   Not filed, because from the outside the two are indistinguishable.

Import now calls `throwIfNotOk`. `HTTP 500: boom`, `HTTP 404: Project not
found: abc`, `HTTP 400` on an empty body.

`findUnprefixedErrorThrows` holds the property, not the mechanism: it does not
require `throwIfNotOk` — the twelve remaining hand-rolled sites are batch-17's
deliberate deferral, not a bug — but it does require that **if you check `.ok`
yourself, the message you throw names the status**. It takes the guarded region
by brace depth, so the nested `try`/`catch` that hid NF34's second half is
inside the region rather than skipped.

---

## Not done, and why

- **The raw response body in the other twelve messages.** Still
  `HTTP 500: {"statusCode":500,…}` rather than the parsed `message`.
  `mutationErrorMessage` already exists for it; batch-17 deferred it because
  changing the text changes what live scenarios assert, and that is still true.
- **axe `color-contrast` (serious)** on Spawn's drag hint, Delete Record's four
  `text-emerald-600/70 italic` spans and Project Register's ghost button, filed
  alongside NF33. Left alone: picking replacement colours is a design decision,
  not a defect fix, and it should be made once for the palette rather than
  three times in three dialogs.
- **Inverting `DialogError`'s default** so the gutter is opt-in rather than
  opt-out. It would make forgetting the override benign in the common case,
  which is exactly how NF32 happened — but it churns the eight sites the
  resweep just measured at 17/17, to buy what the scanner now buys for free.
