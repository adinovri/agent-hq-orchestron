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
  **Commands**, **Timing**, each visually separated (a rule between
  groups, not just whitespace).
- Two-column grid with labels **right-aligned** against their values.
- **Mono font only on** the ids, paths and commands. Labels, dates and
  the status value use the body font.
- Long values **wrap** (`break-words`) rather than breaking
  mid-character at arbitrary points.
- The panel occupies the full card width — it is not squeezed into a
  narrow column beside the action buttons.
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
- **Location** has **no `tmux` row**.
- **Commands** has **no `attach` row**. If `resume` is also absent
  there is no **Commands heading at all** — an empty group is dropped
  entirely rather than rendered as a bare title.
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

- Each row stacks **label over value** instead of side by side.
- Group headings and their separators survive.
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
- **Codex sessions have no cost.** Orchestron's pricing table carries
  Claude tier rates and no codex entries, because ChatGPT
  Plus/Pro/Enterprise is flat-rate bundled. Treat codex sessions as
  N/A for cost, **not** `$0` — a scenario asserting `$0.0000` on a
  codex session is asserting the wrong thing.
- **`tmuxName` is not cleared on a headless session** — it doubles as
  an ownership token. The panel gates the tmux and attach rows on the
  session's **mode**, not on whether the field happens to be set.
