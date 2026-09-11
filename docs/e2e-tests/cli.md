# CLI — E2E Test Plan

`orchestron` the binary, not the dashboard. Everything here runs in a
shell, which makes this the one file in the plan an agent can execute
without a browser.

The scope is **input and process**: does each command reach the right
endpoint with the right body, and does the server do what the web UI
would have done. Output is deliberately thin — a one-line human status,
or a `{ok:…}` envelope under `--json` — so the assertions are on the
envelope and on the resulting server state, never on table formatting.

Spec: [USAGE.md § CLI](../USAGE.md#cli--orchestron)

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md), including
  `. ~/.orchestron-e2e/e2e.env` for `$ORCH`, `$TOKEN` and the fixture
  project ids.
- The CLI runs from the repo, so there is nothing to install:

  ```bash
  cd apps/cli
  alias orch="npx tsx src/index.ts --url $ORCH --token $TOKEN"
  ```

  `--url` and `--token` are accepted by every command below. Without
  them the CLI reads `$ORCHESTRON_URL` / `$ORCHESTRON_TOKEN`, then
  `bindHost`/`port`/`remoteToken` out of the config file named by
  `$ORCHESTRON_CONFIG` or `$ORCHESTRON_DATA_DIR`. **In the E2E env,
  always pass them explicitly** — a bare invocation otherwise reaches
  the *deployed* instance on :8090 and spends real money there.

- `enableHeadlessMode` **on**, unless a scenario says otherwise.
- Prefer `--model claude-haiku-4-5 --effort low` on anything that
  actually spawns. `NF1` cost every sweep more than the rest of the run
  combined by letting one spawn fall back to Opus.

**Cost note.** Only `CLI-01`, `CLI-04`, `CLI-06` and `CLI-12` start a
real agent. Everything else mutates records, reads, or fails fast.

---

## Scenarios

### CLI-01 — Spawn headless, send a turn, archive `[smoke]`

**Covers**: the minimum loop a workflow driver needs — create, drive,
close — entirely from the shell.

**Steps**

1. ```bash
   orch session spawn --project "$PROJECT_CLAUDE" \
     --prompt "Reply with the single word: ready" \
     --model claude-haiku-4-5 --effort low --headless --json
   ```
2. Capture `.id` from the envelope. Poll
   `orch session get <id> --json` until `.status` is `idle`.
3. ```bash
   orch session send <id> --prompt "Reply with the single word: done" --json
   ```
4. Poll to `idle` again, then
   `orch session archive <id> --json`.

**Expect**

- Step 1 prints `{"ok": true, "id": …, "sessionUuid": …, "useTmux":
  false, …}` and exits **0**. `sessionUuid` is the harness conversation
  id, distinct from `id`.
- No tmux session exists for it: `tmux ls | grep <tmuxName>` is empty.
- Step 3's envelope carries `promptChars` and the session leaves `idle`.
- After step 4, `.status` is `succeeded` and the record is read-only.
- The dashboard shows the same session — the CLI is not a parallel
  world.

**Cleanup**: `orch session rm <id>`.

---

### CLI-02 — Every command speaks one envelope `[smoke]`

**Covers**: the `--json` contract the TUI and the Phase 3 executor are
built against.

**Steps**

1. Run each of these and pipe to `jq -e .ok`:
   `session list`, `session get <id>`, `project list`,
   `schedule list`, `metrics --group-by day`.
2. Run a command that must fail, with `--json`, through a **pipe**:
   ```bash
   orch session metadata 00000000-0000-4000-8000-000000000000 --json | jq .
   ```
3. Prove the pipe on a payload that can actually truncate, and on a
   reader that walks away:
   ```bash
   orch session list --json | wc -c        # must print > 65536
   orch session list --json | jq -e .ok
   orch session list --json | head -c 1000 ; echo "exit=$?"
   ```

**Expect**

- Every success document has `ok: true` at the top level and parses as
  a single JSON value — no log lines, no colour codes mixed in.
- The failure prints `{"ok": false, "error": "…"}` **on stdout** and
  exits **1**. It is not empty: writes to a pipe are asynchronous, and
  a `process.exit` here would truncate the document the caller is
  parsing.
- An HTTP failure additionally carries `status` (e.g. `404`, `409`).
- Human mode (no `--json`) prints one line, and the error goes to
  **stderr** instead.
