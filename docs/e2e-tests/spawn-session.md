# Spawn — E2E Test Plan

The Spawn dialog is the daily target of the whole app. It is also where
every defaulting rule in orchestron becomes visible: model, effort and
run mode each resolve from project → dialog override, and the dialog
claims in writing what each one resolved to.

Spec: [USAGE.md § Spawn](../USAGE.md#spawn) ·
[USAGE.md § Headless mode](../USAGE.md#headless-mode-no-tmux)

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- Fixture projects `e2e-claude`, `e2e-claude-opus`, `e2e-headless`
  registered.
- `enableHeadlessMode` is **on** (its default). The scenarios for the
  switch being off live in [`feature-flag.md`](feature-flag.md).
- No session currently at the concurrency cap — `maxConcurrent` is in
  `/api/health/detail`.

---

## Scenarios

### SPAWN-01 — Spawn a tmux session with project defaults `[smoke]`

**Covers**: the whole default path — dialog opens, project selected,
prompt sent, session reaches a live state in tmux.

**Steps**

1. Open the dashboard.
2. Click **Spawn** (the primary blue button, top-right — click the
   button body, not the caret).
3. Select project `e2e-claude`.
4. Leave Model, Effort and *Use tmux* untouched.
5. Type the *Fast prompt* into **Initial prompt**.
6. Click **Spawn**.

**Expect**

- The dialog closes and the browser lands on the session detail page.
- Status pill goes `spawning` → `running` → `idle` (or `needs_input`).
  `waiting` may flash between `spawning` and `running`.
- The header carries a blue project chip reading `e2e-claude` and a
  violet `CLAUDE` harness chip.
- No **Headless** badge — this is a tmux session.
- The transcript pane shows the prompt as a user turn and the model's
  reply after it.
- `tmux ls` on the host lists a window for this session.

**📷 Screenshot**: `spawn-01-detail-idle.png` — session header (status
pill through chips) plus the first two transcript turns.

**Cleanup**: Kill (✕), then Delete record (🗑).

---

### SPAWN-02 — Project info panel names the effective defaults

**Covers**: the compact panel under the project dropdown, and the
`(project)` / `(harness)` source tags. This is the part that makes
picking "Default" not a leap of faith.

**Steps**

1. Open the Spawn dialog.
2. Select `e2e-claude` (a project that sets no defaults). Read the info
   panel and the "Default" row of each dropdown.
3. Switch the dropdown to `e2e-claude-opus` (model `claude-opus-5`,
   effort `high`). Read them again.

**Expect**

- With `e2e-claude` selected: the info panel shows agent type,
  workspace path, and a config dir marked `(harness default)` because
  the project sets no override. The Model dropdown's default row names
  the harness fallback and tags it `(harness)`.
- With `e2e-claude-opus` selected: the panel's model and effort change
  to `claude-opus-5` / `high`, each tagged `(project)`.
- The panel updates on the switch without reopening the dialog.

**📷 Screenshot**: `spawn-02-info-panel.png` ×2 — the panel for each
project, so the tag difference is visible side by side.

**Cleanup**: Cancel the dialog. Nothing was spawned.

---

### SPAWN-03 — Per-session model and effort override

**Covers**: dialog override beating the project default, and the
override showing up on the spawned record.

**Steps**

1. Open the Spawn dialog, select `e2e-claude-opus` (defaults
   `claude-opus-5` / `high`).
2. Set **Model** to `claude-haiku-4-5` and **Effort** to `low`.
3. Enter the *Fast prompt* and spawn.

**Expect**

- The session header chips read `claude-haiku-4-5` and `effort:low`.
- Neither chip is styled as inherited — an inherited value renders
  muted/italic with a hover title naming its source; an explicit one
  does not.
- Expanding the details panel shows `model` and `effort` under
  **Identity** with no inheritance hint.

**📷 Screenshot**: `spawn-03-override-chips.png` — the header chip row.

**Cleanup**: Kill, then Delete record.

---

### SPAWN-04 — *Use tmux* starts on the project's setting

**Covers**: the checkbox defaulting per project, and re-defaulting when
the project changes mid-dialog. Getting this wrong means a project
configured headless silently spawns tmux.

**Steps**

1. Open the Spawn dialog.
2. Select `e2e-claude`. Read the *Use tmux* checkbox.
3. Switch to `e2e-headless` (project default: headless). Read it again.
4. Switch back to `e2e-claude`.

**Expect**

- `e2e-claude` → checkbox **ticked** (no project preference means tmux).
- `e2e-headless` → checkbox **unticked**, and the helper text under it
  describes the headless trade-off (one process per turn, no TUI to
  attach to, no sleeping).
- Switching back re-ticks it. The box tracks the project rather than
  keeping whatever it last showed.

**📷 Screenshot**: `spawn-04-usetmux-per-project.png` ×2 — the checkbox
and its helper text for each project.

**Cleanup**: Cancel.

---

### SPAWN-05 — Spawn headless `[smoke]`

**Covers**: the headless spawn path end to end — no tmux, no `waiting`,
comes to rest in `idle`.

**Steps**

1. Open the Spawn dialog, select `e2e-claude`.
2. **Untick** *Use tmux*.
3. Enter the *Fast prompt* and spawn.

**Expect**

- Status goes `spawning` → `running` → `idle`. **No `waiting`** — there
  is no TUI to wait for.
- A **Headless** badge shows in the header.
- The transcript renders the prompt and the reply as normal turns.
- No JSON envelope, no `StructuredOutput` tool call and no
  "Structured output provided successfully" text anywhere in the
  transcript — the structured-output machinery is stripped before the
  transcript reaches the client.
- `tmux ls` lists **no** window for this session.
- Details panel: `mode` reads `headless`, and there is no `tmux` row and
  no **Commands → attach** row.

**📷 Screenshot**: `spawn-05-headless-idle.png` — header with the
Headless badge, plus the transcript.

**Cleanup**: Archive (✓), then Delete record. Keep the session if you
are going straight into [`headless-flow.md`](headless-flow.md), which
needs one in exactly this state.

---

### SPAWN-06 — Attachments ride along with the prompt

**Covers**: the paperclip / drag-drop path and the `Attached files:`
append.

**Steps**

1. Create two small files:
   `printf 'alpha\n' > /tmp/orchestron-e2e/a.txt` and
   `printf 'beta\n' > /tmp/orchestron-e2e/b.txt`.
2. Open the Spawn dialog, select `e2e-claude`.
3. Attach `a.txt` with the paperclip button; drag `b.txt` onto the
   dialog.
4. Enter `Read the two attached files and reply with their contents on
   one line.` and spawn.

**Expect**

- Both files appear as removable chips in the dialog before submit,
  each with its filename.
- Removing one (the ✕ on its chip) leaves the other.
- The first transcript turn shows the prompt with an `Attached files:`
  list appended, naming the upload paths.
- The reply mentions `alpha` and `beta`, proving the paths were readable
  from the session's process.

**📷 Screenshot**: `spawn-06-attachment-chips.png` — the dialog with
both chips attached.

**Cleanup**: Kill, Delete record, `rm /tmp/orchestron-e2e/{a,b}.txt`.

---

### SPAWN-07 — Template plus additional prompt

**Covers**: template selection, and the additional-prompt textarea that
appends to it.

**Steps**

1. Open the Spawn dialog, select `e2e-claude`.
2. Open the **Template** dropdown.
3. If a template other than `None — use prompt directly` exists, select
   it and type a short line into **Additional prompt (appended to
   template)**; otherwise record this scenario as **skip — no templates
   registered on this host** and stop.
4. Spawn.

**Expect**

- Selecting a template swaps the prompt field for the
  template's own inputs plus the *Additional prompt* textarea.
- The first user turn in the transcript is the rendered template
  followed by the additional text.

**📷 Screenshot**: `spawn-07-template.png` — the dialog with a template
selected.

**Cleanup**: Kill, Delete record.

---

### SPAWN-08 — Spawn is refused with nothing to say

**Covers**: the submit guard. Cheapest possible edge case, and the one
that stops an accidental empty session burning a spawn.

**Steps**

1. Open the Spawn dialog, select `e2e-claude`.
2. Leave the prompt empty, select no template, attach nothing.
3. Look at the **Spawn** button.

**Expect**

- **Spawn** is disabled.
- The dialog says what is missing — *"Enter a prompt, select a template,
  or attach files"*.
- Typing one character into the prompt enables the button; clearing it
  disables it again.

**📷 Screenshot**: `spawn-08-disabled.png` — the disabled button with
its hint.

**Cleanup**: Cancel.

---

### SPAWN-09 — Codex spawn *(codex only)*

**Covers**: the harness-aware half of the dialog — model catalog, effort
catalog and config-dir label all change with `agentType`.

**Steps**

1. Open the Spawn dialog, select `e2e-codex`.
2. Open the Model control and the Effort dropdown.
3. Enter the *Fast prompt* and spawn.

**Expect**

- The Model control is a **free-text input**, not the curated Claude
  dropdown.
- Effort offers `ultra` in addition to the five shared levels.
- The info panel labels the config dir `CODEX_HOME`, not
  `CLAUDE_CONFIG_DIR`.
- The header harness chip reads `CODEX`.
- The transcript renders — codex reads from SQLite rather than JSONL,
  and the endpoint detects that per harness.
- No context-usage indicator issue: codex reports its own context
  window per turn rather than the fixed Claude ceiling.

**📷 Screenshot**: `spawn-09-codex-dialog.png` — the dialog showing the
free-text model input and `CODEX_HOME`.

**Cleanup**: Kill, Delete record.

---

### SPAWN-10 — Codex session in a claude project is refused *(codex only)*

**Covers**: the 1-project-1-harness rule.

**Steps**

1. Call the API directly — the UI does not offer this combination:

```bash
curl -s -X POST "$ORCH/api/sessions" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"projectId":"<e2e-claude id>","agentType":"codex","prompt":"hello"}' -i | head -5
```

**Expect**

- HTTP **409**.
- No session record is created — the dashboard count is unchanged.

**Cleanup**: none.

---

## Notes on current shipped behaviour

- **Every session-creating path carries *Use tmux*** — Spawn, Adopt,
  Import, Reopen, Fork, Respawn, the schedule dialog, and the
  `spawn_session` MCP tool. Spawn is the one tested here; the others are
  in their own files.
- **A headless spawn skips `waiting`.** Asserting a `waiting` state on a
  headless session is a scenario bug, not an app bug.
- The mode is baked into the process arguments at turn start, so nothing
  in this dialog can change a session's mode after it exists. That is
  what Reopen / Fork / Respawn and the pencil are for — see
  [`session-lifecycle.md`](session-lifecycle.md) and
  [`metadata-edit.md`](metadata-edit.md).
