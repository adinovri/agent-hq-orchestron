# Session Lifecycle — E2E Test Plan

Reopen, Fork, Respawn, Archive, Kill, sleep/wake, and Delete record.
Three of those revive a terminal session and all three can move it
across the tmux/headless boundary, which is where most of the interest
is.

Spec: [USAGE.md § Reopen vs Fork vs Respawn](../USAGE.md#reopen-vs-fork-vs-respawn) ·
[USAGE.md § Reopen, Fork and Respawn across modes](../USAGE.md#reopen-fork-and-respawn-across-modes) ·
[USAGE.md § Sleep / wake-up](../USAGE.md#sleep--wake-up-idle-sweeper) ·
[USAGE.md § Delete a session record](../USAGE.md#delete-a-session-record)

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- `enableHeadlessMode` **on**.
- You can reach the host's `tmux ls` — several assertions are about a
  window existing or not.

**Semantics under test**, condensed:

| | Reopen | Fork | Respawn |
|---|---|---|---|
| orchestron session id | same | **new** | same |
| harness session uuid | same | same (shared) | **fresh** |
| transcript | resumed | resumed | **new** |
| needs an existing transcript | yes | yes | no |

All three are visible only in a terminal state (`succeeded`, `killed`,
`failed`). Reopen and Fork additionally hide when the transcript is
missing from disk — Respawn is the only recovery there.

---

## Scenarios

### LIFE-01 — Reopen a killed tmux session `[smoke]`

**Covers**: same id, same conversation, resumed in a fresh tmux.

**Steps**

1. Spawn a tmux session in `e2e-claude` with the *Fast prompt*
   (`SPAWN-01`). Wait for `idle`. Note its session id and its harness
   session uuid from the details panel.
2. Kill it (✕). Status → `killed`.
3. Click **Reopen** (green ▶). The action dialog opens.
4. Leave Model, Effort and *Use tmux* on their defaults. Confirm.

**Expect**

- The dialog defaults describe the neutral choice: pickers on
  "— Default / keep", *Use tmux* **ticked** because the session was
  tmux, and helper text along the lines of *"Resumes now in an
  interactive tmux session"*.
- The URL does not change — same session id.
- Status goes `spawning` → `waiting`/`running` → `idle`.
- The harness session uuid in the details panel is **unchanged**.
- The transcript still contains the original turns; nothing was
  re-sent as a new user turn.
- A tmux window exists again.

**📷 Screenshot**: `life-01-reopen-dialog.png` — the dialog with its
defaults, before confirming.

**Cleanup**: Kill, Delete record.

---

### LIFE-02 — Fork into a new session

**Covers**: new orchestron id, shared conversation, optional divergent
prompt.

**Steps**

1. Take an `idle` or terminal session with at least one exchange in it.
   Note its id.
2. Click **Fork** (blue). In the dialog, type a short divergent prompt
   into the optional textarea — e.g. `Now answer the same question in
   one word.`
3. Confirm.

**Expect**

- The browser lands on a **different** session id.
- The forked session's harness session uuid **matches the parent's** —
  the conversation is shared.
- The fork's transcript carries the original turns, then the divergent
  prompt as its next user turn.
- The original session is untouched: same status, same transcript, no
  new turn appended to it.
- The prompt textarea's placeholder said the prompt was optional —
  *"Leave empty to just re-enter the shared context"*.

**📷 Screenshot**: `life-02-fork-transcript.png` — the fork's
transcript showing inherited turns above the new prompt.

**Cleanup**: Kill/Archive and Delete record on both.

---

### LIFE-03 — Respawn from a session with no transcript

**Covers**: the recovery path, and the `hasTranscript === false`
gating that hides Reopen and Fork.

**Steps**

1. Produce a session that died before writing any JSONL. The reliable
   way is to spawn with a bad model name so the harness exits at launch:

```bash
curl -s -X POST "$ORCH/api/sessions" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"projectId":"<e2e-claude id>","model":"claude-not-a-model","prompt":"hi"}'
```

2. Open the resulting session. It should reach `failed`.
3. Read the action buttons in the header.
4. Click **Respawn** (orange ↻), set Model back to a real one, confirm.

**Expect**

- In `failed` with no transcript: **Reopen and Fork are absent**,
  Respawn is present.
- The details panel shows a `failure` row under **Timing** carrying the
  child's stderr tail — a bad model name says so rather than just going
  red.
- After respawn: same orchestron session id, a **new** harness session
  uuid, and a transcript that starts from the original prompt with no
  history behind it.

**📷 Screenshot**: `life-03-failed-actions.png` — the header of the
failed session, showing which buttons are and are not offered.

**Cleanup**: Kill, Delete record.

---

### LIFE-04 — Reopen a tmux session **into headless**

**Covers**: the cross-mode revival that deliberately runs nothing, and
the fact that the conversion sticks.

**Steps**

1. Spawn a tmux session in `e2e-claude`, let it reach `idle`, then Kill.
2. Click **Reopen**. In the dialog, **untick** *Use tmux*.
3. Read the helper text, then confirm.
4. Once it settles, send a follow-up turn from the composer.

**Expect**

- The helper text changes when you untick, describing a headless
  restore rather than an interactive one.
- After confirming, the session lands in **`idle`** — not `running`,
  not `waiting`. **No process is started**: `tmux ls` shows no window
  and no `claude` process is holding the uuid.
- A **Headless** badge appears in the header.
- Sending the follow-up starts a `claude -p --resume` turn: status
  `running` → `idle`, and the reply demonstrates the model still has
  the earlier conversation in context.
- The conversion is written to the record: Kill it and Reopen again
  with the dialog untouched, and the *Use tmux* box now defaults
  **unticked** — it does not silently drift back to tmux.

**📷 Screenshot**: `life-04-reopen-headless-idle.png` — the header
right after the reopen, showing `idle` + Headless badge with nothing
running.

**Cleanup**: Archive, Delete record.

---

### LIFE-05 — Respawn a headless session into tmux

**Covers**: the other direction, and the fact that Respawn genuinely
relaunches so the new mode is real immediately.

**Steps**

1. Spawn a headless session in `e2e-claude` (`SPAWN-05`), let it reach
   `idle`, then Archive it.
2. Click **Respawn**, **tick** *Use tmux*, confirm.

**Expect**

- Status `spawning` → `waiting`/`running` → `idle`.
- The Headless badge is gone.
- A tmux window exists, and the details panel now has a `tmux` row
  under **Location** and an `attach` row under **Commands**.
- A **fresh** harness session uuid, and a transcript that starts over
  from the original prompt.

**📷 Screenshot**: `life-05-respawn-tmux.png` — the details panel
showing the tmux and attach rows that were absent while headless.

**Cleanup**: Kill, Delete record.

---

### LIFE-06 — Sleep on idle, wake on send `[smoke]`

**Covers**: the idle sweeper releasing tmux, and the transparent
cold-start resume.

**Steps**

1. Restart the API with a short timeout so the scenario is minutes, not
   quarter-hours: `ORCHESTRON_IDLE_TIMEOUT_MS=60000` (1 minute).
2. Spawn a tmux session in `e2e-claude`, let it reach `idle`.
3. Wait out the timeout without touching it.
4. Send a follow-up turn from the composer.

**Expect**

- After the timeout: status → **`sleeping`**, and the session's tmux
  window is gone from `tmux ls`.
- The transcript is still fully readable while sleeping — nothing was
  lost.
- The pencil icon appears in the header (sleeping is an editable state
  — see [`metadata-edit.md`](metadata-edit.md)).
- On send: status goes `spawning` → `running` within a few seconds
  without any manual reopen, and the session id is unchanged.
- The reply shows the earlier conversation is still in context.
- While `idle` and approaching the threshold, the header carries an
  `idle Nm` chip; it turns amber at 10 minutes against the 15-minute
  default.

**📷 Screenshot**: `life-06-sleeping.png` — the header in `sleeping`.

**Cleanup**: Kill, Delete record. **Restore `idleTimeoutMs` to its
default and restart the API.**

---

### LIFE-07 — Archive an active session

**Covers**: the ✓ button — terminal, read-only, tmux released.

**Steps**

1. Spawn a tmux session, let it reach `idle`.
2. Click **Archive** (✓ green).

**Expect**

- Status → `succeeded`.
- The tmux window is gone.
- The composer is disabled; the session is read-only.
- Reopen / Fork / Respawn appear, Archive and Kill do not.
- If the session had a parent, the parent receives a queued terminal
  report — covered in [`mcp-spawn.md`](mcp-spawn.md) `MCP-05`.

**Cleanup**: Delete record.

---

### LIFE-08 — Kill an active session

**Covers**: the ✕ button, and the distinction from Archive and from
Delete record.

**Steps**

1. Spawn a tmux session with the *Slow prompt* so it is genuinely
   `running`.
2. Click **Kill** (✕ red) and confirm.

**Expect**

- A confirm dialog appears first — Kill is not a single click.
- Status → `killed`, and the tmux window is gone.
- **The record stays** and is still browsable, with its partial
  transcript intact.
- The harness transcript on disk is untouched.

**📷 Screenshot**: `life-08-kill-confirm.png` — the confirmation
dialog.

**Cleanup**: Delete record.

---

### LIFE-09 — Delete a session record

**Covers**: the trash icon — what it removes, what it keeps, and the
fact that the session stays re-adoptable afterwards.

**Steps**

1. Take a session in a terminal state. Note its **harness session
   uuid** from the details panel — you need it in step 4.
2. Click the trash icon (🗑 red) and read the confirm dialog before
   confirming.
3. Confirm.
4. Open **Adopt** from the caret next to Spawn and enter the uuid from
   step 1 against the same project.

**Expect**

- The trash icon is present only in terminal states and `sleeping`.
  On an active session it is absent — kill it first.
- The confirm dialog enumerates both lists explicitly: what is
  **deleted** (the orchestron session JSON and its `.bak`, the
  per-session MCP config) and what is **preserved** (the harness
  transcript, Claude's file-edit history, the metrics aggregate,
  delegation edges).
- After confirming: the session disappears from the dashboard and its
  detail URL no longer resolves.
- In step 4, Adopt's validation goes **green** — the transcript is
  still on disk, which is the whole point of the split.

**📷 Screenshot**: `life-09-delete-dialog.png` — the confirm dialog
with both lists legible.

**Cleanup**: Cancel out of the Adopt dialog (or complete the adopt and
delete the new record).

---

### LIFE-10 — Interrupt a running tmux turn

**Covers**: the red interrupt button and the proactive transition to
`idle`.

**Steps**

1. Spawn a tmux session with the *Slow prompt*.
2. While the status pill reads `running`, click the red interrupt
   button in the composer.

**Expect**

- The interrupt button is visible **only** while `running`.
- Status moves to `idle` promptly — orchestron does not wait for a
  `turn_duration` event, because the interrupt path never writes one.
- The session is still alive: sending another turn works and the model
  has the partial turn in context.

**📷 Screenshot**: `life-10-interrupt.png` — the composer with the
interrupt button visible during `running`.

**Cleanup**: Kill, Delete record.

---

### LIFE-11 — Queue input while a tmux turn is running

**Covers**: the tmux-only ability to type ahead. The headless
counterpart — where this is refused — is
[`headless-flow.md`](headless-flow.md) `HEADLESS-03`.

**Steps**

1. Spawn a tmux session with the *Slow prompt*.
2. While `running`, type `Then reply with the word: done.` into the
   composer and send.

**Expect**

- The composer is **enabled** during `running` on a tmux session, and
  its hint says the input will queue.
- The message is accepted rather than rejected.
- When the current turn ends, the queued message runs as the next turn.

**Cleanup**: Kill, Delete record.

---

## Notes on current shipped behaviour

- **Reopen and Fork are available for headless sessions.** An earlier
  Phase 1 gate hid them; it was removed once cross-mode resume was
  verified on both harnesses. A stale paragraph to that effect still
  sits in [USAGE.md § Reopen vs Fork vs Respawn](../USAGE.md#reopen-vs-fork-vs-respawn)
  — the authoritative statement is the *across modes* section below it.
  Scenarios here follow the shipped behaviour.
- **No context is lost crossing the mode boundary in either
  direction.** Claude's `-p` and interactive TUI share one JSONL store;
  codex writes both the rollout JSONL and the `thread_history` SQLite
  whichever mode produced the thread. There is no copying or id
  rewriting involved — it is the harness's own resume.
- **A record stranded mid-conversion is recovered automatically.** A
  tmux-mode `running` session with no `tmuxName` is swept into `failed`
  with `failureReason: "cross-mode transition failed — no tmux window
  found"` at boot and every 10 minutes after, which frees its pool slot
  and makes Respawn reachable. A running *headless* turn holds no
  window by design and is never touched by that sweep.