- Step 3 is the only part of this scenario that tests truncation, and it
  only does so if `wc -c` clears **65536** — a pipe buffers 64 KiB for
  free, so any smaller document arrives whole whether the flush is
  handled or not. On an env without enough sessions to clear it, seed
  more or use `metrics --group-by session`; do **not** substitute a
  small document. `doctor --json` is ~1 KB (NEW-4) and passes this step
  no matter what the code does — a sweep that cites it has measured
  nothing.
- `head -c 1000` must exit **0** with an empty stderr (NEW-1). A reader
  that stops reading is not an error, and an unhandled `EPIPE` turns it
  into a stack trace and a non-zero status for a pipeline the operator
  considers fine.

**Cleanup**: none.

---

### CLI-03 — Host and token resolution

**Covers**: the precedence chain, which is what stops a CLI invocation
from quietly hitting the wrong instance.

**Steps**

1. With `ORCHESTRON_DATA_DIR` pointed at the E2E data dir and **no**
   flags: `orchestron session list --json`.
2. Same, with `--url http://127.0.0.1:19999`.
3. Same, with `ORCHESTRON_URL` set to the E2E `$ORCH` and a config file
   naming something else.
4. `orchestron schedule list --host "$ORCH" --token "$TOKEN"`.

**Expect**

- Step 1 succeeds: the CLI read `bindHost`, `port` and `remoteToken`
  out of the E2E `config.json`.
- Step 2 fails with a connection error — the flag beat the file.
- Step 3 used `$ORCHESTRON_URL`: the env var beats the file, the flag
  beats the env var.
- Step 4 works. `--host` is the deprecated spelling `schedule` shipped
  with and is still accepted everywhere.
- A config holding only the legacy `token` key (not `remoteToken`)
  still authenticates.

**Cleanup**: none.

---

### CLI-04 — Reopen, fork and respawn keep the mode they find

**Covers**: the `useTmux` tri-state. Absent ≠ `true`.

**Steps**

1. Spawn a headless session (as `CLI-01`), let it reach `idle`, then
   `orch session kill <id>`.
2. `orch session reopen <id> --json` — **no** mode flag.
3. Read `.useTmux` in the envelope.
4. `orch session fork <id> --prompt "continue" --json`.
5. `orch session respawn <id> --tmux --json`.

**Expect**

- Step 2 reopens it **headless**. The body sent carried no `useTmux`
  key at all; sending `true` would have migrated the session to tmux
  behind the operator's back.
- Step 4 creates a **new** id sharing the source's harness
  conversation, and the envelope names `forkedFrom`.
- Step 5 returns the **same** id in tmux mode, and a tmux session now
  exists.
- `--headless` together with `--tmux` is refused before any request:
  *"--headless and --tmux are mutually exclusive"*, exit 1.

**Cleanup**: kill and `rm` both records.

---

### CLI-05 — Metadata edit obeys the same gate as the pencil

**Covers**: that the CLI is not a way around the mode-lock rule.

**Steps**

1. On a **headless** session in `idle`:
   `orch session metadata <id> --model claude-haiku-4-5 --json`.
2. On the same session while it is `running`: repeat.
3. `orch session metadata <id> --use-tmux false` on a **tmux** session
   that is `running`.
4. `orch session metadata <id>` with no fields.

**Expect**

- Step 1 succeeds; the envelope lists `changed: ["model"]`.
- Step 2 is **409** — `Cannot edit`, the same gate the dialog enforces.
- Step 3 is **400**, not 409: the record is editable, the *field* is
  not. (See [`metadata-edit.md`](metadata-edit.md) for why the two
  codes differ.)
- Step 4 fails locally with *"nothing to change"* and sends **no
  request** — an empty PATCH would otherwise read as success.

**Cleanup**: none.

---

### CLI-06 — Answer picks the mechanism off the record `[smoke]`

**Covers**: the one place the CLI does real work of its own. A tmux
selector is answered by index; a headless inquiry is answered by text.
The caller should not have to know which.

**Steps**

1. Drive a **headless** session to a structured inquiry (the prompt in
   [`headless-flow.md`](headless-flow.md) `HEADLESS-04` does it).
2. `orch session get <id> --json | jq .session.pendingInquiry`.
3. Answer it:
   ```bash
   orch session answer <id> --field env=staging --field ref=main --json
   ```
