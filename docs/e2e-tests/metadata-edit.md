# Metadata Edit (Pencil) — E2E Test Plan

A small pencil next to the effort chip opens a metadata-only dialog:
**Model**, **Effort**, **Use tmux**. Nothing here restarts anything —
the change is written to the record and takes effect on the next spawn.

The interesting part is the gating, and it is not one rule but two.
Model and effort are read at the next **spawn**. `useTmux` is read
first, by whatever delivers the next **turn**. That is why they have
different state gates.

Spec: [USAGE.md § Session detail page](../USAGE.md#session-detail-page) ·
[USAGE.md § Mode is locked while a session rests](../USAGE.md#mode-is-locked-while-a-session-rests)

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- `enableHeadlessMode` **on**. The masked variant is
  [`feature-flag.md`](feature-flag.md) `FLAG-05`.

**The gate matrix under test:**

| Session state | Pencil visible | Model / Effort | *Use tmux* |
|---|---|---|---|
| `succeeded` / `killed` / `failed` (either mode) | yes | editable | **editable** |
| **tmux** at `sleeping` | yes | editable | **editable** |
| **headless** at `sleeping` | yes | editable | **locked** (greyed; API 400) |
| **headless** at `idle` / `needs_input` | yes | editable | **locked** (greyed; API 400) |
| tmux at `idle` / `needs_input` | **no** | — (API 409) | — |
| `running` / `spawning` / `waiting` | **no** | — (API 409) | — |

**Read the mode column first.** The lock is not a property of a state,
it is `!useTmux && status ∈ {idle, needs_input, sleeping}` — the three
resting states of a *headless* record. Model and effort are never
locked by mode; wherever the pencil is reachable at all, they save.

The asymmetry at `sleeping` is the part worth remembering. A sleeping
**tmux** session really did give up its window, so waking it spawns —
and a spawn is exactly what makes a new mode real. A sleeping
**headless** session released nothing (see
[`headless-flow.md`](headless-flow.md) `HEADLESS-09`), so its wake
costs no spawn and a mode flip there would never become real.

---

## Scenarios

### META-01 — Edit model on a terminal session `[smoke]`

**Covers**: the ordinary case, and "applies on next spawn" meaning what
it says.

**Steps**

1. Spawn a tmux session in `e2e-claude` with an explicit model
   (`claude-haiku-4-5`). Let it reach `idle`, then Kill.
2. Click the pencil next to the effort chip.
3. Set **Model** to `claude-sonnet-5` and **Effort** to `high`. Save.
4. Read the header chips.
5. Reopen the session, leaving the reopen dialog's pickers on their
   defaults.

**Expect**

- The pencil's tooltip reads *"Edit model / effort — applies on next
  spawn"*.
- After saving, the header chips update to `claude-sonnet-5` and
  `effort:high` immediately — the record changed even though nothing
  respawned.
- The reopened session actually runs on `claude-sonnet-5`: the details
  panel's Identity group shows it, and the reopen dialog's "keep"
  default resolved to the patched value rather than the original one.

**📷 Screenshot**: `meta-01-dialog.png` — the dialog with all three
controls visible.

**Cleanup**: Kill, Delete record.

---

### META-02 — Reset to project default

**Covers**: clearing an override rather than replacing it. Without a
distinct "reset", a field could be set but never taken back off.

**Steps**

1. Take a terminal session that has an explicit model override (from
   `META-01`).
2. Open the pencil and choose the **default / inherit** option in the
   Model select — the one whose placeholder reads *"Leave blank to
   inherit project default"*. Save.
3. Read the header chip and its hover title.

**Expect**

- The chip now shows the **project's** default model (or the harness
  default for a project that sets none).
- The chip renders in the muted/italic inherited style, and its hover
  title names where the value came from — `inherited from project
  default` or `harness default (claude)`.
- Reopening resolves to that inherited value, not to the old override.

**Cleanup**: Kill, Delete record.

---

### META-03 — Pencil is hidden on an active tmux session

**Covers**: the UI half of the 409 gate.

**Steps**

1. Spawn a tmux session and let it reach `idle`.
2. Look for the pencil in the header.
3. Attempt the patch through the API anyway:

```bash
curl -s -X PATCH "$ORCH/api/sessions/<uuid>" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-5"}' -i | head -5
```

**Expect**

- **No pencil** — a live tmux session has claude already bound to a
  specific model, so a metadata edit alone would not take effect.
- The API returns **409** with a message saying to kill it or let it
  sleep first.
- Nothing on the record changed.

**Cleanup**: Kill, Delete record.

---

### META-04 — Pencil is available on a headless session at rest

**Covers**: the second visibility case. Without it the pencil would be
unreachable for the entire life of a healthy headless session, which
never reaches a terminal state on its own.

**Steps**

1. Spawn a **headless** session in `e2e-claude`, let it reach `idle`.
2. Look for the pencil.
3. Open it and change **Model** and **Effort**. Save.
4. Send a turn.

**Expect**

- The pencil **is** present at `idle` on a headless session.
- Model and effort save normally.
- The next turn runs on the new model — a headless turn spawns a fresh
  child, so "next spawn" arrives immediately rather than after a
  revival.

**📷 Screenshot**: `meta-04-headless-pencil.png` — the header at `idle`
with a Headless badge and a visible pencil.

**Cleanup**: keep this session for `META-05`.

---

### META-05 — *Use tmux* is locked at `idle` / `needs_input`

**Covers**: the narrower gate on the mode field, and the fact that a
refused mode change takes the whole patch down with it.

**Steps**

1. Use the headless session from `META-04`, at `idle`.
2. Open the pencil and inspect the **Use tmux** checkbox.
3. Attempt the change through the API, bundling a legitimate model
   edit with it:

```bash
curl -s -X PATCH "$ORCH/api/sessions/<uuid>" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"model":"claude-haiku-4-5","useTmux":true}' -i | head -5
```

4. Re-read the record.

**Expect**

- The checkbox is **greyed out** (`disabled`, and the whole label drops
  to `cursor-default`) and the dialog points at Reopen, Fork and
  Respawn instead — *"Mode is locked while the session is idle. Use
  Reopen, Fork, or Respawn to change mode."* The state name in that
  sentence is interpolated, so at `needs_input` it reads *"…while the
  session is needs_input"*.
- The dialog also **never sends the field** while locked: a locked
  checkbox is excluded from the dirty check, so Save on a
  model-only change puts no `useTmux` in the patch at all. The 400
  below is the enforcement layer, not the everyday path.
- Model and Effort in the same dialog are still live and still save.
- The API call returns **400** — not 409. The record is in a perfectly
  editable state; it is the `useTmux` field that does not belong in a
  metadata edit here. The body carries *"Cannot change mode from
  metadata edit at idle. Use Reopen/Fork/Respawn dialog for mode
  change."*
- **Nothing landed.** The `model` in that same patch was *not* applied
  — the patch is refused whole so nothing lands half-applied. Confirm
  by re-reading the record.

**📷 Screenshot**: `meta-05-mode-locked.png` — the dialog with the
greyed checkbox and its explanatory text.

**Cleanup**: Archive, Delete record.

---

### META-06 — *Use tmux* is editable on a terminal or sleeping record

**Covers**: the states where a mode change is safe, because the next
thing that reads the field is a spawn.

**Steps**

1. Take a headless session and Archive it (→ `succeeded`).
2. Open the pencil. **Tick** *Use tmux*. Save.
3. Read the header and the details panel.
4. Respawn with the dialog untouched.
5. Repeat steps 2–4 from `sleeping`, on a **tmux** session: spawn one
   with a short `ORCHESTRON_IDLE_TIMEOUT_MS`, wait for `sleeping`, then
   untick *Use tmux* and send a turn to wake it. (A *headless* session
   at `sleeping` is the locked case — `META-08`.)

**Expect**

- On the terminal record the checkbox is **live**, not greyed, and the
  helper text describes what the next run will do — *"Next run starts
  an interactive tmux session."*
- After saving, the details panel's `mode` row flips to `tmux` and the
  Headless badge state follows.
- The respawn actually runs in tmux — a window exists.
- From a **tmux** `sleeping` record, unticking and then waking delivers
  the next turn as a headless child rather than a tmux paste, and no
  tmux window is created. The wake was going to spawn either way; the
  edit only changed what it spawns.
- This is the whole reason the state alone does not decide the gate. The
  same `sleeping` pill on a headless record refuses the same edit.

**Cleanup**: Kill, Delete record on both.

---

### META-07 — Chip hover titles say where a value came from

**Covers**: the inheritance affordance, which is the only way to tell
an explicit `claude-opus-5` from an inherited one.

**Steps**

1. Spawn a session in `e2e-claude-opus` (project defaults
   `claude-opus-5` / `high`) with no dialog override. Let it settle,
   then Kill.
2. Hover the model chip and the effort chip.
3. Use the pencil to set effort explicitly to `high` — the same value
   it already had. Save. Hover the effort chip again.

**Expect**

- Before the edit: both chips render muted/italic and their hover
  titles read `inherited from project default`.
- After the edit: the effort chip renders in the normal (non-italic)
  style with **no** inheritance title, even though the value did not
  change. The styling tracks *where the value came from*, not what it
  is.
- The details panel's Identity rows carry the same hints.

**📷 Screenshot**: `meta-07-inherited-vs-explicit.png` — the chip row
before and after.

**Cleanup**: Delete record.

---

### META-08 — *Use tmux* is locked on a **sleeping headless** session

**Covers**: the state symbolic sleeping added to the lock. Before
headless sessions could sleep, `sleeping` meant "tmux, window
released", and the pencil treated it as freely editable. A headless
record now reaches the same pill by a different road — its sleep
released nothing — and the mode gate has to tell the two apart.

Get this wrong and the bug is quiet: the edit saves, then the next
send takes the tmux cold-start branch and tries to resume a transcript
the TUI never wrote.

The sleep itself, and the wake that costs nothing, are
[`headless-flow.md`](headless-flow.md) `HEADLESS-09`. This scenario is
only the pencil.

**Setup**: `idleTimeoutMs` low enough to observe — 60000 (1 min) in
`~/.orchestron/config.json`, API restarted. Restore afterwards.

**Steps**

1. Spawn a **headless** session in `e2e-claude`, let the first turn
   land in `idle`.
2. Wait out the timeout. Confirm the pill reads **`sleeping`** and the
   Headless badge is still there.
3. Open the pencil. Inspect the **Use tmux** checkbox.
4. Change **Model** only, and Save.
5. Attempt the mode change through the API:

```bash
curl -s -X PATCH "$ORCH/api/sessions/<uuid>" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"useTmux":true}' -i | head -5
```

6. Send a turn to wake the session.

**Expect**

- The pencil **is** present at `sleeping` — this is a lock on one
  field, not a hidden dialog.
- The **Use tmux** checkbox is **greyed out**, with the same Reopen /
  Fork / Respawn text as `META-05`, reading *"…while the session is
  sleeping"*.
- Step 4's model edit **saves normally**. The header chip updates.
- Step 5 returns **400**, *"Cannot change mode from metadata edit at
  sleeping."* The stored `useTmux` is still `false` — re-read the
  record.
- The wake in step 6 runs **headless**, on the **new model**, with no
  `spawning` and no tmux window created.
- Compare against `META-06` step 5: a *tmux* session at `sleeping`
  offers the same checkbox **live**. Same pill, opposite gate.

**📷 Screenshot**: `meta-08-sleeping-headless-locked.png` — the dialog
over a header showing `sleeping` + Headless, greyed checkbox and its
text in frame.

**Cleanup**: restore `idleTimeoutMs`, restart the API, then Archive and
Delete record.

---

## Notes on current shipped behaviour

- **The lock is keyed on the mode, not the state.** The condition is
  `!useTmux && status ∈ {idle, needs_input, sleeping}` in both the
  dialog (`MODE_LOCKED_STATES`) and the manager. A scenario that
  asserts "sleeping is editable" without naming a mode is asserting
  half the rule — true for tmux, false for headless since symbolic
  sleeping shipped.
- **400 and 409 are different failures and stay different.** 409 means
  the record is not editable at all right now (a live tmux session,
  anything mid-spawn) and the pencil is hidden to match. 400 means the
  record *is* editable and this one field is not — every other field in
  the same patch would have gone through.
- **A refused patch lands nothing.** The mode check runs before
  anything is written, so a `{model, useTmux}` patch that trips it
  leaves the model alone too. This is deliberate; do not write a
  scenario expecting a partial apply.
