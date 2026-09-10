# Adopt & Import — E2E Test Plan

Two ways to bring a session orchestron did not create under its
management. **Adopt** takes a harness session already on this host by
uuid; **Import** takes a bundle file exported from another host. Both
end in the same `manager.adopt()` call, and both have to decide a run
mode for a record that has no prior orchestron history.

Spec: [USAGE.md § Adopt an existing harness session](../USAGE.md#adopt-an-existing-harness-session) ·
[USAGE.md § Export / import a session bundle](../USAGE.md#export--import-a-session-bundle)

The bundle *format* and the cross-host round trip are in
[`export-import.md`](export-import.md). This file is about the dialogs.

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- `enableHeadlessMode` **on**.
- Fixture projects `e2e-claude` (no mode preference) and `e2e-headless`
  (project default: headless). You need both — the whole point of
  several scenarios is which project's setting fills the box.
- **An outside session to adopt.** Create one in a terminal, not
  through orchestron:

```bash
cd /tmp/orchestron-e2e/ws-claude
claude          # say something, get a reply, then exit with /quit
# find its uuid:
ls -t "$CLAUDE_CONFIG_DIR/projects/"*ws-claude*/*.jsonl | head -1
```

  Keep that uuid; several scenarios use it. **Make sure the process has
  exited** — a live one is exactly what `ADOPT-03` tests for.

---

## Scenarios

### ADOPT-01 — Adopt an outside session into tmux

**Covers**: the happy path, and the fact that a resumed conversation is
not re-prompted.

**Steps**

1. Dashboard → the **caret** next to Spawn → **Adopt**.
2. Select project `e2e-claude`.
3. Paste the harness session uuid into **Harness session UUID** and
   tab out of the field.
4. Leave *Use tmux* ticked. Click **Adopt session**.

**Expect**

- The caret menu offers exactly two entries: **Adopt** and **Import
  bundle**.
- On selecting the project, an info block appears showing effective
  agent, workspace and config dir — labelled `(harness default)`
  because `e2e-claude` sets no override. The field is named
  `CLAUDE_CONFIG_DIR` for a claude project.
- A path template under the uuid input shows exactly where orchestron
  will look, resolved against that project's workspace and config dir.
- On blur, validation runs and reports **green**. The **Adopt session**
  button is disabled until it does.
- After adopting: status goes `spawning` → `waiting`/`running` →
  `idle`, and a tmux window exists.
- The transcript carries the conversation from the terminal, and
  **no new user turn was sent** — a resume does not re-send the prompt.
- The dashboard title is seeded from the transcript's first user
  message.
- The record carries `metadata.adopted: true` and
  `metadata.adoptedFromUuid`:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/sessions/<orch uuid>" \
  | python3 -m json.tool | grep -A3 metadata
```

**📷 Screenshot**: `adopt-01-validated.png` — the dialog with green
validation and the resolved path template visible.

**Cleanup**: Kill, Delete record. The harness transcript survives, so
the same uuid is reusable by the next scenario.

---

### ADOPT-02 — Adopt headless

**Covers**: the headless adopt starting nothing at all.

**Steps**

1. Open **Adopt**, select `e2e-claude`, paste the same uuid.
2. **Untick** *Use tmux*. Adopt.
3. Send a turn from the composer.

**Expect**

- The record lands straight in **`idle`**. No `spawning`, no process,
  no tmux window.
- A **Headless** badge shows.
- Sending a turn starts the first `claude -p --resume` against the
  adopted conversation, and the reply demonstrates the terminal
  conversation is in context.
- Validation ran identically — every check applies in headless mode
  too. A headless adopt starts no process, but its first turn will, so
  the race is deferred rather than avoided.

**Cleanup**: Archive, Delete record.

---

### ADOPT-03 — Validation refuses a uuid a live process is holding

**Covers**: the `/proc` scan. This is the check that stops two writers
racing one transcript, and it is the only one that cannot be inferred
from the filesystem.

**Steps**

1. In a terminal, resume the fixture session and **leave it running**:
   `cd /tmp/orchestron-e2e/ws-claude && claude --resume <uuid>`
2. Open **Adopt**, select `e2e-claude`, paste that uuid, tab out.

**Expect**

- Validation goes **red**.
- The message names the offending **PID** and a slice of its command
  line, and says to stop it before adopting to avoid transcript
  corruption.
- **Adopt session** stays disabled.
- Quit the terminal session and re-blur the field: validation turns
  green and the button enables.

**📷 Screenshot**: `adopt-03-live-process.png` — the red banner naming
the PID.

**Cleanup**: quit the terminal claude. Nothing was adopted.

---

### ADOPT-04 — The other validation layers

**Covers**: the remaining four checks, cheaply, in one pass.

**Steps**, reading the banner after each:

1. Enter `not-a-uuid` → tab out.
2. Enter a well-formed but nonexistent uuid
   (`00000000-0000-4000-8000-000000000000`) → tab out.
3. Adopt the fixture uuid successfully into `e2e-claude` and leave the
   record alive. Open Adopt again and enter the **same uuid** → tab out.
4. Select `e2e-headless` — a *different* project, hence a different
   workspace — and enter the fixture uuid → tab out.

**Expect**

1. Rejected on **format**.
2. Rejected because the **transcript does not exist** at the expected
   path — and the message names that path so the mistake is
   diagnosable.
3. Rejected because an **active orchestron session already tracks this
   uuid**.
4. Rejected on the transcript path again — the path is resolved against
   the *selected project's* workspace and config dir, so the same uuid
   is not findable from a different workspace. This is a correct
   refusal, not a bug.

- In every case **Adopt session** stays disabled and the banner
  explains what to fix.

**📷 Screenshot**: `adopt-04-validation-states.png` — one frame per
banner is ideal; a montage is acceptable.

**Cleanup**: Kill and Delete record for the session created in step 3.

---

### ADOPT-05 — *Use tmux* comes from the destination project

**Covers**: the sourcing rule. Adopt has no source mode to preserve —
the orchestron record is created here — so the project's policy is what
fills the box.

**Steps**

1. Open **Adopt**. Select `e2e-claude`. Read the checkbox.
2. Switch the project dropdown to `e2e-headless`. Read it again.
3. Switch back to `e2e-claude`.

**Expect**

- `e2e-claude` → **ticked** (tmux, the fallback when a project
  expresses no preference).
- `e2e-headless` → **unticked**, following that project's
  `defaultUseTmux`.
- Switching back re-ticks it — the box **re-defaults** on project
  change rather than keeping what it last showed.
- Overriding the box is per-adopt: it changes nothing about the
  project. Verify by reopening the Projects page afterwards.

**📷 Screenshot**: `adopt-05-mode-per-project.png` ×2.

**Cleanup**: Cancel.

---

### IMPORT-01 — Import a `.jsonl` bundle

**Covers**: the import happy path and the preview chip.

**Steps**

1. Get a bundle: open any claude session with a transcript and click
   the sky-blue download icon in its header. You get
   `orchestron-claude-<uuid>.jsonl`. (See
   [`export-import.md`](export-import.md) for export itself.)
2. Dashboard → caret → **Import bundle**.
3. Select destination project `e2e-claude`.
4. Choose the file.
5. Click **Import session**.

**Expect**

- The file picker accepts `.jsonl`, `.tar.gz` and `.tgz`.
- Before submit, a **preview chip** shows the parsed format, the
  harness detected from the filename, and the source uuid.
- The destination info block shows agent / workspace / config dir the
  same way Adopt does.
- After import: the session appears, resumes in tmux, and its
  transcript carries the source conversation.
- The response reports `importedFromUuid` and
  `regeneratedUuid: false` — no collision on a fresh destination.

**📷 Screenshot**: `import-01-preview-chip.png` — the dialog with the
parsed preview before submit.

**Cleanup**: Kill, Delete record.

---

### IMPORT-02 — Harness mismatch is warned, then refused

**Covers**: the amber pre-warning and the server's 409.

**Steps**

1. Open **Import bundle**, select destination `e2e-codex` (a codex
   project), and choose the **claude** `.jsonl` from `IMPORT-01`.
2. Read the banner, then submit anyway.

**Expect**

- An **amber** banner warns that the detected harness disagrees with
  the destination project and that the server will refuse with 409.
- Submitting returns **409** and surfaces as an error in the UI.
- No session record is created.

**📷 Screenshot**: `import-02-mismatch-warning.png` — the amber banner.

**Cleanup**: Cancel. *(Skip this scenario with a reason if no codex
project is registered.)*

---

### IMPORT-03 — Where a bundle's run mode comes from

**Covers**: the four-step precedence, which is the subtlest rule in
either dialog.

> 1. an explicit choice — you touched the box, or a direct API caller
>    sent the field;
> 2. the destination project's `defaultUseTmux`;
> 3. the mode the bundle recorded (`.tar.gz` only);
> 4. tmux.

**Steps**

1. Open **Import bundle**, select `e2e-claude`, choose a `.jsonl`
   bundle. Read the checkbox **and the hint under it** — do not touch
   the box.
2. Switch the destination to `e2e-headless`. Read both again.
3. Untick the box explicitly, then switch project once more.
4. Repeat step 1 with a codex **`.tar.gz`** bundle whose
   `metadata.json` recorded `useTmux: false`, against `e2e-claude`
   *(codex only — skip with a reason otherwise)*.

**Expect**

1. Ticked. The hint says the project has no preference, so it falls
   back to tmux — and, for a `.jsonl`, that the format carries no mode
   to fall back to.
2. Unticked, following `e2e-headless`'s setting; the hint names the
   project as the source.
3. Once you touch the box it is an **explicit choice** and it is sent
   on submit. The hint should reflect that it is no longer following
   anything.
4. The bundle's recorded mode decides **only** for a project that
   expresses no preference — so against `e2e-claude` the box follows
   the bundle to headless, and against `e2e-headless` the project wins
   (they agree here, so also test it against a project defaulting to
   tmux if one exists).

**📷 Screenshot**: `import-03-mode-hints.png` — the checkbox with its
hint in at least two of these states.

**Cleanup**: Cancel.

---

### IMPORT-04 — Direct API: `useTmux` must be exactly `"true"` or `"false"`

**Covers**: the multipart field. Multipart carries no types, so
anything else is a 400 rather than a guess.

**Steps**

```bash
curl -s -X POST "$ORCH/api/sessions/import" \
  -H "Authorization: Bearer $TOKEN" \
  -F projectId=<e2e-claude id> \
  -F useTmux=yes \
  -F file=@orchestron-claude-<uuid>.jsonl -i | head -5
```

**Expect**

- HTTP **400** — not a coerced guess and not a silent default.
- Repeating with `-F useTmux=false` succeeds and the session lands
  headless.
- Omitting the field entirely gives the project-then-bundle-then-tmux
  fallback from `IMPORT-03`.

**Cleanup**: Delete any record created.

---

## Notes on current shipped behaviour

- **Adopt is not for a session orchestron already knows about** — use
  Reopen. And it is not a read-only viewer: it creates a live,
  manageable record and, in tmux mode, a real `--resume` process.
- **A session's source mode does not constrain the adopt.** Both
  harnesses keep one transcript store that `-p` and the interactive TUI
  scan identically, so a conversation started headless adopts into tmux
  and vice versa.
- **With `enableHeadlessMode` off**, the checkbox is hidden in both
  dialogs and the operation runs in tmux with a toast saying so —
  including when it was the *project* or the *bundle* that asked for
  headless. See [`feature-flag.md`](feature-flag.md) `FLAG-03`.
- **`initialPrompt` is read out of the transcript** to seed the
  dashboard title, capped at 500 characters. Codex wrappers
  (`<environment_context>`, `<skills_instructions>`,
  `<user_instructions>`) are skipped so the title is what the user
  actually typed. The placeholder `(adopted … — first prompt unknown)`
  appears only when the transcript exists but no user message could be
  extracted.
