# Headless Flow — E2E Test Plan

A headless session is not a cheaper tmux session — it is a different
shape. One `claude -p` / `codex exec` child **per turn**, nothing held
between turns, no pane to attach to, and a sleep that is symbolic — the
record moves, nothing is released. It is still multi-turn and it still
only reaches a terminal state when you Kill or Archive it.

Spec: [USAGE.md § Headless mode](../USAGE.md#headless-mode-no-tmux) ·
[USAGE.md § How a headless agent asks you a question](../USAGE.md#how-a-headless-agent-asks-you-a-question)

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- `enableHeadlessMode` **on** and `headlessStructuredOutput` **on**
  (both defaults). `HEADLESS-06` turns the second one off and restores
  it.
- Fixture project `e2e-claude`.
- `SPAWN-05` passes — if a headless session cannot be spawned at all,
  nothing in this file is meaningful.

---

## Scenarios

### HEADLESS-01 — Two turns against one conversation `[smoke]`

**Covers**: the central claim. Phase 1 of this feature really was
single-shot; this scenario is what proves it no longer is.

**Steps**

1. Spawn a headless session in `e2e-claude` with prompt
   `Remember the number 47. Reply with just: ok.`
2. Wait for `idle`.
3. Send a second turn: `What number did I ask you to remember?`
4. Wait for `idle` again.

**Steps to observe on the host** (optional but the clearest evidence):
run `pgrep -af 'claude -p'` during each turn and between them.

**Expect**

- After turn 1 the session is **`idle`**, not `succeeded`. It did not
  finish; it is resting.
- The composer is **enabled** at `idle` and its hint reads as *"Send
  the next turn"* rather than *"Send a follow-up"*.
- Turn 2 is accepted, status goes `running` → `idle`, and the reply is
  `47` — the conversation resumed, it did not start over.
- A `claude -p` process exists **only while a turn is running**. Between
  turns there is none.
- Both turns are in the transcript as ordinary user/assistant pairs.

**📷 Screenshot**: `headless-01-two-turns.png` — the transcript showing
both exchanges, with the header in `idle`.

**Cleanup**: Archive, Delete record.

---

### HEADLESS-02 — Interrupt a headless turn

**Covers**: SIGTERM to the child, and the session surviving it.

**Steps**

1. Spawn a headless session with the *Slow prompt*.
2. While `running`, click the red interrupt button in the composer.
3. Once it settles, send `Reply with just: still here.`

**Expect**

- The interrupt button is offered on a headless session, and its title
  describes signalling the process rather than sending Escape.
- The child process disappears from `pgrep -af 'claude -p'`.
- Status returns to **`idle`** — interrupt does not kill the session.
- Step 3 runs normally, proving the conversation is still resumable
  after an interrupted turn.

**📷 Screenshot**: `headless-02-after-interrupt.png` — the header back
at `idle` after the interrupt.

**Cleanup**: Archive, Delete record.

---

### HEADLESS-03 — Input is refused mid-turn

**Covers**: the one real input restriction. A tmux TUI buffers a pasted
prompt; a headless child has no stdin at all, and launching a second
`--resume` against a live one would put two processes on one
transcript.

**Steps**

1. Spawn a headless session with the *Slow prompt*.
2. While `running`, try to type into the composer.
3. Try the same thing on a **tmux** session running the same prompt, for
   contrast (this is `LIFE-11`).

**Expect**

- The composer is **greyed out** while a headless turn runs.
- Its hint says the session is running this turn and takes no queued
  input, and points at interrupting.
- The attach and send buttons are disabled too.
- The API refuses the same thing if called directly — the UI gate is
  not the only one.
- The tmux session in step 3 accepts the input, which is the whole
  difference.

**📷 Screenshot**: `headless-03-composer-disabled.png` — the disabled
composer with its hint, during `running`.

**Cleanup**: Interrupt, Archive, Delete record.

---

### HEADLESS-04 — A structured inquiry renders as a form `[smoke]`

**Covers**: how an agent with no pane asks a question — the `inquiry`
field, the `needs_input` state, and the form.

**Steps**

1. Spawn a headless session in `e2e-claude` with the *Inquiry prompt*
   from [`00-setup.md`](00-setup.md).
2. Wait for the turn to end.
3. Fill the form and click **Send answer**.

**Expect**

- Status lands in **`needs_input`**, not `idle`.
- An inquiry card renders above the composer, headed *"Agent needs
  input"*, with the model's question as its message.
- Each field renders per its type: a `choice` field with options
  becomes a set of pickable options; a `text` field becomes a free-text
  input. A `choice` field whose options came back null degrades to a
  text input rather than rendering an empty picker.
- **Send answer** is disabled until every field has a value.
- On submit the card switches to *"Answer sent"* and disables.
- The answers go out as an ordinary user turn — status `running` → and
  the agent resumes with them in context.
- The dashboard surfaces the session in the *needs input* stat and its
  card carries the amber `needs_input` pill while it waits.

**If the model answers in prose instead of using the schema**: that is
documented behaviour, not a failure — the response is treated as the
summary with no inquiry and the session lands `idle`. Record the
scenario as **skip — model did not raise an inquiry**, and retry. If it
never does across several attempts, that *is* a finding worth chasing.

**📷 Screenshot**: `headless-04-inquiry-card.png` — the card with its
fields, before submitting.

**Cleanup**: Archive, Delete record.

---

### HEADLESS-05 — The transcript shows the conversation, not the machinery

**Covers**: `normalizeStructuredOutputTranscript` — the structured
output plumbing being stripped before any client sees it. This
regressed once and rendered a raw `{"summary": …, "inquiry": null}`
block where the answer should have been, so it earns a scenario.

**Steps**

1. Spawn a headless session with prompt
   `Explain in two sentences what a git rebase does.`
2. Read the transcript in the web pane.
3. Read the same transcript through the other two clients:
   `orchestron session tail <uuid>` and the TUI, if available.

**Expect**

- The web pane shows the prose answer and nothing else. Specifically
  **absent**: a `StructuredOutput` tool call, a
  `"Structured output provided successfully"` tool result, any raw
  `{"summary": …}` JSON block, and any schema text in the prompt turn.
- The prompt turn is exactly what you typed — the schema is passed as a
  CLI flag and never appended to the prompt.
- All three clients agree, because the normalisation happens in
  `GET /api/sessions/:uuid/transcript` rather than in any one client.
- A **tmux** session's transcript is passed through untouched — this
  applies to headless only.

**📷 Screenshot**: `headless-05-clean-transcript.png` — the transcript
pane showing prose with no machinery.

**Cleanup**: Archive, Delete record.

---

### HEADLESS-06 — Structured output can be turned off

**Covers**: the `headlessStructuredOutput: false` escape hatch, for a
workflow that reads `finalResponse` as the deliverable.

**Steps**

1. Set `"headlessStructuredOutput": false` in
   `~/.orchestron/config.json` and restart the API.
2. Spawn a headless session with the *Inquiry prompt*.
3. Read the session record's `finalResponse`:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/sessions/<uuid>" \
  | python3 -m json.tool | grep -i finalResponse
```

**Expect**

- The session lands in `idle` and **never** in `needs_input` — with the
  schema off there is no way for the agent to raise a question.
- No inquiry card renders.
- `finalResponse` holds the model's **prose**, not a one-line summary of
  it.
- The transcript is unaffected either way.

**Cleanup**: Archive, Delete record. **Restore
`headlessStructuredOutput` to `true` and restart the API** — leaving it
off breaks `HEADLESS-04`.

---

### HEADLESS-07 — A failed turn records why

**Covers**: `failureReason` carrying the child's stderr tail, and a
later good turn clearing it.

**Steps**

1. Spawn a headless session with a nonexistent model:

```bash
curl -s -X POST "$ORCH/api/sessions" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"projectId":"<e2e-claude id>","useTmux":false,"model":"claude-not-a-model","prompt":"hi"}'
```

2. Open the session and expand the details panel.
3. Use the pencil to set a real model, then Respawn.

**Expect**

- Status → `failed`.
- The details panel shows a `failure` row under **Timing** carrying the
  stderr tail — it says what went wrong rather than just going red.
- After the respawn with a good model, the turn succeeds and the
  failure row is gone.

**📷 Screenshot**: `headless-07-failure-row.png` — the Timing group
with the failure row.

**Cleanup**: Archive, Delete record.

---

### HEADLESS-08 — An idle headless session holds no pool slot

**Covers**: the concurrency accounting. Counting resting one-shots
would let a pile of finished sessions block new spawns for nothing.

**Steps**

1. Read `maxConcurrent` from `/api/health/detail`.
2. Spawn that many headless sessions and let every one reach `idle`.
3. Spawn one more.

**Expect**

- The extra spawn **succeeds**. Between turns a headless session holds
  no tmux, no pty and no pid, so it is not counted.
- Sending a turn into several of the resting sessions at once *does*
  count them again — the slot is held only while a turn is in flight.
- Leaving one long enough to be swept to `sleeping` changes nothing
  here: that sleep released nothing, so it was never holding a slot.

> On a host with a large `maxConcurrent` this is slow and costs quota.
> Treat it as a full-sweep scenario, not a smoke one, and consider
> lowering `maxConcurrent` for the run.

**Cleanup**: Archive and Delete record on all of them.

---

### HEADLESS-09 — Symbolic sleeping, and the wake that costs nothing

**Covers**: the idle sweeper on the headless path. A headless session
sleeps like a tmux one so the dashboard can tell "finished a turn a
second ago" from "abandoned since yesterday" — but where the tmux sweep
kills a window, this one only writes the record.

**Setup**: `idleTimeoutMs` low enough to observe — 60000 (1 min) in
`~/.orchestron/config.json`, API restarted. Restore afterwards.

**Steps**

1. Spawn a headless session, let the first turn land in `idle`.
2. Note `tmux list-windows -a` — the session has no window, and must
   not gain one.
3. Wait out the timeout without touching the session.
4. Send a follow-up turn.

**Expect**

- After the timeout the card shows the **Sleeping** badge, same indigo
  as a sleeping tmux session. The **Headless** badge stays.
- No tmux window appears or disappears across the whole scenario; the
  API log shows no kill for this session.
- The input box stays **enabled** while it sleeps, hinting that sending
  wakes it and naming no cold start.
- The follow-up runs immediately — `sleeping → idle → running` with no
  `spawning` in between, and no ~3s wake delay. The transcript carries
  on the same conversation.
- The ✎ pencil is available while sleeping, but its **Use tmux**
  checkbox is greyed out and names Reopen / Fork / Respawn — waking
  takes no spawn, so a mode flip there could never become real. Model
  and Effort still save.
- After the second turn lands, the session sleeps again on the same
  timeout.

**Cleanup**: restore `idleTimeoutMs`, restart the API, then Archive and
Delete record.

---

## Notes on current shipped behaviour

- **Quota is unchanged.** `claude -p` authenticates from the same
  `CLAUDE_CONFIG_DIR` credentials as the interactive TUI. Headless is
  not "the API-billing mode".
- **The transcript is the harness's.** Claude writes the same
  `<CLAUDE_CONFIG_DIR>/projects/<mangled-cwd>/<uuid>.jsonl` in `-p`
  mode as it does interactively; `codex exec` writes its rollout under
  `<CODEX_HOME>/sessions/…`. Orchestron reads those and keeps no second
  copy.
- **No `turn_duration` event.** Process exit is the turn boundary.
  A scenario must not wait for a turn-end marker in a headless
  transcript.
- **`wait_for_idle` is withheld from headless agents.** It blocks for
  minutes and a one-shot invocation has no turn boundary to release it.
  The other nine MCP tools are available — see
  [`mcp-spawn.md`](mcp-spawn.md).
- **An API restart mid-turn lands the session in `idle`, not
  `failed`** — with an explanatory `failureReason`. The turn's output
  is already in the harness's transcript and the conversation is still
  resumable.
