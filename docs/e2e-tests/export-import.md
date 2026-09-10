# Export / Import Bundles — E2E Test Plan

Moving a harness session between orchestron hosts — server ↔ Mac, or
across installs — with no shared filesystem. Download from one, upload
to the other.

Spec: [USAGE.md § Export / import a session bundle](../USAGE.md#export--import-a-session-bundle)

The Import **dialog** (destination project, mode sourcing, preview
chip) is in [`adopt-import.md`](adopt-import.md). This file is about the
bundle itself: format selection, the round trip, and what happens when
the destination already has that uuid.

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- **Two orchestron hosts** for `BUNDLE-04`. Where only one is
  available, the collision path (`BUNDLE-05`) exercises the interesting
  half on a single host — run that instead and record `BUNDLE-04` as
  skipped with the reason.
- Both hosts have the same harness CLI installed and **separately
  authenticated**. Bundles carry conversation state, not credentials —
  a bundle is not a workaround for cross-account auth.
- For a codex TUI `.tar.gz` import, the **destination** must already
  have `thread_history_1.sqlite`, which means `codex` has been run at
  least once there.

---

## Scenarios

### BUNDLE-01 — Export a claude session

**Covers**: the download button, its auth-aware fetch, and the filename
convention.

**Steps**

1. Open any claude session that has a `claudeSessionUuid`.
2. Click the sky-blue download icon in the header (next to Archive /
   Kill).
3. Save the file and inspect it.

**Expect**

- The icon is present whenever the session has a harness session uuid —
  including in terminal states.
- A spinner shows while the fetch is in flight.
- The browser's Save-File dialog offers
  `orchestron-claude-<uuid>.jsonl`.
- The saved file is the **raw** `<uuid>.jsonl` — the same lines as
  `<CLAUDE_CONFIG_DIR>/projects/<mangled-cwd>/<uuid>.jsonl`. Diff them
  to confirm.
- The download works from a paired **phone**, not just the host
  browser. This is the point of the auth-aware fetch: a plain
  `<a href>` would 401, so the button fetches with the Bearer token and
  saves the blob.

**📷 Screenshot**: `bundle-01-export-button.png` — the header with the
download icon mid-spinner.

**Cleanup**: none.

---

### BUNDLE-02 — Export failure is visible

**Covers**: the error affordance. A silent failure here looks exactly
like a browser blocking a download.

**Steps**

1. Open a session whose transcript has been moved aside on the host:
   `mv <path>/<uuid>.jsonl <path>/<uuid>.jsonl.hidden`
2. Click the download icon.
3. Restore the file afterwards.

**Expect**

- The button **flashes red** for a few seconds and then reverts to its
  normal state.
- No empty or truncated file is saved.
- After restoring the transcript, the export succeeds normally.

**Cleanup**: `mv <path>/<uuid>.jsonl.hidden <path>/<uuid>.jsonl`

---

### BUNDLE-03 — Format is picked per session shape

**Covers**: the three-way format rule.

| Session shape | File | Contents |
|---|---|---|
| claude | `.jsonl` | raw `<uuid>.jsonl` |
| codex with rollout on disk | `.jsonl` | raw `rollout-*-<uuid>.jsonl` |
| codex TUI-only (SQLite only) | `.tar.gz` | `metadata.json` + `dump.jsonl` |

**Steps**

1. Export a claude session.
2. Export a codex session that has a rollout on disk.
3. Export a codex session that exists only in SQLite (a TUI-only
   thread — no rollout file under `<CODEX_HOME>/sessions/`).
4. Unpack the `.tar.gz` from step 3:
   `tar tzf orchestron-codex-tui-<uuid>.tar.gz`

**Expect**

- Filenames follow the convention above, driven by
  `Content-Disposition`; the client falls back to
  `orchestron-session-<orch uuid>.<ext>` if the header was stripped.
- The tarball contains exactly `metadata.json` and `dump.jsonl`.
- `metadata.json` records **`useTmux`**, so the session's run mode
  travels with it. The `.jsonl` formats have no envelope to put it in
  and carry no mode — which is why the import precedence in
  [`adopt-import.md`](adopt-import.md) `IMPORT-03` has a bundle tier at
  all.
- `dump.jsonl` has one line per `thread_turns` / `thread_items` /
  `thread_history_projection_state` row, scoped to this thread only.

*(Steps 2–4 are codex-only. Record them as skipped with a reason on a
claude-only host.)*

---

### BUNDLE-04 — Cross-host round trip `[full sweep]`

**Covers**: the feature's actual purpose. Export on A, import on B,
continue the conversation on B.

**Steps**

1. On **host A**, spawn a session in `e2e-claude`, have a real
   exchange with it (two or three turns, with something specific in it
   you can ask about later), then let it go `idle`.
2. Export the bundle.
3. Transfer the file to **host B**.
4. On host B, Import it into that host's `e2e-claude` fixture.
5. Once it resumes, ask the session about the specific thing from
   step 1.

**Expect**

- On B the session lands live and its transcript carries the **full**
  history from A.
- The answer in step 5 proves the model has that history in context,
  not just that the file was copied.
- The response reports `importedFromUuid` (A's uuid) and, on a
  destination that never saw it, `regeneratedUuid: false` — so the uuid
  is preserved across hosts.
- Host A's session is untouched by any of this.

**📷 Screenshot**: `bundle-04-host-b-transcript.png` — host B's
transcript showing turns that were produced on host A.

**Cleanup**: Kill and Delete record on both hosts.

---

### BUNDLE-05 — UUID collision regenerates and rewrites

**Covers**: importing a bundle whose uuid the destination already has.
Runnable on a single host, which makes it the practical stand-in for
`BUNDLE-04`.

**Steps**

1. Export a session's bundle.
2. Without deleting anything, import that same bundle back into the
   **same** project on the **same** host.
3. Open the newly imported session and read its harness session uuid
   from the details panel.

**Expect**

- The import **succeeds** rather than colliding.
- The response reports `regeneratedUuid: true`.
- The new session's harness uuid differs from the original's.
- A transcript exists at the new uuid's path, and the **old uuid does
  not appear inside it** — occurrences were rewritten, not just the
  filename:

```bash
grep -c '<old uuid>' "<path>/<new uuid>.jsonl"    # expect 0
```

- Both sessions are independently usable. Sending a turn to the copy
  does not append to the original's transcript.

**📷 Screenshot**: `bundle-05-two-sessions.png` — the dashboard showing
both records with their differing uuids.

**Cleanup**: Kill and Delete record on the imported copy.

---

### BUNDLE-06 — A truncated or foreign file is rejected

**Covers**: the parse step, which reads only the first ~10 JSONL lines
(or `metadata.json` inside the tar) to confirm harness and source uuid.

**Steps**

1. Try to import `/etc/hostname` renamed to `junk.jsonl`.
2. Try to import a `.jsonl` truncated to its first half-line:
   `head -c 40 orchestron-claude-<uuid>.jsonl > broken.jsonl`
3. Try to import a `.tar.gz` that is not gzip
   (`echo nope > fake.tar.gz`).

**Expect**

- Each is rejected with a message naming the problem, before any
  session record is created.
- No transcript is written at the destination in any of the three
  cases.
- The dashboard session count is unchanged after all three.

**Cleanup**: `rm junk.jsonl broken.jsonl fake.tar.gz`

---

## Notes on current shipped behaviour

- **Import ends in the same `manager.adopt()` the Adopt button uses.**
  So everything true of an adopt is true of an import: the record picks
  up `initialPrompt` from the transcript, tmux mode spawns via the
  harness's native resume flag, and headless mode lands straight in
  `idle` with nothing running.
- **Codex TUI import needs the destination SQLite to exist.** Rows go
  in via `INSERT OR REPLACE` into `thread_turns` / `thread_items` /
  `thread_history_projection_state`; the file itself is not created for
  you.
- **A codex rollout import is written under today's UTC date** with a
  fresh timestamp — the destination path is
  `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, not the
  source's original date folder.
- **A bundle carries no credentials.** The destination must have the
  harness CLI available and authenticated in its own right.