4. Now drive a **tmux** session to a permission modal and:
   ```bash
   orch session answer <id> --choice 2 --json
   orch session answer <id> --choice "allow" --json
   ```

**Expect**

- Step 3 POSTs to `/input` with the prompt `Environment: staging\nGit
  ref: main` — the same `label: value` rendering the web form sends, so
  the transcript reads identically whichever client answered. The
  envelope says `answered: "inquiry"`.
- A single-field inquiry answers **bare**: `--choice production` sends
  `production`, not `Environment: production`.
- Step 4 POSTs to `/answer-prompt` with `{"index": 2}` and the envelope
  says `answered: "prompt"` plus the resolved `option` text.
- Text matching is exact-first, then unique-substring. An **ambiguous**
  `--choice` (matching two options) is refused with the numbered list
  and **sends nothing** — the failure mode being prevented is an
  autonomous run approving the wrong permission.
- `session answer` against a session waiting on nothing fails with
  *"no pending prompt or inquiry"* rather than posting the choice text
  as a fresh turn.

**Cleanup**: kill and `rm` both sessions.

---

### CLI-07 — Adopt, with a dry run first

**Covers**: taking an outside harness session under management, and the
validate route the dialog calls on blur.

**Steps**

1. Start `claude` by hand in the fixture workspace, say one thing, quit.
   Note the conversation UUID under `$CLAUDE_CONFIG_DIR/projects/…`.
2. ```bash
   orch session adopt <uuid> --project "$PROJECT_CLAUDE" --dry-run --json
   orch session adopt <uuid> --project "$PROJECT_CLAUDE" --headless --json
   orch session adopt <uuid> --project "$PROJECT_CLAUDE" --json
   ```

**Expect**

- The dry run hits `/api/sessions/adopt/validate`, reports `dryRun:
  true`, and creates **nothing** — `session list` is unchanged.
- The real adopt returns **201** with `adoptedFrom` naming the harness
  uuid.
- The third call is **409** *already adopted*.
- A uuid that does not exist on disk is **400** with the validation
  layer that caught it named in the message.

**Cleanup**: `session rm` the adopted record. The harness transcript
stays on disk by design.

---

### CLI-08 — Export a bundle, import it back

**Covers**: the round trip, and `--format` as an assertion rather than
a request parameter.

**Steps**

1. `orch session export <id> --out /tmp/e2e-bundle.jsonl --json`
2. `orch session export <id> --out /tmp/x.tgz --format tar.gz --json`
3. ```bash
   orch session import /tmp/e2e-bundle.jsonl --project "$PROJECT_CLAUDE" --json
   ```
4. Import the same file a second time.

**Expect**

- Step 1 writes the file, and the envelope reports `format: "jsonl"`,
  `bytes`, and `sourceUuid` (read off the `x-orchestron-source-uuid`
  header).
- Step 2 **fails**: *"server exported jsonl, not tar.gz"*. The format
  follows the session's harness and transcript; no flag changes it, and
  writing ndjson into a file named `.tgz` is the failure this prevents.
  Nothing is left at `/tmp/x.tgz` that a later step could mistake for a
  tarball.
- Step 3 creates a new record and reports `importedFrom`.
- Step 4 reports `uuidRegenerated: true` — the destination already held
  that uuid, so it was regenerated and the transcript rewritten.

**Cleanup**: `session rm` the imported records; `rm /tmp/e2e-bundle.jsonl`.

---

### CLI-09 — Spawn with attachments and a template

**Covers**: the multipart path, which is a different branch of
`POST /api/sessions` than the JSON one.

**Steps**

1. ```bash
   orch session spawn --project "$PROJECT_CLAUDE" \
     --prompt "Summarise the attached file in one line." \
     --attachment ./README.md --attachment ./package.json \
     --model claude-haiku-4-5 --headless --json
   ```
2. ```bash
   orch session spawn --project "$PROJECT_CLAUDE" --attachment /no/such/file --prompt x
   ```
3. Spawn with `--template <id> --var env=stg` instead of a prompt.

**Expect**

- Step 1's request is `multipart/form-data` carrying the whole spawn
  payload in a single `body` field plus one part per file, and the
  envelope reports `attachments: 2`. The absolute paths are appended to
  the prompt, so the agent can Read them.
