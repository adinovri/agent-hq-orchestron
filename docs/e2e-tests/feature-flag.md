# Headless Kill Switch — E2E Test Plan

`"enableHeadlessMode": false` in `~/.orchestron/config.json` is the
fleet-wide off switch for headless mode.

It **masks** rather than blocks. Nothing errors: a headless request is
quietly run as tmux and the response says so. The UI removes the choice
instead of showing one it cannot honour. Two things follow, and both
are what this file tests: every *Use tmux* control disappears, and
every mutation that asked for headless comes back with a `coerced`
field and a toast.

Spec: [USAGE.md § Disabling it globally](../USAGE.md#disabling-it-globally)

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- Fixture projects `e2e-claude`, `e2e-headless` (project default:
  headless), and at least one **existing headless session record** in a
  terminal state, created while the switch was on. Make one now:
  spawn headless (`SPAWN-05`), let it reach `idle`, Archive it.
- Fixture **schedule** pinning `useTmux: false` (`SCHED-03`).

**Turning the switch off:**

```bash
# add "enableHeadlessMode": false to ~/.orchestron/config.json
# the config is read once at boot — restart the API
```

**Every scenario below assumes the switch is off unless it says
otherwise. `FLAG-08` restores it — do not stop before that.**

`FLAG-02` and `FLAG-03` carry `[smoke]` markers but are **not** part of
the main smoke table in [`README.md`](README.md#smoke-set) — flipping
the switch and restarting the API breaks every other smoke scenario's
preconditions. They are their own sweep. Run this file top to bottom,
or not at all.

---

## Scenarios

### FLAG-01 — Settings reports the state

**Covers**: the operator being able to find out, without reading the
config file.

**Steps**

1. With the switch **on**, open Settings → Server Info.
2. Turn the switch off, restart the API, reload, and look again.
3. Also read it over the API:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/health/detail" \
  | python3 -m json.tool | grep -i headless
```

**Expect**

- Server Info shows the current state of the switch in both cases.
- With it off, it additionally notes that existing headless sessions
  get coerced on their next spawn.
- `/api/health/detail` reports `enableHeadlessMode: false`.
- Note: `/api/health` (unauthenticated) reports only `{"ok":true}` —
  the detail endpoint is behind the bearer token.

**📷 Screenshot**: `flag-01-server-info.png` — the Server Info panel
with the switch off.

**Cleanup**: none.

---

### FLAG-02 — Every *Use tmux* control is hidden `[smoke]`

**Covers**: the masking. With headless unavailable there is one mode
left and nothing to choose, so a checked-and-disabled box would only
invite the question.

**Steps**, with the switch off, opening each in turn:

1. Spawn dialog.
2. Project dialog (create and edit).
3. Session pencil, on a terminal session.
4. Reopen dialog.
5. Fork dialog.
6. Respawn dialog.
7. Adopt dialog.
8. Import bundle dialog.
9. Schedule dialog (create and edit).

**Expect**

- The *Use tmux* checkbox and its helper text are **absent** from all
  nine — not present-but-disabled.
- Everything else in each dialog behaves normally. Nothing is broken by
  the missing control, and no layout gap is left where it was.

**📷 Screenshot**: `flag-02-hidden-toggle.png` — the Spawn dialog and
the pencil dialog side by side, both without the checkbox.

**Cleanup**: Cancel each.

---

### FLAG-03 — A headless request is coerced, and says so `[smoke]`

**Covers**: the `coerced` field and the toast that keeps the masking
from being silent.

**Steps**

1. Spawn via the API with an explicit `useTmux: false`:

```bash
curl -s -X POST "$ORCH/api/sessions" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"projectId":"<e2e-claude id>","useTmux":false,"prompt":"Reply with: ready."}' \
  | python3 -m json.tool | grep -A3 -i 'coerced\|useTmux'
```

2. In the UI, spawn into project **`e2e-headless`** (whose default is
   headless) with the dialog untouched.
3. For contrast, spawn an ordinary tmux session into `e2e-claude`.

**Expect**

- Step 1: HTTP **201**, not an error. The body has `useTmux: true` and
  a `coerced` object naming the reason.
- Step 2: the session runs in **tmux** — a tmux window exists, no
  Headless badge — and a **warn toast** appears reading *"Headless mode
  is disabled globally — this session runs in tmux."* with a detail
  line pointing at `enableHeadlessMode: true` in
  `~/.orchestron/config.json`.
- Step 3: **no** `coerced` field and **no** toast. Spawning an ordinary
  tmux session while the switch is off is not a coercion.
- The API log carries an info line for each coercion, naming requested
  and effective values.

**📷 Screenshot**: `flag-03-toast.png` — the coercion toast.

**Cleanup**: Kill and Delete record on both sessions.

---

### FLAG-04 — Adopt, Import and the revival dialogs coerce too

**Covers**: the other five coerce sites. Reopen and Fork used to be
exempt; they are not any more.

**Steps**, with the switch off:

1. **Adopt** an outside session into `e2e-headless` (project default
   headless).
2. **Import** a `.tar.gz` bundle that recorded `useTmux: false`
   *(codex only — otherwise import any bundle into `e2e-headless`)*.
3. **Reopen** the pre-made headless terminal session.
4. **Fork** it.
5. **Respawn** it.

**Expect**

- Every one runs in **tmux** and raises the coercion toast — including
  when it was the *project* or the *bundle* that asked for headless,
  not the user.
- Each response carries `coerced`.
- Steps 3–5 with **no** mode given in the request come back in tmux
  whatever the record says.

**Cleanup**: Kill and Delete record on everything created here. Keep
one headless-on-disk record for `FLAG-05`.

---

### FLAG-05 — `PATCH` behaviour with the switch off

**Covers**: the four PATCH rows of the masking table, and the promise
that nothing rewrites a stored preference behind your back.

**Steps**, against the pre-made headless record in a **terminal**
state:

1. `PATCH` with `useTmux: false`.
2. `PATCH` with `useTmux: true`.
3. `PATCH` with **model only**, then read the record's `useTmux` on
   disk.
4. `PATCH` with `useTmux: false` against a **headless record at
   `idle`** (spawn one while the switch is on if you no longer have
   one).

**Expect**

1. **200**, saved as `useTmux: true`, response carries `coerced`.
2. **200**, allowed — records can be unwound while the switch is off.
3. **200**, and the mode field on disk is **untouched**: a headless
   record stays headless. Editing a model during an outage must not
   silently convert the session.
4. **400** — the `idle` mode lock (see
   [`metadata-edit.md`](metadata-edit.md) `META-05`) applies
   regardless of the switch, and it fires first.

**Cleanup**: Delete record.

---

### FLAG-06 — A schedule keeps its stored headless preference

**Covers**: the same "nothing rewrites a stored preference" promise, on
the schedules side.

**Steps**

1. With the switch **off**, open the fixture schedule that pins
   `useTmux: false` for edit. Change its **prompt** and save.
2. Export the YAML and read that entry.
3. Run the schedule once.
4. Turn the switch **on**, restart, and run it once again.

**Expect**

- The dialog shows no *Use tmux* control, and the save leaves the
  stored mode alone — the field is left out of what the dialog writes,
  not written as `true`.
- The exported YAML still carries `useTmux: false`.
- The run in step 3 fires in **tmux**, and the import/run summary
  counts it under `coerced`.
- The run in step 4 fires **headless** — the stored preference came
  back the moment the switch did.

**📷 Screenshot**: `flag-06-yaml-preserved.png` — the YAML entry
retaining `useTmux: false` while the switch is off.

**Cleanup**: delete the fixture schedule.

---

### FLAG-07 — The Headless badge is masked by liveness

**Covers**: the badge rule, which is the subtlest piece of the masking
— it is split by whether the session is still live.

**Steps**, with the switch **off**:

1. Find or create a **live** headless session at `idle` (one spawned
   while the switch was on, still resting). Read its header.
2. Archive it. Read the header again.
3. Turn the switch on, restart, reload. Read it once more.

**Expect**

1. The badge **shows**. A live headless session's next turn really will
   be headless, and the user needs to know why there is no TUI to
   attach to.
2. The badge **comes off** in the terminal state. It would otherwise
   describe a mode the user can no longer pick, sitting next to Reopen
   and Respawn buttons that will not produce it.
3. With the switch on the badge **always** shows, terminal or not.

**📷 Screenshot**: `flag-07-badge-live-vs-terminal.png` — the same
session's header before and after archiving.

**Cleanup**: Delete record.

---

### FLAG-08 — Restore the switch

**Covers**: leaving the host as you found it. Not optional — a
left-over `false` makes [`headless-flow.md`](headless-flow.md) and half
of [`spawn-session.md`](spawn-session.md) fail for the wrong reason.

**Steps**

1. Remove `enableHeadlessMode` from `~/.orchestron/config.json` (or set
   it to `true`).
2. Restart the API.
3. Open the Spawn dialog.

**Expect**

- The *Use tmux* checkbox is back.
- Settings → Server Info reports the switch as on.
- A previously-coerced project (`e2e-headless`) once again spawns
  headless by default — nothing about it was rewritten during the
  outage.

**Cleanup**: none — this *is* the cleanup.

---

## Notes on current shipped behaviour

- **The UI is optimistic while it does not know.** `useHeadlessEnabled`
  returns `true` while the health fetch is loading, on error, and
  against a server too old to report the field. Guessing "enabled"
  costs at worst a spawn that comes back with a coercion notice;
  guessing "disabled" would hide the toggle from everyone whose health
  fetch is slow. So a scenario must not read a briefly-visible checkbox
  on a slow load as a bug.
- **The API is the enforcement layer, not the UI.** Every scenario here
  that hides a control has an API counterpart that coerces regardless.
- **A running headless session is not converted mid-flight**, and a
  headless session's *next turn* stays headless — a turn resumes an
  existing conversation rather than spawning, so the coercion only
  bites at respawn or reopen.
