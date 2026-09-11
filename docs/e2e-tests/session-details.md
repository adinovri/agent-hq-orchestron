# Session Details Panel — E2E Test Plan

The chevron under the timestamps expands a details panel. It used to be
one flat run of `label: value` lines in a mono font; it is now four
titled groups on a two-column grid, with mono reserved for the things
you actually copy.

The interesting behaviour is the **skip rules** — a row or a whole
group is dropped when it has nothing to say, and which rows those are
depends on the session's mode and state.

Spec: [USAGE.md § Session detail page](../USAGE.md#session-detail-page)

The grouping logic is a pure builder in
`apps/web/lib/session-details.ts` and is unit-tested there. These
scenarios cover what a user actually sees.

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- A viewport you can narrow below the `sm` breakpoint (a phone, or a
  desktop window at ~390 px).

**The four groups and their rows:**

| Group | Rows |
|---|---|
| **Identity** | session id, `<agent> session` (harness uuid), agent, model, effort, status, mode |
| **Location** | project, workspace, config dir, tmux |
| **Commands** | resume, attach |
| **Timing** | started, ended, failure, cost |

---

## Scenarios

### DETAIL-01 — Four groups on a live tmux session `[smoke]`

**Covers**: the grouping, the layout, and the typography split that
stops it reading as a terminal dump.

**Steps**

1. Open a tmux session at `idle`.
2. Click the chevron under the timestamps to expand the panel.

**Expect**

- Four group headings in order: **Identity**, **Location**,
  **Commands**, **Timing**.
- **A rule between groups, not just whitespace.** Each group after the
  first carries a top border (`border-t` + `pt-3`); the **first group
  has none** (`first:border-0 first:pt-0`) so the panel does not open
  with a doubled line under the one it already sits below.
- **Two-column grid at `sm` and up**, `sm:grid-cols-[7.5rem_minmax(0,1fr)]`
  — a fixed 7.5rem label column and a value column that takes
  everything else. Labels are **right-aligned** against their values.
- **The value sits at its content width, and the copy button follows
  it.** The `dd` is the full-width flex container — every row's `dd`
  does span the whole value column — but the span inside it is
  `min-w-0 break-words`, **deliberately not `flex-1`**. Grown to fill
  the row, the button was flung to the panel's right edge with dead
  space between it and a short value: a column of buttons aligned to
  nothing. So the button lands one `gap-1` after the text it copies,
  and its x **varies by row**. Measure it that way: values in two
  adjacent rows start at the same x (the `dd` does align), while their
  copy buttons do not. Whitespace to the right of a short row is the
  expected trade; `min-w-0` still lets a long path wrap rather than
  overflow.
- **The panel occupies the full card width.** It renders as a sibling
  *below* the flex row that holds the action buttons, not inside it —
  so the 5 × 32px `shrink-0` button column takes nothing from it. Check
  by eye at desktop width: the panel's left and right edges line up
  with the card's padding, not with the text block left of the buttons.
- **Mono font only on** the ids, paths and commands. Labels, dates and
  the status value use the body font.
- Long values **wrap** (`break-words`) rather than breaking
  mid-character at arbitrary points.
- Collapsing and re-expanding restores the same content.

**📷 Screenshot**: `detail-01-expanded.png` — the whole expanded panel.

**Cleanup**: none.

---

### DETAIL-02 — A headless session offers no tmux affordances

**Covers**: the mode-dependent skip rules. This is the one that
regressed once — a headless session was being offered an `attach`
command against a tmux window that does not exist.

**Steps**

1. Open a **headless** session at `idle` and expand the panel.
2. Compare against a tmux session's panel.

**Expect**

- **Identity → mode** reads `headless`, with a hover title describing
  one-shot processes and nothing to attach to.
- **Location has no `tmux` row** — not a blank one, not one reading
  the record's `tmuxName`. The row is gated on the resolved mode
  (`session.useTmux ?? true`), **not** on whether `tmuxName` is set.
- **Commands has no `attach` row**, and there is **no attach command
  anywhere on the page** for this session — no copy button offering
  `tmux attach -rt …`, and nothing in the header's action row either.
  Same gate.
- Confirm the gate is really the mode, not an empty field: a headless
  record **still carries a `tmuxName`** (it doubles as an ownership
  token). Read it from
  `GET /api/sessions/<uuid>` — it is non-null, and both rows are still
  correctly absent. A scenario that gets these rows to disappear by
  clearing `tmuxName` has tested the wrong condition.
- If `resume` is also absent there is no **Commands heading at all** —
  an empty group is dropped entirely rather than rendered as a bare
  title.
- The tmux session, by contrast, shows `mode: tmux`, a `tmux` row and
  an `attach` row.

**📷 Screenshot**: `detail-02-headless-vs-tmux.png` — the two panels
side by side.

**Cleanup**: none.

---

### DETAIL-03 — `config dir` is present and correct

**Covers**: the most load-bearing of the fields added in the redesign.
A resume run against a different `CLAUDE_CONFIG_DIR` cannot find the
transcript, and before this row there was no way to see which one a
session captured.

**Steps**

1. Open a session spawned in a project that **sets** a config-dir
   override, and read **Location → config dir**.
2. Open a session from a project that sets none.
3. Copy the value with its copy button and paste it somewhere.

**Expect**

- The row shows the `CLAUDE_CONFIG_DIR` captured at spawn (or
  `CODEX_HOME` for a codex session), in mono.
- Its hover title explains that a resume must use the same one or the
  transcript will not be found.
- For a project with no override, the value is the harness default —
  the row is not blank and not omitted.
- The copy button copies the exact path.

**Cleanup**: none.

---

### DETAIL-04 — Copy buttons

**Covers**: every row that offers one.

**Steps**

For each of: session id, harness session id, workspace, config dir,
tmux name, resume command, attach command —

1. Click the copy button.
2. Paste and compare.

**Expect**

- Each copies its own exact value, not the label and not a neighbour.
- The button gives visual confirmation (icon swap) after a click.
- The **resume** command is runnable as pasted: `cd`-ing to the
  workspace and running it resumes the conversation in your own
  terminal. Try it once on a terminal session.
- The **attach** command attaches **read-only** (`tmux attach -rt …`)
  so an accidental keystroke cannot disturb a live session.

**📷 Screenshot**: `detail-04-copy-confirm.png` — a row mid-copy with
its confirmation state.

**Cleanup**: detach from tmux with the prefix + `d`.

---

### DETAIL-05 — Rows appear only when they have something to say

**Covers**: the remaining skip rules, across four session shapes.

**Steps**, expanding the panel on each:

1. A **live** session (`idle`).
2. A **terminal** session (`succeeded`).
3. A **failed** session (from `LIFE-03`).
4. A session that has not been assigned a harness uuid yet
   (catch one during `spawning`).

**Expect**

1. **Timing** has `started` but **no `ended`**.
2. **Timing** has both `started` and `ended`; `cost` appears once the
   session has a `costUsd`, rendered as `$0.1858` with a muted `USD`
   hint beside it.
3. **Timing** additionally shows a `failure` row carrying the reason.
4. **Identity** omits the `<agent> session` row entirely until the
   harness uuid exists — it is not rendered blank or as `undefined`.
- Across all four, no group heading is ever shown above zero rows.

**📷 Screenshot**: `detail-05-failed-timing.png` — the Timing group of
the failed session.

**Cleanup**: none.

---

### DETAIL-06 — Mobile layout

**Covers**: the `<sm` stacking. The two-column grid does not survive a
phone, and the fallback has to stay readable rather than collapsing
into an unreadable run.

**Steps**

1. Narrow the viewport to ~390 px (or open on a phone).
2. Expand the panel on a tmux session.
3. Scroll through all four groups.

**Expect**

- Each row stacks **label over value** instead of side by side — the
  grid is `sm:`-prefixed, so below the breakpoint there is no grid at
  all and the row falls back to normal flow.
- Group headings and their separators survive; the first group still
  has no top rule.
- Values still use the **full card width** here — this is the
  breakpoint the full-width fix was made for. On a 390px phone no value
  should be wrapping at ~20 characters against a half-empty card.
- No horizontal scrolling. Long paths and commands wrap within the
  card.
- The copy buttons remain tappable — they do not shrink below a usable
  target or overlap the value.

**📷 Screenshot**: `detail-06-mobile.png` — the panel at 390 px.

**Cleanup**: none.

---

### DETAIL-07 — Model and effort hints agree with the header chips

**Covers**: the panel and the header telling the same story about where
a value came from.

**Steps**

1. Open a session that **inherits** both model and effort from its
   project.
2. Compare the header chips with the panel's Identity rows.
3. Repeat on a session with explicit overrides.

**Expect**

- Inherited values carry an inheritance hint in **both** places, naming
  the same source (project, or harness default).
- Explicit values carry no hint in either.
- The two never disagree — the panel is built from the same effective
  values the chips render.

**Cleanup**: none.

---

## Notes on current shipped behaviour

- **`status` appears in both the panel and the always-visible
  StatusPill.** That duplication is deliberate for now but was flagged
  as the first row to drop if it reads as noise. If it disappears,
  `DETAIL-01`'s group table is what needs updating.
- **Cost is USD-only** because `costUsd` is the only field on the
  record. It renders as `$0.1858` with a muted `USD` hint rather than
  pretending to be currency-aware.
- **`costUsd` on the record is a headless-only floor, not a session
  total.** It accumulates across turns as of the batch-2 follow-ups, but
  a tmux session still records `0`: cost is parsed out of the headless
  `-p` result envelope, which that path never produces. Do not build a
  budget assertion on this field. `GET /api/metrics` prices tmux turns
  from the JSONL and accumulates correctly — it is the authority for any
  figure that has to be right.
- **The record and `/api/metrics` are not expected to agree, even on a
  headless session.** They are two different measurements: the record
  sums the harness-reported `total_cost_usd` of each `-p` envelope, while
  `/api/metrics` prices the JSONL token counts against Orchestron's own
  rate table. The record runs *under* the endpoint: 12–25% over the
  2026-09-10 sweep, 2.8–26.6% over the 2026-09-11 one. **The size of the
  gap does not track turn count** — the 2026-09-11 sweep put two
  single-turn sessions at opposite ends of that spread (−2.8% and
  −26.6%) with the five-turn session in between, so treat the gap as a
  range, not as something that grows with the session. Neither figure is
  wrong; they are simply not interchangeable, so reconciling them is not
  a bug hunt worth starting. **Gate budgets on `/api/metrics`.**
  *Both ranges in this bullet, and their direction, are superseded — see
  the post-batch-5 measurement two bullets down.*
- **Both ranges above were measured against a broken endpoint.** Prior to
  the batch-5 fix, `/api/metrics` under-priced by 5-18.75x when the model
  changed mid-session, and double-counted headless assistant messages by
  about 2x. Both fixed at `bea9327`. Concretely: Claude Code writes a
  split assistant message (thinking row + text row) as two rollout rows
  sharing one `message.id` and one `usage` object, and the collector
  summed both, so every headless total read exactly 2x; and the whole
  token total was priced at the rate of the last billed event's model,
  so a session that switched model mid-way priced its earlier turns at
  the wrong tier. The 12-25% and 2.8-26.6% gaps recorded above therefore
  measure the record against a figure that was itself wrong, and should
  be re-measured before either range is quoted again. The advice to gate
  budgets on `/api/metrics` holds from `bea9327` forward, not before it.
- **Update 2026-09-11, post-batch-5 — the endpoint is the authority, and
  the gap runs the other way.** After the NF9 dedup and NF10 per-event
  pricing fixes, `/api/metrics` is authoritative for the token-based cost
  Orchestron actually controls. The session record's `costUsd` is the
  harness's `total_cost_usd` per `-p` envelope, which includes cache
  reads, tool costs and other overhead the Orchestron price table does
  not model. Re-measured against the fixed endpoint, the record sits
  **+58–67% above** it: the record **over**-counts, the endpoint does not
  under-count — the opposite of the sign recorded before the fix. This
  is revision four of this note and the one to quote: `8169523`
  (batch-3) stated the two figures are not interchangeable, `3414608`
  (batch-4) dropped the "widens with turn count" claim, `7fdf409`
  (batch-5) flagged that the ranges were measured against a broken
  endpoint, and this entry supplies the corrected direction and
  magnitude. **Use `/api/metrics` for budget gating.**
- **Codex sessions have no cost.** Orchestron's pricing table carries
  Claude tier rates and no codex entries, because ChatGPT
  Plus/Pro/Enterprise is flat-rate bundled. Treat codex sessions as
  N/A for cost, **not** `$0` — a scenario asserting `$0.0000` on a
  codex session is asserting the wrong thing.
- **The layout assertions in `DETAIL-01` name classes on purpose.**
  Full-width and the rules between groups are the kind of regression
  that reads as "looks slightly off" rather than as a failure, so the
  scenario pins the mechanism (`grid-cols-[7.5rem_minmax(0,1fr)]`,
  `min-w-0 break-words` on the value span — **not** `flex-1`, which the
  code documents rejecting — `border-t` + `first:border-0`, panel as a
  sibling of the button row) and not just the impression. If a redesign
  reaches the same look another way, update the scenario — do not
  delete the assertion.
- **`tmuxName` is not cleared on a headless session** — it doubles as
  an ownership token. The panel gates the tmux and attach rows on the
  session's **mode**, not on whether the field happens to be set.
