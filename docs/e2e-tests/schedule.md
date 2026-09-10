# Schedules — E2E Test Plan

Cron entries that spawn a session on a cadence. A schedule can pin
**Model**, **Effort** and **Use tmux**, or leave any of them to its
project.

The semantics worth testing: these are **overrides, not snapshots**. A
field left at Default resolves against the project *at the moment the
schedule fires*, so changing a project's default model moves every
schedule that did not pin one.

Spec: [USAGE.md § Schedules](../USAGE.md#4-schedules) ·
[USAGE.md § Model, effort and run mode](../USAGE.md#41-model-effort-and-run-mode) ·
[USAGE.md § YAML shape](../USAGE.md#42-yaml-shape)

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- `enableHeadlessMode` **on**. The masked variant is
  [`feature-flag.md`](feature-flag.md) `FLAG-06`.
- Fixture projects `e2e-claude` (no defaults) and `e2e-claude-opus`
  (`claude-opus-5` / `high`).
- Nothing important on the Schedules page — `SCHED-07` imports in
  `replace` mode, which wipes existing entries. **Export a YAML backup
  first if the host has real schedules on it.**

---

## Scenarios

### SCHED-01 — Create a schedule and run it once `[smoke]`

**Covers**: creation, the live preview, and the run-once button.

**Steps**

1. Dashboard → **Schedules**.
2. Create a schedule: project `e2e-claude`, cron `0 9 * * 1`, prompt
   the *Fast prompt*.
3. While typing the cron, read the preview area.
4. Save, then click **run-once** on the new entry.

**Expect**

- Live preview shows the **next 3 fires** as you type, plus a
  human-readable description of the expression underneath.
- Preset buttons (hourly, daily 9am, weekly Mon 9am, …) fill the field.
- An invalid expression (`* * * *`, four fields) shows *"Invalid cron
  expression"* and blocks save.
- **Save** is disabled until project, cron and prompt are all present.
- Run-once spawns a session immediately: it appears on the dashboard in
  the right project and reaches `idle`.
- The spawned session's prompt is the schedule's prompt.

**📷 Screenshot**: `sched-01-preview.png` — the dialog with cron typed
and the next-3-fires preview visible.

**Cleanup**: Kill and Delete record on the spawned session. Keep the
schedule for `SCHED-02`.

---

### SCHED-02 — A schedule that pins nothing follows its project

**Covers**: the override-not-snapshot semantics, which is the whole
design of these three fields.

**Steps**

1. Use the schedule from `SCHED-01`, with Model, Effort and *Use tmux*
   all left at Default. Note the list row's badges.
2. Open the Projects page and change `e2e-claude`'s default model to
   `claude-haiku-4-5`.
3. Back on Schedules, run the entry once.
4. Read the spawned session's model chip.
5. Change the project's default model back and run once again.

**Expect**

- The list row shows **no badges at all** — the badges name only the
  fields a schedule pins for itself.
- The run in step 3 uses `claude-haiku-4-5`. The schedule tracked the
  project's *current* value; it did not snapshot anything at creation.
- Step 5's run follows the project again.
- The dropdowns in the dialog name what Default currently resolves to
  (`Default — claude-haiku-4-5 (project)`), so the choice is between
  two concrete values rather than between a value and a blank.

**📷 Screenshot**: `sched-02-default-row-label.png` — the Model
dropdown open, showing the resolved Default row.

**Cleanup**: Kill and Delete record on both spawned sessions. Restore
`e2e-claude`'s default model.

---

### SCHED-03 — Pin model, effort and mode

**Covers**: the pinned half, and the badges.

**Steps**

1. Edit the schedule: set Model `claude-sonnet-5`, Effort `low`, and
   **untick** *Use tmux*. Save.
2. Read the list row.
3. Run once and read the spawned session.
4. Change `e2e-claude`'s default model to something else and run again.

**Expect**

- The list row shows **three badges**: the model, `effort low`, and
  `headless`. Their hover titles say each overrides the project
  default.
- The spawned session runs on `claude-sonnet-5` / `effort:low` and is
  **headless** — Headless badge present, no tmux window, lands `idle`.
- Step 4's run still uses `claude-sonnet-5`. A pinned value is
  permanent; nothing tracks the project back afterwards.

**📷 Screenshot**: `sched-03-badges.png` — the list row with all three
badges.

**Cleanup**: Kill/Archive and Delete record on the spawned sessions.

---

### SCHED-04 — Clearing an override

**Covers**: taking a pin back off. Over the wire an absent key means
"leave whatever is stored alone", so clearing needs its own spelling —
`''` for the strings, `null` for the boolean. Getting this wrong means
the dialog can set an override but never remove one.

**Steps**

1. Start from the fully-pinned schedule from `SCHED-03`.
2. Edit it: set Model and Effort back to **Default**, and set *Use
   tmux* back to the project-following state. Save.
3. Read the list row.
4. Export the YAML and inspect the entry.

**Expect**

- All three badges are **gone** from the list row.
- The exported YAML entry has **no** `model`, `effort` or `useTmux`
  keys at all — not `model: ""`, not `useTmux: null`. Export writes the
  three fields only for schedules that pin them.
- Running once now follows the project again.

**📷 Screenshot**: `sched-04-cleared.png` — the list row with no
badges, alongside the YAML entry.

**Cleanup**: keep the schedule for `SCHED-06`.

---

### SCHED-05 — Project is read-only on edit

**Covers**: the deliberate restriction. Moving a schedule to another
project would change what every other field on it means — the catalogs
are per-harness and the defaults it falls back to belong to the old
project.

**Steps**

1. Open an existing schedule for **edit**.
2. Look at the Project control.
3. Open the **create** dialog and look at the same control.

**Expect**

- On edit: the project renders as **static text** (the project's name),
  not a dropdown. There is no way to change it in the UI.
- On create: it is a normal dropdown.
- Moving a schedule between projects is a delete-and-recreate, and the
  UI does not pretend otherwise.
- *(API-level note: `PATCH /api/schedules/:id` still accepts
  `projectId` — the read-only rule is a UI decision, so CLI and YAML
  import can legitimately rewrite it. Do not assert a 4xx here.)*

**📷 Screenshot**: `sched-05-project-readonly.png` — the edit dialog
with the static project field.

**Cleanup**: Cancel.

---

### SCHED-06 — Pause, resume, delete

**Covers**: the remaining row actions.

**Steps**

1. Pause a schedule. Read the row.
2. Resume it.
3. Delete it and confirm.

**Expect**

- A paused entry is visibly distinguished in the list and its next-fire
  preview reflects that it will not fire.
- Run-once still works while paused (it is a manual trigger, not the
  cron).
- Resume restores it.
- Delete removes the row; a reload confirms it is gone from storage.

**Cleanup**: none.

---

### SCHED-07 — YAML export and import

**Covers**: the round trip, `merge` vs `replace`, and per-entry
validation.

**Steps**

1. Create two schedules — one pinning all three fields, one pinning
   none.
2. **Export** and save the YAML. Read it.
3. Delete both schedules.
4. **Import** the YAML with `?mode=merge`. Compare the result to
   step 1.
5. Hand-edit the YAML to add a third entry with `effort: enormous`, and
   import again with `?mode=merge`.
6. Import the original YAML with `?mode=replace`.

**Expect**

- The export contains a top-level `schedules:` list. Each entry carries
  `id`, `cron`, `projectId`, `prompt`, `enabled`, `createdAt`, and
  `model` / `effort` / `useTmux` **only where pinned**.
- The import in step 4 restores both schedules exactly — same cron,
  same prompt, same badges. The document round-trips unchanged.
- In step 5 the bad entry is **reported in the import summary's
  `errors` and skipped**, while the valid entries still import. Valid
  efforts are `low | medium | high | xhigh | max | ultra`.
- `replace` wipes existing entries first; `merge` keeps them.
- A YAML written before these three fields existed imports fine —
  every schedule in it simply follows its project. Test by deleting the
  three keys from an entry by hand and re-importing.

**📷 Screenshot**: `sched-07-import-summary.png` — the summary showing
the skipped entry and its error.

**Cleanup**: delete the fixture schedules; re-import your backup if you
took one.

---

### SCHED-08 — A fire against a deleted project fails visibly

**Covers**: the claim that a schedule is not a privileged path. Each
fire calls the local `POST /api/sessions` with the same bearer token,
so the same project checks apply as to an interactive spawn.

**Steps**

1. Register a throwaway project `e2e-doomed` at
   `/tmp/orchestron-e2e/ws-doomed`.
2. Create a schedule against it with the *Fast prompt*.
3. Delete the project from the Projects page, reading the confirm
   dialog on the way past.
4. Run the schedule once.

**Expect**

- The project delete dialog warns that new spawns and scheduled runs
  targeting the deleted id will fail.
- The run-once **fails**, and the failure is visible on the schedule's
  row — its last-run state, not swallowed silently.
- **No session record is created** for the refused fire; the dashboard
  count is unchanged.
- The schedule itself survives the failure and is still editable — a
  bad fire does not delete or disable the entry.

**📷 Screenshot**: `sched-08-failed-fire.png` — the schedule row after
the failed run.

**Cleanup**: delete the schedule. `rmdir /tmp/orchestron-e2e/ws-doomed`.

---

## Notes on current shipped behaviour

- **The fire-time body omits unpinned fields.** A schedule that pins
  nothing sends no `model` / `effort` / `useTmux` at all, so the spawn
  route resolves `?? project.default…` at that moment. There is no
  separate resolution logic on the scheduler side — it simply stopped
  discarding the information.
- **`PATCH /api/schedules/:id` is validated and whitelisted.** It used
  to spread the raw request body into the stored record, so any key at
  all landed in the JSON file. It does not any more; a scenario
  asserting that junk keys persist is testing a fixed bug.
- **With `enableHeadlessMode` off**, the *Use tmux* checkbox is hidden
  and the mode is left out of what the dialog saves — a schedule
  already configured headless keeps that stored preference and gets it
  back when the switch is flipped on. See
  [`feature-flag.md`](feature-flag.md) `FLAG-06`.