- Step 2 fails **before any request** — a missing attachment must not
  spawn a session and then error.
- Step 3 renders the template server-side. With `--template` present,
  stdin is *not* consulted for a second prompt body.

**Cleanup**: kill and `rm` the spawned sessions.

---

### CLI-10 — Long prompts arrive on stdin

**Covers**: the input path a workflow driver actually uses; argv is not
where a multi-paragraph prompt belongs.

**Steps**

1. ```bash
   orch session send <id> --json <<'EOF'
   First line.

   Third line.
   EOF
   ```
2. `orch session send <id>` with neither `--prompt` nor a pipe, from an
   interactive terminal.
3. `cat prompt.txt | orch session spawn --project "$PROJECT_CLAUDE" --headless --json`

**Expect**

- Step 1 sends the body verbatim, newlines intact, one trailing newline
  stripped. `promptChars` matches.
- Step 2 **errors immediately** with *"pass --prompt … or pipe one on
  stdin"*. It does not hang waiting on a terminal nobody is typing
  into: stdin is only read when it is not a TTY.
- Step 3 works the same way for spawn.
- A pipe containing only whitespace counts as no prompt at all.

**Cleanup**: none.

---

### CLI-11 — Schedule CRUD, including taking an override back off

**Covers**: create / edit / pause / resume / delete, and the three-valued
override fields.

**Steps**

1. ```bash
   orch schedule create --cron "0 9 * * 1" --project "$PROJECT_CLAUDE" \
     --prompt "weekly" --model claude-haiku-4-5 --headless --json
   ```
2. `orch schedule create --cron "* * * *" --project "$PROJECT_CLAUDE" --prompt x`
3. `orch schedule edit <id> --clear-model --follow-project-mode --json`
4. `orch schedule pause <id> --json`, then `resume`.
5. `orch schedule edit <id> --model x --clear-model`
6. `orch schedule delete <id> --json`

**Expect**

- Step 1 is **201**; `schedule get <id>` shows the pinned model and
  `Mode: headless`.
- Step 2 is **400** — four fields, not five. The API is not looser than
  the dialog, and a padded `* * * * *` would be an every-minute
  schedule that spends money unattended.
- Step 3 sends `{"model": "", "useTmux": null}` — the *clear*
  spellings. `schedule get` afterwards shows both as *project default*.
  Without an explicit clear, an omitted key merges and a pinned model
  could never be taken back off.
- Step 4's envelope reports `enabled` flipping; the cron and history
  survive — pausing is not deleting.
- Step 5 is refused locally, no request sent.
- Step 6 returns **204**, and the CLI still prints `{"ok": true,
  "deleted": true}` rather than choking on the empty body.

**Cleanup**: done in step 6.

---

### CLI-12 — Run a schedule now

**Covers**: the one schedule action that costs money, and the
`sessionUuid` the response carries.

**Steps**

1. Create a schedule pinned to `claude-haiku-4-5`, headless.
2. `orch schedule run <id> --json`.
3. Follow the returned `sessionUuid` with `session get`.

**Expect**

- The envelope is `{"ok": true, "sessionUuid": "…"}`. A response
  without the field still means the run fired — its presence is the
  signal that there is somewhere to navigate.
- The spawned session uses the schedule's pinned model, not the
  project's. **Pin a cheap model on every E2E schedule**: an unpinned
  *Run now* is what made one 4.5-second Opus session 37% of a whole
  sweep's cost.

**Cleanup**: kill and `rm` the session; delete the schedule.

---

### CLI-13 — Schedule YAML round trip

**Covers**: export / import, and `replace` mode.

**Steps**

1. `orch schedule export --out /tmp/scheds.yml --json`
2. `orch schedule export` with no `--out`, once plain and once with
   `--json`.
3. `orch schedule import /tmp/scheds.yml --mode merge --json`
4. `orch schedule import /tmp/scheds.yml --mode replace --json`
5. `orch schedule import /tmp/scheds.yml --mode clobber`

**Expect**

- Step 1 writes YAML and reports a `count`.
- Step 2 without `--out` writes the document to stdout unwrapped. With
  `--json` **and** no `--out` it errors: YAML nested inside a JSON
  string is not something a caller can use.
- Step 3 reports `created` / `updated` / `skipped` / `coerced` and
  leaves other schedules alone.
- Step 4 wipes first, then imports. **Export a backup before running
  this on a host with real schedules.**
- Step 5 is refused locally — `--mode` is validated before the file is
  read or sent.

**Cleanup**: `rm /tmp/scheds.yml`; restore any backup taken.

---

### CLI-14 — Metrics query

**Covers**: the read surface a driver uses to price its own run.

**Steps**

1. `orch metrics --group-by day --json`
2. `orch metrics --group-by model --from 2026-09-01T00:00:00.000Z --to 2026-09-11 --json`
3. `orch metrics --group-by wizard`
4. `orch metrics --from "last tuesday"`
5. `orch metrics --group-by session` and compare one bucket against
   that session's own `costUsd`.

**Expect**

- Every group-by in `day|project|session|adapter|model` returns
  `buckets` plus a `total`, and the human table carries a **TOTAL**
  row.
- Step 2 works: a full ISO timestamp is truncated to the `YYYY-MM-DD`
  the endpoint accepts, rather than 400ing on something a caller copied
  straight out of `session list --json`.
- Steps 3 and 4 are refused locally with no request sent.
- Step 5's numbers **will not match** the session record's `costUsd`,
  and that is expected — the two are priced by different mechanisms.
  See [`metrics.md`](metrics.md) `NF5`. Do not file it as a defect here.

**Cleanup**: none.

---

### CLI-15 — Project CRUD from the shell

**Covers**: the project surface, including un-pinning a default.

**Steps**

1. `orch project add --name cli-e2e --path /tmp --agent claude --default-model claude-haiku-4-5 --json`
2. `orch project get <id> --json`
3. `orch project edit <id> --clear-default-model --group "" --json`
4. `orch project edit <id>` with no fields.
5. `orch project rm <id> --json`

**Expect**

- Step 3 sends `defaultModel: null` — `null` is the clear, `""` is a
  typo and stays a 400. An omitted key merges, which is why the flag
  has to exist at all (B6-F2).
- `--group ""` clears the group; `group` takes `null` on the wire but
  is deliberately not in the unsettable-fields list, so the empty
  string is the documented spelling.
- Step 4 fails locally with *"nothing to change"*.
- Step 5 answers **204** and the CLI still prints `{"ok": true,
  "removed": true}` rather than choking on the empty body.

**Cleanup**: done in step 5.

---

## Resolved gaps

Recorded during the CLI parity batch and closed in the follow-up. The
rule applied to all three: the API is the contract, and the CLI stops
offering surface the API does not have.

- **`--group` on session commands does not exist — and stays that way.**
  `SessionMetadata` carries no group field and `SpawnSessionBodySchema`
  does not accept one, so zod would have stripped it and the flag would
  have silently done nothing. The dashboard's "group by project" control
  is a client-side view toggle over `projectId`. Grouping lives on the
  **project** (`project add/edit/list --group`). A session-level group
  would be an API and schema change, not a CLI one.
- **`session mark-success` is gone.** `POST /api/sessions/:uuid/archive`
  takes no body: no `success` flag, no second endpoint. It transitions
  through `completing` to `succeeded`, which is the state the web UI's
  mark-done button produces. One endpoint, one verb — `session archive`.
- **The `effort` enum differs by endpoint, and the CLI now says so.**
  Spawn accepts all six (`low|medium|high|xhigh|max|ultra`); `adopt`
  rejects `xhigh` and `max`; the revival and metadata routes reject
  `ultra`. The CLI validates against the target route's list *before*
  sending, so an unaccepted level costs no request and reports which
  levels that command takes, instead of a flattened zod dump that reads
  like a typo. See §10.2 of `docs/USAGE.md` for the table. Reconciling
  the enums server-side would let the table collapse to one list; until
  then the CLI mirrors what is there.

## Regression coverage

`apps/cli/tests/live-api.test.ts` runs the binary against the API's own
route plugins on a real socket — not the hand-written stub `wire.test.ts`
uses. That stub is why `session list` and `project list` shipped broken:
both routes answer `{ sessions: [...] }` / `{ projects: [...] }`, the CLI
destructured a bare array, and 42 wire tests stayed green while every
real invocation died. The live-API file also pushes a >64 KiB document
through a genuine shell pipe, which is where a lost stdout flush
(`process.exit` instead of `process.exitCode`) stops being invisible.
