# User Manual

Day-to-day workflows for agent-hq-orchestron. Assumes you've already
finished [DEPLOY.md](DEPLOY.md) and can reach the dashboard.

---

## Table of contents

1. [Concepts in one page](#1-concepts-in-one-page)
2. [Projects](#2-projects)
3. [Sessions — the core loop](#3-sessions--the-core-loop)
4. [Schedules](#4-schedules)
5. [Cross-session coordination](#5-cross-session-coordination)
6. [Dashboard tour](#6-dashboard-tour)
7. [Themes & appearance](#7-themes--appearance)
8. [Pairing & mobile](#8-pairing--mobile)
9. [Data on disk](#9-data-on-disk)
10. [Terminal interfaces (CLI + TUI)](#10-terminal-interfaces-cli--tui)
11. [Keyboard & touch shortcuts](#11-keyboard--touch-shortcuts)

---

## 1. Concepts in one page

- **Project** — a filesystem workspace (a git checkout, typically) that
  agents run against. Registered once, reused for every session.
  Optional defaults: model, effort, agent harness.
- **Session** — one Claude or Codex conversation (OpenCode adapter is
  on the roadmap — schema and config toggle are already in place, but
  no working adapter ships today). Runs in a
  `tmux` window when active; after `idleTimeoutMs` (default 15 min) of
  inactivity the tmux is released and the session becomes `sleeping` —
  it wakes up on the next `sendInput` via `claude --resume`.
- **Harness** — which agent CLI drives the session (`claude`, `codex`,
  `opencode` — roadmap only, not yet implemented). Selected per-session, defaults per-project.
- **Schedule** — cron expression that spawns a session on a fixed
  cadence. Cron parsed via `cron-parser`.
- **Note** — a shared key-value entry any session (or the UI) can read
  or write. Cross-session coordination primitive.
- **Terminal report** — when a child session is archived, a sanitized
  summary is auto-queued into the parent's `/input`. One-way, best-effort.
- **MCP server** — a stdio JSON-RPC server (`orchestron`) auto-injected
  into every spawn. Gives running agents 10 tools to spawn siblings,
  read peer transcripts, wait for idle, and share notes.

---

## 2. Projects

### Register

Dashboard → **Projects** page → **Register** button.

| Field | Notes |
|---|---|
| **Name** | Human label shown as a blue chip on session cards |
| **Path** | Absolute path to the workspace directory (must exist) |
| **Group** | Optional tag for filtering (e.g. `personal`, `work`) |
| **Tags** | Free-form multi-select |
| **Default agent** | Which harness spawns use by default |
| **Default model** | e.g. `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5-1`, `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5` |
| **Default effort** | `low` / `medium` / `high` / `xhigh` / `max` |

### Edit / delete

Hover a card on desktop, or just tap the icons on mobile (they're always
visible on small screens). **Delete** is soft-destructive:

- Project record is removed from `~/.orchestron/projects/`.
- **Existing session records stay** — they show the raw project uuid
  instead of the friendly name.
- **Running tmux + Claude processes are NOT killed.** Kill them from
  the dashboard first if you want a clean sweep.
- **Files on disk at the project path are untouched.**
- New spawns and scheduled runs targeting the deleted id will fail.

The confirmation dialog spells all this out. When the project still has
active sessions the dialog also shows an amber warning.

---

## 3. Sessions — the core loop

### Spawn

Dashboard → **Spawn** button (top-right, primary blue). The caret next
to it opens a small overflow menu with **Adopt** and **Import bundle**
— Spawn stays the daily target, secondary bring-in actions are one tap
away without crowding the header on mobile. The dialog:

- **Project** — dropdown, shows registered projects by name (not uuid).
  On select, a compact info panel below the dropdown surfaces what the
  session will actually spawn against: agent type, workspace path,
  config dir (with `(harness default)` marker when the project has no
  override), and the effective default model + effort with a
  `(project)` / `(harness)` source tag so it's clear where each
  default came from.
- **Template** — optional prompt template.
- **Model + effort** — per-session override; blank falls back to
  project default. The "Default" row in each dropdown labels the exact
  value it will resolve to (e.g. `Default — claude-sonnet-4-6
  (project)`), not a generic "project setting", so picking Default
  isn't a leap of faith.
- **Initial prompt** — the first user turn Claude receives.
- **Use tmux** — checked by default. Unchecking runs the session
  headless: one `claude -p` / `codex exec` process per turn, no tmux. The
  checkbox starts on the project's default and the helper text under it
  spells out what each mode gives up; see
  [Headless mode](#headless-mode-no-tmux).
- **Attachments** — drag/drop files (or paperclip button, or paste
  images). Saved to `/tmp/orchestron/uploads/pending/<hex>/` with
  `0600` perms and appended to the prompt as `Attached files:`.

Click **Spawn** and you'll land on the session detail page. Status
progresses: `spawning` → `running` (once TUI is ready + prompt paste
lands) → `needs_input` / `idle` / `succeeded`. A headless session skips
the TUI wait entirely: `spawning` → `running` → `idle`, then waits there
for the next turn.

### Adopt an existing harness session

Dashboard → caret next to Spawn → **Adopt**. Import a claude / codex
session that was started outside orchestron — via
`claude --resume <uuid>` in a terminal, a background job (nafu-bg-claude
/ claw-bg-claude), another supervisor, or another orchestron instance —
into a new orchestron record so it becomes fully manageable from the
dashboard (interrupt, send input, kill, reopen, PendingPromptBanner
all apply).

The dialog:

- **Project** — dropdown, only claude/codex projects offered (opencode
  is not supported for adoption). On select, orchestron surfaces the
  effective agent, workspace, and config dir (`CLAUDE_CONFIG_DIR` for
  claude, `CODEX_HOME` for codex) — labelled `(harness default)` when
  the project has no override.
- **Harness session UUID** — the UUID that harness assigned when the
  original session started. For claude: the value after `--resume`,
  or the filename under `<configDir>/projects/<mangled-cwd>/*.jsonl`.
  For codex: the value after `codex resume`, or the suffix of a
  rollout file under `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl`.
  A path template right under the input shows exactly where orchestron
  will look, resolved against the selected project's config dir +
  workspace.
- **Live validation** — orchestron dry-runs the check on blur:
  UUID format, transcript exists at the expected path, no active
  orchestron session already tracks this UUID, and — the important one
  — no live claude/codex process on the host is currently holding it
  (scanned via `/proc/*/cmdline`). If any check fails, an inline
  amber/red banner explains what to fix. Adopt button stays disabled
  until validation is green. Every check applies in headless mode too —
  a headless adopt starts no process, but its first turn will, so the
  race is deferred rather than avoided.
- **Use tmux** — checkbox, defaulted to the destination project's **Use
  tmux by default** setting (tmux for a project that sets none), and it
  re-defaults as you switch project in the dropdown. Ticked, adopting
  spawns a live tmux immediately. Unticked, the session is adopted
  headless: nothing starts, the record lands `idle`, and your next
  message is its first `claude -p --resume` / `codex exec resume`.
  Overriding the box is per-adopt and changes nothing about the project.
  Hidden when `enableHeadlessMode` is off, in which case the adopt runs
  in tmux and a toast says so — including when the project's own default
  was the headless one.

  Adopt has no *source* mode to preserve — the orchestron record is
  created here — which is why the project's policy is what fills the
  box. The source session's own mode does not constrain it either. Both harnesses
  keep one transcript store that `-p` and the interactive TUI scan
  identically, so a conversation started headless adopts into tmux and
  vice versa — the same cross-mode behaviour Reopen and Fork rely on.

  Pick **tmux** when you want to watch or attach, when you are not sure
  how the session was started, or when it may need the pending-prompt
  banner. Pick **headless** when you are adopting a background job you
  only intend to drive by message, or when you want the record parked
  with no process attached until you actually use it.
- **Adopt session** — for a tmux adopt, orchestron spawns a fresh tmux
  with the harness's native resume flag (`claude --resume <uuid>` /
  `codex resume <uuid>`) and wires the record through the same
  `spawning → waiting → idle` path a Reopen would follow (no re-sending
  the prompt — the resumed conversation already carries its history).
  A headless adopt skips all of that and goes straight to `idle`. Either
  way orchestron reads the first user prompt out of the transcript to
  seed the dashboard title, then redirects to the session detail page.

Adopted records get `metadata.adopted: true` and
`metadata.adoptedFromUuid` so you can distinguish them from natively-
spawned records later if needed.

Not for:

- Reopening a session orchestron already knows about — use the Reopen
  action on the session card instead.
- Read-only "just look at the transcript" — adopt creates a live,
  manageable record (and in tmux mode, a real `--resume` process). If
  you only want to read past output, open the JSONL directly.

Notes on `initialPrompt` for adopted sessions:

- Claude: read from the first `type:user` line in
  `<uuid>.jsonl`, first text block wins.
- Codex (rollout on disk): read from the first `response_item` with
  `payload.role='user'`; CLI-injected wrappers
  (`<environment_context>`, `<skills_instructions>`,
  `<user_instructions>`) are skipped so the returned text is what the
  user actually typed first.
- Codex (TUI-only, no rollout): read from
  `<CODEX_HOME>/thread_history_1.sqlite`'s first
  `thread_items` row with `item_type='userMessage'`.
- Cap: 500 characters. Placeholder text
  `(adopted … — first prompt unknown)` only appears when the
  transcript exists but no user message could be extracted (very rare).

### Delete a session record

Session detail header → trash icon (only visible for terminal states:
`succeeded` / `killed` / `failed` / `sleeping` — active sessions must
be killed first). Permanently removes the orchestron record so it stops
appearing in list/dashboard. The harness transcript stays on disk, so
the same session can be re-adopted later via Adopt using the same UUID.

The confirm dialog explicitly enumerates:

- **Deleted**: `~/.orchestron/sessions/<uuid>.json` (+ `.bak`),
  `~/.orchestron/mcp-configs/<uuid>.json` (+ `.bak`).
- **Preserved**: the harness transcript at
  `<CLAUDE_CONFIG_DIR>/projects/<mangled-cwd>/<uuid>.jsonl`, the Claude
  file-edit history at `<CLAUDE_CONFIG_DIR>/file-history/<uuid>/`,
  the orchestron metrics aggregate, and delegation edges (parent/child
  edges become harmless orphans — clearing them would break the tree
  for surviving siblings).

Distinct from kill:

| Action | State change | Record | Tmux | Harness transcript |
|---|---|---|---|---|
| Kill (X icon) | active → `killed` | stays for review | terminated | untouched |
| Delete record (trash icon) | record removed | removed | terminated best-effort if lingering | untouched |

### Export / import a session bundle

Move a harness session between orchestron hosts (server ↔ Mac, or across
orchestron installs). No shared filesystem needed — just download from
one, upload to the other.

**Export** — session detail header → download icon (sky-blue arrow, next
to Archive/Kill). Available whenever the session has a
`claudeSessionUuid`. Auth-aware: it fetches the transcript via the API
(with your Bearer token), then triggers a browser Save-File dialog on
the returned blob. A spinner shows while the fetch is in flight; the
button flashes red for a few seconds on failure and reverts.

Bundle format picked automatically per harness:

| Session shape | File | Contents |
|---|---|---|
| claude | `.jsonl` | Raw `<uuid>.jsonl` from `<CLAUDE_CONFIG_DIR>/projects/<mangled-cwd>/` |
| codex with rollout on disk | `.jsonl` | Raw `rollout-*-<uuid>.jsonl` from `<CODEX_HOME>/sessions/YYYY/MM/DD/` |
| codex TUI-only (SQLite only) | `.tar.gz` | `metadata.json` + `dump.jsonl` — one line per `thread_turns` / `thread_items` / `thread_history_projection_state` row scoped to this thread |

`metadata.json` in a `.tar.gz` bundle records `useTmux`, so the session's
run mode travels between hosts alongside its uuid and workspace. The
`.jsonl` formats have no envelope to put it in — they are the raw
transcript — so a jsonl bundle carries no mode. On import that recorded
mode is a *fallback*, not a mandate: the destination project's own
setting outranks it (see below).

Filename convention: `orchestron-<agentType>-<uuid>.jsonl` or
`orchestron-codex-tui-<uuid>.tar.gz`. Content-Disposition drives it;
the client falls back to `orchestron-session-<orchUuid>.<ext>` if the
header was stripped.

**Import** — Dashboard → caret next to Spawn → **Import bundle**. The
dialog:

- **Destination project** — dropdown; only claude/codex projects offered.
  On select, orchestron surfaces effective agent / workspace / config
  dir the same way Adopt does.
- **Bundle file** — accepts `.jsonl`, `.tar.gz`, `.tgz`. A preview chip
  shows the parsed format, detected harness (from filename hint), and
  source UUID before you submit. If the detected harness disagrees with
  the destination project, an amber banner warns you the server will
  refuse with 409.
- **Use tmux** — checkbox, defaulted to the destination project's **Use
  tmux by default** setting, and it re-defaults as you switch project in
  the dropdown. It is sent only once you touch it, because the dialog
  cannot read a bundle's metadata without unpacking a gzip in the
  browser. The mode is settled in this order:

  1. an explicit choice — you touched the box, or a direct API caller
     sent the field;
  2. the destination project's `defaultUseTmux`;
  3. the mode the bundle recorded (`.tar.gz` only);
  4. tmux.

  So a project that configures a mode gets it, and a bundle's recorded
  mode decides only for a project that expresses no preference. The
  hint under the box says which of those applies to the bundle and
  project in front of you. Hidden when `enableHeadlessMode` is off, in
  which case the import runs in tmux and a toast says so — including
  when it was the *project* or the *bundle* that asked for headless.
- **Import session** — orchestron:
  1. Parses the first ~10 JSONL lines (or `metadata.json` inside the
     tar) to confirm harness + source UUID.
  2. Resolves destination transcript path against the project's
     workspace + config dir the same way spawn/adopt do
     (Claude → `<CLAUDE_CONFIG_DIR>/projects/<mangled-cwd>/<uuid>.jsonl`;
     Codex rollout → `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
     with today's UTC date + a fresh timestamp; Codex TUI →
     `<CODEX_HOME>/thread_history_1.sqlite`).
  3. If a transcript already exists at that path (or a codex thread
     with the same id already lives in the destination SQLite),
     regenerates the session UUID via `crypto.randomUUID()` and
     `replaceAll`s occurrences of the old UUID in the bundle content
     before writing.
  4. Writes the transcript (jsonl) or inserts the rows
     (`INSERT OR REPLACE` into `thread_turns` / `thread_items` /
     `thread_history_projection_state`) — codex TUI import requires the
     destination `thread_history_1.sqlite` to already exist (run
     `codex` at least once on the destination host).
  5. Calls the same `manager.adopt()` used by the Adopt button, so
     the imported session picks up an orchestron record and seeds
     `initialPrompt` from the transcript — spawning a fresh tmux via
     `claude --resume` / `codex resume` in tmux mode, or landing
     straight in `idle` with nothing running in headless mode.

Response includes `importedFromUuid` (the original) and
`regeneratedUuid: true|false` so the caller can tell whether a
collision fired the rewrite path, plus `coerced` when the kill switch
turned a headless import into a tmux one.

Calling the endpoint directly, `useTmux` is an optional multipart field
accepting exactly `"true"` or `"false"` — multipart carries no types, so
anything else is a 400 rather than a guess. Omit it to get the
project-then-bundle-then-tmux fallback described above.

Round-trip verified: export on host A → import on host B → the
resumed conversation carries its full history exactly as it did on A.

**Not** a workaround for cross-account harness auth — the destination
must have the same claude/codex CLI available and authenticated (via
its own keychain / config dir) so `--resume` can pick up the session.
Bundles carry conversation state, not credentials.

### Session detail page

Header shows: status pill, project chip (blue), harness chip (violet
uppercase — `CLAUDE` / `CODEX` / `OPENCODE`), model, effort, and (when
applicable) two delegation chips:

- **`⑃ N`** on parent sessions — count of direct children, hover
  shows detail + points to menu Graph for the tree view
- **`⑃ parent: <8-char>`** on child sessions — links to the parent's
  detail page; hover title shows a preview of the parent's initialPrompt

Same chips appear on dashboard SessionCards so the tree structure is
visible at both list and detail level without opening Graph.

Action buttons (based on state):

| Icon | Action | Available when |
|---|---|---|
| ▶ Play (green) | **Reopen** — resume with same context, same claude-session-uuid | terminal states (`succeeded`, `killed`, `failed`) |
| Fork (blue) | **Clone** — spawn a new session inheriting this conversation | always |
| ↻ Rotate (orange) | **Respawn** — fresh session with same prompt, new harness UUID | terminal states |
| ✓ Check (green) | **Archive** — mark succeeded, kill tmux | active states |
| ↓ Download (sky) | **Export bundle** — auth-aware fetch + Save-File on `.jsonl` / `.tar.gz` | session has a `claudeSessionUuid` |
| ✕ X (red) | **Kill** — SIGKILL tmux + mark killed | active states |
| 🗑 Trash (red) | **Delete record** — remove orchestron record, keep transcript | terminal / sleeping |

Inline edit: a small **pencil** icon renders next to the effort chip in
the header when the session has no live tmux (`succeeded` / `killed` /
`failed` / `sleeping`, plus `idle` / `needs_input` on a headless session,
which holds no process between turns). It opens a metadata-only dialog
with Model + Effort selects (plus a *Reset to project default* option)
and a **Use tmux** checkbox. The change is written to the session record
via `PATCH /api/sessions/:uuid` and takes effect on the next spawn —
Reopen, Respawn, or wake from sleep. Active sessions have claude already
bound to a specific model, so the server refuses the patch (409) and the
UI hides the button.

**Use tmux is locked while a headless session rests** — at `idle`,
`needs_input` or `sleeping`. The checkbox greys out
and the dialog points at Reopen, Fork and Respawn instead; a `PATCH`
carrying `useTmux` in those states is refused with **400** and nothing in
the patch lands, model and effort included. Everything else in the dialog
still applies there — see [Mode is locked while a session
rests](#mode-is-locked-while-a-session-rests).

Expand the header (chevron under the timestamps) for id/project/agent/
started/ended/cost detail.

### Send input

Bottom of the transcript pane. The composer:

- **Works while running** — text queues; Claude picks it up after the
  current turn ends.
- **Interrupt button** (red ⬛) — appears only while `running`. Sends
  `Escape` to the tmux pane and proactively transitions status to
  `idle` (Claude's interrupt path doesn't write `turn_duration`, so we
  don't wait for one).
- **File attach** — paperclip button, drag/drop, or paste image. Files
  saved to `/tmp/orchestron/uploads/<sid>/` and appended to your prompt
  as `Attached files:` list.

### AskUserQuestion — answer inline in the transcript

When Claude calls its `AskUserQuestion` tool, orchestron detects the
tool_use entry in the transcript and renders it as a violet card inline
where it appears (instead of a generic JSON dump):

- Each question shows its header + prompt text
- Options render as clickable pills — pick one, or hold `multiSelect` and
  toggle several
- An `✎ Other` pill reveals a free-text input for a custom answer
- **Send answer** posts the formatted answer to
  `POST /api/sessions/:uuid/input` (the same endpoint the composer uses),
  so it lands in the tmux session as a normal user message and Claude
  proceeds
- Multiple questions in one call are collected and joined into
  `Header: answer` lines before send
- The card auto-disables once any `tool_result` appears later in the
  transcript (heuristic — one pending AskUserQuestion is the common
  case, and entry shape doesn't expose `tool_use_id` linkage)

The card doesn't try to arrow-key-navigate Claude's TUI selector — it
sends the picked label as text and relies on Claude to dismiss its own
selector. If you ever see the selector stuck after send, attach to the
tmux pane read-only (`tmux attach -rt <tmux-name>`) and press `Escape`.

**Not** used for permission approvals (e.g. `Bash rm foo.txt — Approve?`)
— those are runtime safety gates, not tool calls, and don't appear in
the transcript. See "Session stuck on `running` status" in DEPLOY.md
and the "Pending prompt banner" subsection below.

### Pending prompt banner (permission approval / interactive selector)

Some interactive TUI modals never make it into the transcript JSONL —
current Claude buffers `AskUserQuestion` tool_use writes until the modal
is answered, permission approval prompts are runtime safety gates that
aren't tool calls at all, and codex's first-workspace trust prompt
lives entirely in the TUI. Without help, orchestron would show these
sessions as `running` forever until you attached to the tmux pane
manually.

A background sweep (every 20 s) `tmux capture-pane`'s every claude AND
codex session that's still in `running` / `needs_input`, matches the
universal TUI selector footer (`↑/↓ to navigate` + `Enter to select`),
and when it finds one:

- Transitions `running → needs_input` so the dashboard list surfaces
  the session as waiting.
- Parses the modal (checkbox header + title + options + optional
  detail band above the option list) into `session.pendingPrompt`.
- Session detail page renders a `PendingPromptBanner` above the
  transcript with each option as a clickable button — click sends
  `Down ×(index-1) + Enter` into the tmux pane to answer the modal;
  banner is cleared optimistically and the next sweep confirms.

Applies to **both** claude and codex. The parser anchors on the
`☐ <header>` line at the top of the modal and walks down past
separators / description continuation lines to collect all numbered
options, so codex extras like `Type something` / `Chat about this`
that live below a separator are still captured in order. `kind` is
marked `permission` when the pane contains `Do you want to proceed?`
or `Do you want to allow`, otherwise `question` (styling only —
same submit path).

Not covered:

- Opencode adapter (not scanned yet).
- Modals whose footer doesn't include the universal navigate/select
  hint (rare — if you find one, the regex in
  `apps/api/src/domain/session-manager.ts parseSelectorModal` needs
  to be extended).

### Status lifecycle (allowed transitions)

```
spawning ──▶ waiting ──▶ running ──▶ needs_input
                          │           │
                          ▼           ▼
                        idle ────▶ (user replies) ──▶ running
                          │           │
                          │           └─▶ sleeping    (after IDLE_TIMEOUT)
                          │                 │
                          │                 └─▶ send input ──▶ spawning ──▶ running  (wake-up)
                          │
                          └──▶ succeeded (archive)
                                │
                                ▶ (reopen) waiting…

any active state ──▶ killed  (X button)
any state       ──▶ failed  (crash)
```

Headless sessions follow the same shape with two differences: there is no
TUI to wait for, so no `waiting`; and the sleep on either side of the idle
timeout is **symbolic** — the record moves, nothing is released, and the
wake costs no spawn. The child process is what is ephemeral; the session
is not.

```
spawning ──▶ running ──▶ idle ──▶ (send input) ──▶ running ──▶ …
                  │        │
                  │        ├──▶ sleeping   (after IDLE_TIMEOUT, symbolic)
                  │        │        │
                  │        │        └──▶ send input ──▶ idle ──▶ running  (free wake)
                  │        │
                  │        └──▶ succeeded  (archive)
                  ├──▶ needs_input  (turn returned a structured inquiry)
                  │        │
                  │        └──▶ (answer) ──▶ running ──▶ …
                  └──▶ failed  (non-zero exit / signal / spawn error)

running ──▶ killed  (X button — SIGTERM to the child)

(terminal) ──▶ (reopen into headless) ──▶ spawning ──▶ idle
```

Two edges exist only for headless. `spawning → running` skips the `waiting`
phase, because the prompt is already in argv and the turn starts at launch.
`spawning → idle` is the reopen-into-headless path, which brings a record
back to life without running anything — see
[Reopen, Fork and Respawn across modes](#reopen-fork-and-respawn-across-modes).

The API enforces `ALLOWED_TRANSITIONS` in `SessionManager`; illegal
transitions throw `InvalidTransitionError`.

### Headless mode (no tmux)

By default every session runs an interactive harness TUI inside its own
tmux window. Unticking **Use tmux** runs it headless instead: each turn is
a single `claude -p` (or `codex exec`) child process that works through the
turn and exits.

**One process per turn, not one process per session.** A headless session
is multi-turn like any other: it comes to rest in `idle` when a turn ends,
and the next thing you send starts a fresh `claude -p --resume <id>` /
`codex exec resume <id>` child against the same conversation. It reaches a
terminal state only when you Kill or Archive it.

> Phase 1 of this feature really was single-shot — a finished run went
> straight to `succeeded` and refused follow-up input, Reopen and Fork.
> If you are reading older notes that say so, they are out of date.

**Where to set it**, in increasing precedence:

| Where | Effect |
|---|---|
| Nothing set | tmux — the default, and what every pre-existing session is |
| Project → **Use tmux by default** | applies to every session-creating path in that project — spawns, Adopt, Import, and any schedule that does not pin a mode of its own |
| Schedule dialog → **Use tmux** | every run of that schedule; unset follows the project — see [Schedules](#4-schedules) |
| Spawn / Adopt / Import dialog → **Use tmux** | this session only; the box starts on the project's setting |
| Reopen / Fork / Respawn dialog → **Use tmux** | the mode the session comes back in — see below |
| Session detail → ✎ (pencil) | changes the mode the session will use on its next spawn — **terminal only** for a headless record, terminal or sleeping for a tmux one |

The mode is baked into the process arguments when a turn starts, so it
cannot change mid-flight. The pencil is editable whenever nothing live is
bound to the current values: terminal or sleeping for a tmux session, and
also `idle` / `needs_input` for a headless one, which holds no process
between turns.

#### Mode is locked while a session rests

The pencil's **Use tmux** checkbox is narrower than its Model and Effort
selects. It is live on a **terminal** record, and on a **sleeping tmux**
one — that sleep really did release the window, so the next send has to
spawn and the new mode becomes real. It is greyed out on a headless record
at any resting state (`idle`, `needs_input`, `sleeping`), where the dialog
names Reopen, Fork and Respawn instead: a headless wake takes no spawn, so
there is nothing for the new mode to take effect on.
`PATCH /api/sessions/:uuid` enforces the same
rule: `useTmux` in those states is **400**, and the whole patch is refused
so nothing lands half-applied.

The two field groups are read at different moments, which is the whole
reason for the split. Model and effort are read at the next **spawn**.
`useTmux` is read first, by whatever delivers the next turn — and on a
resting headless session that is `send input`, which branches on the field
to choose between a headless child and a tmux paste. Flip the record to
tmux while it rests and the next message takes the tmux branch against a
`tmuxName` that is a spent headless handle: nothing is listening, the TUI
wait swallows its own failure, and the session moves to `running` behind no
process at all. It never lands, because nothing is coming to land it.

Reopen, Fork and Respawn do not have this problem — they spawn, so the mode
they write becomes real immediately. That is where a cross-mode change
belongs, and the dialog says so.

Records stranded this way before the lock existed are recovered
automatically: a sweep at server boot, and every 10 minutes after, moves any
tmux-mode `running` session that has no `tmuxName` into `failed` with
`failureReason: "cross-mode transition failed — no tmux window found"`,
which frees its pool slot and makes Respawn reachable again. The check is
deliberately narrow — a running *headless* turn holds no window by design
and is never touched.

#### Reopen, Fork and Respawn across modes

All three revival dialogs carry the same **Use tmux** checkbox, defaulted
to the session's *current* mode — the neutral choice being the one that
changes nothing, exactly as the model and effort pickers default to the
session's own values. Tick or untick it to move a session across the
boundary.

| Action | **Use tmux** ticked | unticked |
|---|---|---|
| **Reopen** | resumes the conversation in a fresh tmux session | brings the record back to `idle` with **no process at all** — nothing runs until you send a turn |
| **Fork** | new session id, inherits the conversation, runs in tmux | new session id, inherits the conversation, rests in `idle`; a prompt in the dialog becomes its first turn |
| **Respawn** | fresh conversation from the original prompt, in tmux | fresh conversation from the original prompt, headless |

Reopening *into* headless deliberately runs nothing. There is no process to
bring up, so "reopen" there means exactly "make this session live again,
ready for input" — spending a `-p --resume` invocation on an empty prompt
would burn a turn to accomplish nothing you asked for.

A conversion sticks: reopening a headless session into tmux writes
`useTmux: true` to the record, so a later Kill + Reopen does not silently
drop back to headless.

**No context is lost crossing the boundary, in either direction.** Both
harnesses resume the same conversation from either mode — Claude's `-p` and
interactive TUI share one JSONL store and scan it identically, and
codex-cli writes both the rollout JSONL and the `thread_history` SQLite
whichever mode produced the thread. There is no file copying or session-id
rewriting involved; it is the harness's own resume.

(Earlier notes describe Reopen and Fork as unavailable for headless
sessions. That was a conservative gate from Phase 1, since removed.)

#### Disabling it globally

Every toggle above sits under one server-side switch. Set
`enableHeadlessMode` to `false` in `~/.orchestron/config.json` and no
session can be spawned headless, whatever the project or spawn dialog
says:

```json
{
  "enableHeadlessMode": false
}
```

Restart the API for it to take effect (the config is read once at boot —
see [DEPLOY.md](DEPLOY.md#option-b-config-file) for the restart command
on your host). It defaults to `true`; omit the field entirely and
headless behaves exactly as documented above.

The switch **masks** rather than blocks. Nothing returns an error: a
headless request is quietly run as tmux, and the response says so. The
UI removes the choice instead of showing one it cannot honour.

With the switch off:

| Action | Result |
|---|---|
| Spawn with `useTmux: false` | runs in **tmux**, `201` — response carries `coerced` |
| Spawn, Adopt or Import in a project whose default is headless | runs in **tmux**, `201` — response carries `coerced` |
| **Import** of a bundle that recorded headless | runs in **tmux**, `201` — response carries `coerced` |
| `PATCH /api/sessions/:uuid` with `useTmux: false` | saved as **tmux**, `200` — response carries `coerced` |
| `PATCH` with `useTmux: true` on a headless record | allowed on terminal records, so they can be unwound while the switch is off; **400** at `idle` / `needs_input` / `sleeping` |
| `PATCH` of model or effort only | mode field untouched — a headless record stays headless on disk |
| **Reopen** / **Fork** / **Respawn** with **Use tmux** unticked | comes back in **tmux** — response carries `coerced` |
| **Reopen** / **Fork** / **Respawn** with no mode given | comes back in **tmux** whatever the record says |
| Already-running headless session | keeps running; a live process cannot be converted mid-flight |
| A headless session's next turn | runs in **tmux**? No — a turn resumes an existing conversation rather than spawning, so it stays headless until the session is respawned or reopened |

Every coercion also logs at info level on the API, with the requested and
effective values, so "I asked for headless and got tmux" is answerable
from the log alone.

##### The `coerced` field

A mutation the server overrode returns an extra field alongside the
session:

```json
{
  "id": "…",
  "useTmux": true,
  "coerced": { "useTmux": true, "reason": "headless disabled globally" }
}
```

It is **absent** when nothing was coerced, so a client can treat its
presence as the whole signal. The web UI raises a toast on it —
*"Headless mode is disabled globally — this session runs in tmux."* —
which is what keeps the masking from being silent. Spawning an ordinary
tmux session while the switch is off returns no `coerced` field and no
toast.

##### In the web UI

The **Use tmux** checkbox is **hidden entirely** in the spawn dialog, the
project dialog, the session pencil and the Reopen / Fork / Respawn dialog.
With headless unavailable there is one mode left and nothing to choose, so
a checked-and-disabled box would only invite the question. Settings → Server Info shows the current state
and, when off, notes that existing headless sessions get coerced on their
next spawn.

Nothing rewrites a stored preference. A project whose `defaultUseTmux` is
`false`, or a session record whose `useTmux` is `false`, keeps that value
on disk and picks it up again when the flag is turned back on — so
editing a project's model during an outage does not silently convert it
to tmux. The exceptions are the actions that genuinely relaunch the
session — **Respawn**, and **Reopen** into tmux — because the record each
rewrites really is a tmux session afterwards.

The **Headless** badge follows the same masking, split by liveness. A
*live* headless session keeps its badge — including one resting in `idle`
between turns, since its next turn really will be headless and the user
needs to know why there is no TUI to attach to. Once the session reaches a
terminal state (`succeeded` / `failed` / `killed`) the badge comes off,
because it would otherwise describe a mode the user can no longer pick,
sitting next to Reopen and Respawn buttons that will not produce it. With
the switch on, the badge always shows.

##### Reopen and Fork coerce too

They used to be exempt, because reopening a headless record was refused
outright and a coercion would have slipped past that gate without making
the resume any safer. The refusal is gone — cross-mode resume is verified
on both harnesses now — so there is nothing left to slip past, and both
are ordinary places a session could end up headless. With the switch off
they come back in tmux and say so, like every other coerce site.

**What is different.** Headless is not a cheaper tmux — it is a different
shape of session:

| | tmux (default) | headless |
|---|---|---|
| Live transcript | yes, streams as the turn runs | yes — the harness writes the same JSONL |
| Attach to the live TUI | yes (`tmux attach`) | no long-lived process to attach to |
| Follow-up input | yes, and queueable mid-turn | yes, but **not** mid-turn — one turn at a time |
| Interrupt a turn | yes (Escape) | yes (SIGTERM); session returns to `idle` |
| Ask the user a question | selector modal in the pane | structured `inquiry` — see below |
| Sleep / wake on idle | yes — the sleep releases the tmux window | yes, but symbolic — nothing to release, and the wake is free |
| Reopen / Fork / Respawn | yes | yes, and either mode can be the target |
| `wait_for_idle` MCP tool | available | withheld — see below |
| Pool cap slot | held until sleep or terminal | held only while a turn is in flight — `idle` and `sleeping` are both free |

The one input restriction is real and worth understanding: a tmux TUI
buffers a pasted prompt and runs it as the next turn, so you can queue
while the model is thinking. A headless child has no stdin at all, and
launching a second `--resume` against a live one would put two processes on
the same transcript. So the input box greys out during a headless turn.
Interrupt if you need to get in front of it.

**When it is the right choice**

- Batch work: fan out N independent tasks without N tmux windows
  competing for the pool cap — an idle headless session holds no slot.
- Scheduled / cron runs where nobody is watching a TUI and the result is
  read after the fact.
- Fire-and-forget tasks with a self-contained prompt, where you may still
  want to come back and ask a follow-up later.
- Hosts where tmux is inconvenient or absent.

Stay on tmux when you expect to steer the session, answer a question
mid-run, or attach to watch it work.

**Notes and sharp edges**

- *Quota is unchanged.* `claude -p` authenticates from the same
  `CLAUDE_CONFIG_DIR` credentials as the interactive TUI, so a
  subscription still applies. Headless is not "the API-billing mode".
- *The transcript is the harness's, not orchestron's.* Claude writes
  `<CLAUDE_CONFIG_DIR>/projects/<mangled-cwd>/<uuid>.jsonl` in `-p` mode
  exactly as it does interactively; `codex exec` writes
  `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl`.
  Orchestron reads those files and never keeps a second copy.
- *No `turn_duration` event.* Headless transcripts contain no turn-end
  marker — process exit is the turn boundary. Nothing downstream should
  wait for one.
- *`wait_for_idle` is not offered to headless agents.* It blocks until a
  child session goes idle, which can be minutes; a one-shot invocation
  has no turn boundary to release it and no way to interrupt, so the run
  would simply hang. The other nine orchestron MCP tools are available.
  Async delegation for headless parents is future work.
- *An idle headless session does not occupy a pool-cap slot.* Between
  turns it holds no tmux, no pty and no pid, so counting it would let a
  pile of finished one-shots block new spawns for nothing. It counts again
  the moment a turn is in flight. `sleeping` is free for the same reason.
- *Headless sleeping is a label, not a shutdown.* After `IDLE_TIMEOUT` the
  idle sweeper moves a headless session to `sleeping` exactly as it does a
  tmux one, but where the tmux sweep kills a window, the headless sweep
  writes the record and stops. Nothing is killed, nothing is torn down,
  nothing is cleaned up — there was never anything holding on. It exists so
  the dashboard can tell a session that finished a turn a second ago from
  one abandoned since yesterday, and so the idle list stops growing without
  bound. Sending input wakes it: `sleeping → idle` and straight into the
  next `-p --resume` turn, with none of the tmux wake-up's cold start. The
  one thing it costs you is the mode toggle — the ✎ pencil greys the **Use
  tmux** control out on a sleeping headless record, same as at `idle`,
  because waking takes no spawn for the new mode to become real. Reopen /
  Fork / Respawn are still the way to change mode.
- *An API restart mid-turn lands the session in `idle`, not `failed`.* The
  turn is owned by an in-memory promise that dies with the process, so
  nothing would ever land it. The turn's output is already in the harness's
  transcript and the conversation is still resumable, so the session is
  made live again with an explanatory `failureReason`; read the transcript,
  then send the next turn.
- *Failures carry a reason.* A non-zero exit records the child's stderr
  tail on the session as `failureReason`, so a headless run that dies at
  launch (bad model name, expired credentials) says why instead of just
  going red. A later successful turn clears it.

#### Each resume shows up in the transcript, quietly

`claude -p --resume` opens every turn after the first by injecting
`Continue from where you left off.` as the user message; the model, with
nothing pending, usually answers `No response requested.` Neither line was
written by you or chosen by the agent, but both are genuinely in the
rollout — and hiding one of them is what once made that reply appear to
answer a question nobody asked.

So the pane shows both, and styles them as what they are: a small italic
`resume` aside rather than a chat turn, no avatar and no bubble. They stay
in `GET /api/sessions/:uuid/transcript` untouched, so `orchestron session
tail` and any other client still see a complete conversation — this is a
rendering decision in the web pane, not a filter.

It matters more than it sounds: there is exactly one such pair per resume,
so on a chatty session with short turns it approaches half of everything in
the pane. A five-turn session measured 8 of its 18 entries.

The reply half is only treated this way when it sits **immediately after**
the nudge. An agent that writes "No response requested." in a real answer
keeps its bubble.

#### How a headless agent asks you a question

A tmux agent that needs input opens a selector modal in its pane, and
orchestron scrapes it into the approval banner. A headless agent has no
pane — and by the time you would see the question, no process either. So
it uses structured output instead.

Every headless invocation is handed a small JSON schema whose final
response looks like this:

```json
{
  "summary": "Stopped before deploying; need the target confirmed.",
  "inquiry": {
    "message": "Which environment and region should I deploy to?",
    "fields": [
      { "name": "environment", "label": "Target environment",
        "type": "choice", "options": ["dev", "stg", "prd"] },
      { "name": "region", "label": "GCP region", "type": "text", "options": null }
    ]
  }
}
```

`inquiry` is `null` on a turn that needs nothing, and the session lands in
`idle` as usual. When it is populated, the session lands in `needs_input`
and the session page renders the fields as a form. Submitting it sends your
answers as ordinary input, which starts the next turn — the agent resumes
with them in context.

Three consequences worth knowing:

- **`finalResponse` becomes the model's summary of its answer**, not the
  answer's prose. The full text is still in the transcript, which is what
  the session page shows; only the one-line field on the record changes.
  If you have a workflow reading `finalResponse` as the deliverable, that
  is the reason to turn this off.
- **It is a request to the model, not a guarantee.** A response that comes
  back as plain prose is treated as the summary with no inquiry, so nothing
  is lost when a model ignores the schema.
- **The schema is strict-mode** — `additionalProperties: false` on every
  object and every property listed in `required`, with optionality
  expressed as `type: ["object", "null"]`. Codex rejects a schema that
  isn't; Claude accepts one that is. One document serves both, though they
  take it differently: Claude's `--json-schema` wants it inline and errors
  on a path, Codex's `--output-schema` wants a file.

##### None of this is visible in the transcript

Structured output is machinery, and the transcript pane shows you the
conversation, not the machinery. The schema is requested purely through a
CLI flag — nothing is appended to your prompt — and each harness's
book-keeping is stripped out of the transcript before it reaches any client:

- Claude answers the schema by calling a synthesised `StructuredOutput`
  tool, which lands in the transcript as a tool call carrying the raw JSON
  document plus a canned "Structured output provided successfully" result.
  Both are dropped; you see the prose answer, exactly as with the schema
  off. In the rare case where the model answers *only* through the tool and
  writes no prose, its `summary` is shown as the assistant message so the
  turn is never blank.
- Codex has no such tool — its final message simply *is* the document, so
  that message is rendered as its `summary`.

This is done in `GET /api/sessions/:uuid/transcript`, so the web pane, the
TUI and `orchestron session tail` all agree. It applies to headless sessions
only; a tmux transcript is passed through untouched.

An assistant message that merely *looks* like JSON is left alone. Only an
object whose keys are exactly `summary` and `inquiry` counts as ours — an
agent legitimately asked to answer in JSON keeps its answer.

Before this was in place (Phase 2 as first shipped), a headless session
rendered the enforcement chatter and a raw `{"summary": …, "inquiry": null}`
block instead of its answer. If you turned `headlessStructuredOutput` off to
work around that, it is safe to turn back on.

To turn it off, set `headlessStructuredOutput` to `false` in
`~/.orchestron/config.json` and restart the API:

```json
{
  "headlessStructuredOutput": false
}
```

Headless then behaves as it did before: prose in `finalResponse`, and no
way for the agent to raise a question. Defaults to `true`.

### Sleep / wake-up (idle sweeper)

Sessions in `idle` for longer than `idleTimeoutMs` (default **15 min**)
automatically warm-shutdown:

- Tmux window is killed → no resources held.
- Session status transitions to `sleeping`.
- Claude session state stays intact in JSONL — nothing is lost.

`needs_input` is **exempt**. It is idle in the sense that no child is
working, but the session is blocked on a person and still holds the
`pendingInquiry` they have to answer — sweeping it put a *Sleeping* pill
above a live *Agent needs input* form and dropped the session out of the
dashboard's needs-input stat. The cost is a tmux window held for as long
as nobody answers, which is the trade: the window is where the answer
goes. Entering `needs_input` also disarms the timer `idle` had armed. An
explicit kill or archive still applies, and `needs_input → sleeping`
remains a legal transition for a caller that means it.

**Waking one up:** just send input. `POST /api/sessions/:uuid/input`
(or the MCP `send_input` tool, or typing into the composer in the UI)
does a cold-start `claude --resume <uuid>` transparently — ~3-5s of
"spawning" state, then back to `running`. No manual reopen button, no
new session id.

**Config:**
```json
// ~/.orchestron/config.json
{ "idleTimeoutMs": 900000 }    // 15 min default; 0 disables sweeper
```
Env override: `ORCHESTRON_IDLE_TIMEOUT_MS=<ms>`.

**Restart safety:** on API boot, `resumeIdleSweepers()` scans every
`idle` session and either warm-shuts-down immediately
(if past threshold) or arms a shortened timer for the remaining time.
A safety-net sweep every 10 min catches orphans whose primary timer
was somehow lost.

### Reopen vs Fork vs Respawn

Three ways to bring a terminal session back to life:

| | Reopen | Fork | Respawn |
|---|---|---|---|
| **Session id** | Same | New | Same |
| **claude-session-uuid** | Same | Same (shared context) | **Fresh** |
| **JSONL** | Same (resume) | Same (resume) | **New** (start over) |
| **Purpose** | Continue same conversation | Explore alternative branch | Restart from prompt |
| **When to use** | "Resume where I left off" | "Try a different direction from here" | "Same prompt, clean slate" |
| **Requires transcript?** | Yes (JSONL must exist) | Yes | No |

Buttons are only visible for terminal states (`succeeded`, `killed`,
`failed`) plus `idle` / `needs_input` for [headless](#headless-mode-no-tmux)
sessions (which rest without a process between turns). Reopen and Fork are
additionally hidden when `hasTranscript === false` (session died before
writing any JSONL). Cross-mode is supported from the dialog's **Use tmux**
checkbox — see
[Reopen, Fork and Respawn across modes](#reopen-fork-and-respawn-across-modes).

**Model + effort override.** Clicking any of the three opens a dialog
with model + effort pickers (harness-aware — Claude gets the curated
list, Codex/OpenCode a free-text input). Fork also gets an optional
new-prompt textarea. Leaving the pickers on "— Default / keep"
preserves the session's own model/effort (precedence: override > session's
own > project default).

Both Reopen and Fork auto-backfill `model`/`effort` from project defaults
if the original record lacks them (pre-2026-09-04 sessions).

### Context usage indicator

In the session detail transcript header, next to the polling status,
Claude sessions show `ctx  38K / 200K [bar] ⤴N` — the last turn's
effective context (input + cache_read + cache_creation) against the
200K native ceiling. Bar color grades emerald → amber → red as you
approach the limit. The `⤴N` chip appears once Claude has auto-compacted
at least once; tooltip has the full breakdown + timestamp of last
compaction. Not shown for non-Claude harnesses (different transcript
shape).

### Shared memory pool

Orchestron auto-symlinks per-workspace memory storage to a shared pool
so every session across every workspace contributes to (and reads from)
one memory location. Behavior differs per harness:

**Claude** — memory is a directory of markdown files. Symlink
`<CLAUDE_CONFIG_DIR>/projects/<mangled-cwd>/memory/` → default
`~/.claude/shared-memory` (override `ORCHESTRON_SHARED_MEMORY_DIR`,
`""` to disable). MEMORY.md and every entry visible fleet-wide across
orchestron + CLI + other bridges.

**Codex** — memory is a SQLite file (`memories_1.sqlite`) holding
derived cross-thread memory selections. Symlink
`<CODEX_HOME>/memories_1.sqlite` → default
`~/.codex-shared-memory/memories_1.sqlite` (override
`ORCHESTRON_SHARED_CODEX_MEMORY_DIR`, `""` to disable). WAL sidecars
live in the shared dir; concurrent codex processes serialize via
SQLite WAL locks. thread_history / goals / queue stay per-CODEX_HOME
so conversation content remains private per identity.

If orchestron finds a real file/dir already at the expected path, it
renames to `<name>.bak-<timestamp>` before creating the symlink —
nothing is deleted, safe to merge manually.

### Codex adapter

Codex sessions behave the same as claude sessions across the full
orchestron lifecycle — spawn / reopen / fork / respawn / archive,
harness-aware model picker (GPT-6-Astra, GPT-5.6-Sol/Terra/Luna,
GPT-5.5, GPT-5.4-Mini, GPT-5.3-Codex-Spark), effort picker adding
`ultra` (max + auto delegation), MCP auto-inject via inline `-c`
overrides, shared memory pool via SQLite symlink, terminal report to
parent on archive, guardrails on `spawn_session`.

**1-project-1-harness rule** — a project's `agentType` is
authoritative. Register a codex-specific project (via ProjectDialog
UI or `POST /api/projects { agentType: "codex" }`); sessions spawned
under it always use codex CLI. Trying to spawn a codex session in a
claude project (or vice-versa) is rejected with HTTP 409.

**Transcript source** — codex interactive TUI (`--no-alt-screen`)
writes to `~/.codex/thread_history_1.sqlite` (SQLite), not JSONL.
Orchestron's `/transcript` endpoint auto-detects: reads JSONL for
claude, SQLite for codex.

**No harness-level pricing catalog for codex either** — orchestron's
`apps/api/src/domain/pricing-table.ts` carries Claude tier rates
(Sonnet $3/$15, Opus $15/$75, Haiku $0.80/$4 per MTok + cache
read/create) but zero codex entries. Adding them wouldn't be
meaningful: ChatGPT Plus/Pro/Enterprise is flat-rate bundled — no
per-token dollar rate to enumerate. Codex's own
`~/.codex/models_cache.json` also carries no pricing key (grepped).
Treat codex sessions as N/A for cost aggregations, not $0.

Silver lining: `models_cache.json` does carry `context_window` and
`max_context_window` per model — the denominator for a future ctx%
chip is already available; only the numerator (live token count) is
missing.

**Token / context / rate-limit metric — deferred, no viable in-band
path** (revised 2026-09-06 after attempted `/status` scrape):

Persistent surfaces (all empty — nothing to poll passively):
- `thread_history_1.sqlite` — item_json content only.
- `logs_2.sqlite` — trace of `thread/tokenUsage/updated` event
  (name only, payload lives in-memory and is lost).
- `state_5.sqlite` — migrations + rollout state only.
- TUI status bar — persistent `<model> · <cwd>` only.

**Attempted approach: `/status` slash-command scrape** — commits
`0213cca` (refresh button + endpoint), `7200955` (SessionCard chips),
`4f3d434` (auto-refresh on idle). **All reverted** in `d4b95ce` /
`bad673a` / `e3caf7a`. The modal DOES carry real numbers:

```
Context window:  93% left (29.9K used / 258K)
Weekly limit:    [█████████████░░░░░░░] 63% left (resets 09:25 on 7 Sep)
5h limit:        [████████████████████] 100% left (resets 17:06)
```
(⚠️ semantic: `N% left` = REMAINING, not used — 93% left = fresh.)

But injecting `/status` into the tmux pane is fundamentally unsafe:
- **Collides with mid-turn state.** If codex is running or between
  paste-and-send, the slash-command lands in the wrong place — either
  gets appended to the user's prompt as literal text, or interrupts a
  paste sequence mid-flight.
- **Modal is visible to the user.** Anyone `tmux a`-attached sees
  the modal pop up unexpectedly on every idle transition (auto path)
  or refresh click.
- **Reset-on-restart wasn't reliable.** E2E testing found spawns
  stuck `running` after the refresh code was in place — auto-refresh
  and initial-paste race conditions were suspected, never fully
  diagnosed.

**Only viable accurate paths (all still deferred, heavy)**:
1. Rewrite adapter to drive codex in `app-server` mode over stdio
   JSON-RPC → tap live `thread/tokenUsage/updated` event. Loses tmux
   TUI paradigm; user can no longer manually `tmux a`.
2. Side-adapter driving `codex mcp` mode — opt-in per project. Same
   rewrite cost, branches codebase.
3. Upstream fix: file an issue at github.com/openai/codex asking to
   persist `thread/tokenUsage/updated` payload into
   `thread_history_1.sqlite` (or expose `--metrics-log <file>`
   flag). If accepted, the existing SQLite parser gets one extra
   query — zero adapter rewrite. Recommended first move.

Until one of those lands, orchestron shows **no** context/quota data
for codex sessions. Codex is flat-rate bundled so $ cost = N/A
anyway; the missing metric is really just "% context used" and
weekly/5h quota — visible in the TUI itself if the user types
`/status` manually.

See `memory/reference_orchestron_codex_adapter.md` for the full
attempt-and-abandon analysis.

**Session id** — codex assigns UUID v7 (timestamp-prefixed) itself;
adapter captures via `captureNewSessionId()` polling the SQLite for
newest thread after `sendPrompt`.

**Reopen / Fork buttons** — visible for terminal codex sessions
with a captured thread id (SQLite has the conversation). The
`hasTranscript` list-hydration hint is harness-aware: claude uses
`existsSync(jsonlPath)`; codex uses `claudeSessionUuid !== ''`
because interactive TUI writes to SQLite, not JSONL, so jsonlPath
stays empty. Fixed in `2afa647`.

**Reconcile on-demand only** — codex `running → idle/needs_input`
transition fires from the `/transcript` endpoint's safety-net, not
from a background watcher. Claude has `watchForTurnEnd` tailing the
JSONL file (fs.watch), so `running → idle` happens within ms of
turn end; codex writes to SQLite (`thread_history_1.sqlite`) which
isn't tail-friendly, and there's no equivalent watcher yet.

Practical impact: if you spawn a codex session via curl / API but
never open its page in the UI, the session sits at `running`
indefinitely after codex finishes — reconcile only fires when
someone polls `/transcript`. Opening the session page in the UI
starts the ~2s polling loop → session transitions within seconds.
Not a bug per se, just an on-demand model. To force reconcile
without opening the page, `GET /api/sessions/:uuid/transcript`
once — same effect. Idle chip in the header shows `idle Nm` so you
can gauge time until auto-sleep (15 min default).

**sendPrompt Enter-swallow race** — fixed in `562f403`. On fresh
spawn / cold-start wake, codex TUI can print the input placeholder
before its input handler is wired. Our paste-buffer echoes into the
input row (tmux echoes bytes directly), but the first Enter can hit
the welcome/loading state and be discarded — prompt then sits in
the input row forever, session marked `running` but codex never
runs the turn. Detection: after Enter, capture pane, check the last
`›` input row for the prompt marker. If still there, retry Enter
(max 3, 800ms interval). Affects all sendPrompt callers: fresh
spawn, wake-from-sleeping, fork with prompt.

Prerequisites:
- `npm install -g @openai/codex` (or brew)
- `codex login --device-auth` (browser device code, one-time)
- Set `config.adapters.codex = true` in `~/.orchestron/config.json`
- Register a codex-only project (path + `agentType: "codex"`)

---

## 4. Schedules

Dashboard → **Schedules** page.

- Cron expressions are full 5-field (`min hour day month dow`), and the
  API enforces exactly that on create, edit and import — `cron-parser`
  would otherwise *pad* a short expression, turning `* * * *` into an
  every-minute schedule nobody asked for. Six fields (seconds), seven
  (year) and the `@daily` family are rejected for the same reason: the
  dialog can render none of them. Preset buttons cover the common ones
  (hourly, daily 9am, weekly Mon 9am, …).
- Live-preview shows the **next 3 fires** while you type, using
  `cron-parser`. The human-readable description under the input comes
  from `cronstrue`.
- Every entry has: pause/resume, run-once, edit, delete.
- **Run now** (the circled play) fires the schedule once and then opens the
  session it spawned — the click leaves you on that session's detail page,
  not on the list. It does not touch the enabled state, and the next cron
  fire is unaffected. If the fire fails, a warning toast says why and you
  stay on the list with the schedule untouched.
- **Export** → YAML dump you can commit to a repo, share, or back up.
- **Import** → paste/upload YAML. Query param `?mode=merge|replace`
  controls whether existing entries are kept or wiped first.
- Each schedule fires by calling the local `POST /api/sessions` with
  the same Bearer token, so guardrails and project checks apply
  identically to interactive spawns.

### 4.1 Model, effort and run mode

A schedule can pin **Model**, **Effort** and **Use tmux** for the sessions
it spawns, or leave any of them to its project.

They are *overrides*, not a snapshot:

| Field on the schedule | What fires |
|---|---|
| Left at **Default** | whatever the project is set to **at the moment the schedule fires** — change the project's default model and every schedule that did not pin one follows |
| Pinned | that value, permanently. Nothing tracks the project back afterwards; change it on the schedule itself |

The dropdowns name what "Default" currently resolves to (`Default —
claude-opus-5 (project)`), so the choice is between two concrete values
rather than between a value and a blank. Model and effort catalogs are
per-harness, taken from the project's `agentType`.

The list page badges only the fields a schedule pins. A schedule that
follows its project for everything shows no badges at all.

**Project is fixed once a schedule exists.** Moving one to another project
would change what every other field on it means — the catalogs are
per-harness and the defaults it falls back to belong to the old project —
so that is a delete and recreate rather than an edit.

**With the global headless kill switch off** (`enableHeadlessMode: false`),
the **Use tmux** checkbox is hidden and the mode is left out of what the
dialog saves: a schedule already configured headless keeps that stored
preference and gets it back when the switch is flipped on. Until then it
fires in tmux — an explicit `useTmux: false` sent by a script or an older
client is coerced on the way in, and the fire-time `POST /api/sessions` is
a second pass over the same rule.

### 4.2 YAML shape

Export writes the three fields only for schedules that pin them, so a
document round-trips unchanged and one written before these fields existed
imports fine — every schedule in it simply follows its project.

```yaml
schedules:
  - id: 3f2b1a4c-…
    cron: 0 9 * * 1
    projectId: 8c1d…
    prompt: Weekly dependency review
    enabled: true
    createdAt: 2026-09-10T02:00:00.000Z
    # all three optional — omit to follow the project
    model: claude-opus-5
    effort: high
    useTmux: false
```

`POST /api/schedules/:id/run` answers `{ ok: true, sessionUuid: '<uuid>' }`
— that id is what the Run now button navigates to. `sessionUuid` is present
only when the fire produced one; a bare `{ ok: true }` still means the
schedule ran, and a client that gets it should stay where it is rather than
treat the run as failed.

`effort` must be one of `low | medium | high | xhigh | max | ultra`; an
entry with anything else is reported in the import summary's `errors` and
skipped rather than stored. Entries whose `useTmux: false` was forced to
tmux by the kill switch are counted in the summary's `coerced`.

Over the API, `PATCH /api/schedules/:id` takes `''` (or `null` for
`useTmux`) to *clear* an override — an absent key means "leave whatever is
stored alone", so there has to be a separate spelling for taking one back
off.

---

## 5. Cross-session coordination

Three primitives, all layered so an agent can pick the right tool:

### 5.1 Passive terminal report (Option 1 in the design)

When you **archive** a session that has a `parentSessionId`, the server
auto-generates a summary and queues it into the parent's `/input`:

```
[Child session abcd1234 archived — status: succeeded]
Original prompt: <first 200 chars>
Final response: <last assistant text, first 800 chars>
```

Fire-and-forget. Skipped if the parent is itself in a terminal state
(`succeeded`/`failed`/`killed`).

### 5.2 Shared notes (Option 3)

Key-value store any session or the UI can hit.

```bash
# Set a note
curl -X PUT https://my.tailcf97bc.ts.net/api/notes/build.status \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  -d '{"value": {"stage": "compile", "eta": "2m"}, "tags": ["ci"]}'

# Read
curl https://my.tailcf97bc.ts.net/api/notes/build.status \
  -H "Authorization: Bearer $TOKEN"

# List (optional prefix filter)
curl "https://my.tailcf97bc.ts.net/api/notes?prefix=build." \
  -H "Authorization: Bearer $TOKEN"

# Delete
curl -X DELETE https://my.tailcf97bc.ts.net/api/notes/build.status \
  -H "Authorization: Bearer $TOKEN"
```

Notes live at `~/.orchestron/notes/<key>.json` with `0600` perms. Keys
are `[\w\-.:]{1,200}` — use `:` for namespacing (`agent:foo`,
`project:bar`).

### 5.3 Orchestron MCP server (Option 2 — with guardrails)

Every spawn auto-loads an MCP server exposing 10 tools. **No manual
`.mcp.json` setup required.** Session-manager writes a per-session config
at `~/.orchestron/mcp-configs/<sid>.json` with `ORCHESTRON_SESSION_ID`
pre-baked, then passes `--mcp-config <path>` to `claude`.

**Tools:**

| Tool | Purpose |
|---|---|
| `spawn_session` | Spawn a child session (project, agent, model, effort, run mode per-call — all independent from caller) |
| `send_input` | Queue a user turn into any session by uuid |
| `get_status` | Read a session's current metadata |
| `read_transcript` | Read entries with offset+limit |
| `wait_for_idle` | Poll (3s interval) until session reaches idle / needs_input / terminal, up to timeoutSec |
| `list_projects` | Discover which projects to target |
| `list_sessions` | Discover peer sessions (filter by projectId/status) |
| `note_get` | Read a shared note |
| `note_set` | Set/upsert a shared note (`updatedBy` auto-filled with your session id) |
| `note_list` | List notes, optional prefix filter |

**Run mode on `spawn_session`.** The optional `useTmux` boolean picks
whether the child runs in tmux or headless, so a parent agent can fan out
into headless one-shot children instead of a rack of tmux windows.

Omitted, the parent's own mode is inherited — but only when the child
stays in the parent's project. A child spawned into a *different* project
gets that project's `defaultUseTmux` instead: a tool call that never
mentioned run mode should not override an operator's per-project setting,
and "same project, same kind of work, same mode" is the only reading where
inheritance is unambiguously what the caller meant. Reading the parent is
best-effort — an unreadable parent record falls back to the project
default rather than failing the spawn.

With `enableHeadlessMode` off the API coerces the child to tmux as it does
for every other caller, and the tool result carries the `coerced` payload
through so the parent is told rather than left to infer it. The result
always reports the effective `useTmux` alongside `sessionId` and `status`.

**Guardrails on `spawn_session`** (enforced at `SessionManager.spawn`
whenever `parentSessionId` is set — so REST and MCP callers get the same
protection):

- **Max depth 5** — parent → child → grandchild → … chain length
- **Max 10 children per parent**
- **Rate limit 5 spawns / minute per parent**

Exceeding any raises an error. Chain depth walks `parentSessionId`
pointers back through storage. Spawn calls from the same parent are
serialized in-process (per-parent mutex) so parallel `spawn_session`
calls can't TOCTOU-race the guardrail check.

**Auto-allowlist for the 10 orchestron MCP tools.** Orchestron passes
`--allowedTools mcp__orchestron__…` to every claude spawn, so agents
under a managed policy that overrides `--permission-mode
bypassPermissions` (e.g. Nanovest Team plan's
`disableBypassPermissionsMode: "disable"`) don't freeze on a
per-invocation approval modal for `spawn_session` / `note_set` /
`send_input`. The allowlist is bounded to first-party orchestron tools
only — user-defined MCP servers you add later stay gated normally.
The MCP-shape approval modal is also parsed by `sweepAskUserPrompts`
now, so if some allowlist path is bypassed the modal still surfaces
as a `PendingPromptBanner`.

**Trust boundary — orchestron is single-tenant.** MCP tools that take
an arbitrary `sessionId` argument (`read_transcript`, `get_status`,
`send_input`, `list_sessions`) resolve the target globally, not scoped
to the caller's delegation subtree or project. Any spawned agent can
read the transcript of, or inject input into, any other live session on
the host — including sessions from unrelated projects. This is
intentional given the local-only trust model (all sessions run as the
same OS user, with the same filesystem access), but be aware that a
compromised or misbehaving child agent can observe peer work across
project boundaries. Do not run untrusted prompts on a host that also
runs sensitive sessions.

**Prompt-injection exposure via MCP tool args.** Arguments to
`spawn_session`, `send_input`, and `note_set` are executed by the model
as instructions the moment the LLM decides to call them. If a
downstream document, URL, or file the agent reads instructs it to
"call spawn_session with projectId X" or "write note Y with content Z",
the agent may comply — orchestron cannot distinguish operator-authored
prompts from injected content in the middle of a transcript. The
per-parent spawn guardrails (max 10 children, 5 spawns/min, depth 5)
cap blast radius, and the global rate limit (600 req/min per bearer)
caps flood attempts, but they do not prevent a single malicious note
write or a targeted `send_input` into a sibling session. Treat every
tool argument as untrusted data; if you feed the agent third-party
content, expect the notes store to be reachable as a lateral staging
channel.

---

## 6. Dashboard tour

Top row: stats grid (needs input, running, succeeded, failed counts).

Header actions:
- **Rows icon** — flat list (default)
- **FolderTree icon** — group sessions by project
- **Spawn button** (split) — main tap opens spawn dialog; caret opens
  a menu with **Adopt** (attach a session by UUID) and **Import bundle**
  (upload a `.jsonl` / `.tar.gz` exported from another host)

Grouping is persisted in `localStorage` (`orchestron.dashboard.groupBy`).

In grouped mode each project header is **collapsible**:
- Click chevron to collapse/expand.
- Collapsed state persists per project in
  `orchestron.dashboard.collapsedProjects`.
- Header keeps showing counts + amber chip for `needs_input` sessions
  + emerald chip for active sessions, so a collapsed group still
  surfaces urgency.

**Session ordering** (both flat and within groups): last activity
descending — `lastActivityAt ?? endedAt ?? startedAt`, the latter two
being the fallback for pre-2026-09-06 records that predate the field —
in the spirit of Tycho's `finished_at || started_at || created_at`.
Needs-input does NOT float to top; it rises naturally because status
transitions update `lastActivityAt`.

**Filter bar:** status multi-select, project dropdown (shows names, not
uuids), tag multi-select, date range, fuzzy search on prompt or session
id.

**Delegation chips** (dashboard cards + session-detail header):
- Parent cards get `⑃ N` — count of direct children spawned via
  `spawn_session`. Deeper subtrees are visible in the Graph page.
- Child cards get `⑃ parent: <8-char>` — the 8-char slice matches the
  parent's id chip elsewhere in the list, so cross-reference by eye
  works. Hover title shows the parent's prompt preview.
- Sessions without a parent/children stay uncluttered.

**Delegation Graph** (menu Graph) — React Flow + Dagre tree of a
session and its descendants. Follows the active app theme: on
`Orchestron` / `Tycho` dark, chrome (Controls, MiniMap, background
dots) renders dark to match the app ground; on `Light`, chrome and
dots flip to a light palette. Node fill color per status matches the
StatusPill palette used on the dashboard.

---

## 7. Themes & appearance

Settings → Appearance section. Three themes:

- **Orchestron** — default zinc dark
- **Tycho** — warm-orange dark inspired by Tycho's TUI palette
- **Light** — plain light

Applied via `data-theme` attribute on `<html>`, persisted in
`localStorage`. All CSS uses custom properties, no runtime style
injection.

---

## 8. Pairing & mobile

The dashboard is a PWA — installable on iOS Safari (Share → Add to Home
Screen) and Android Chrome.

**First pair from a new device:**

1. On the host machine, visit `/pair` in a browser that's already
   authenticated (or with the Bearer token in query string).
2. Scan the QR with the phone's camera.
3. Token is saved to `localStorage` (survives tabs + reloads).

**Reset a device** (if PWA cache is misbehaving): visit `/api/reset` —
it unregisters SW, clears caches + storage + IndexedDB, redirects to
`/pair` after 3 s. Served by the API (not Next), so it works even when
the web bundle is broken.

---

## 9. Data on disk

Everything lives under `~/.orchestron/` (configurable via
`config.json`).

```
~/.orchestron/
├── config.json                  # bindHost, port, remoteToken, adapters
├── projects/<uuid>.json         # one file per project
├── sessions/<uuid>.json         # one file per session
├── schedules/                   # cron entries
├── notes/<key>.json             # shared kv store (0600)
├── mcp-configs/<sid>.json       # auto-generated per-session mcp config
└── snapshots/                   # (worktree snapshots — future feature)
```

File I/O uses atomic write (tmp → fsync → rename) with `.bak` recovery.
Directory perms are `0700`, file perms `0600`.

Claude transcripts live in Claude CLI's own directory:
`<CLAUDE_CONFIG_DIR>/projects/<mangled-cwd>/<uuid>.jsonl`. Orchestron
reads these directly for the transcript view.

---

## 10. Terminal interfaces (CLI + TUI)

Two ways to drive orchestron without opening the browser.

### CLI — `orchestron`

Commander-based CLI in `apps/cli`. Link once, then run from anywhere.

```bash
cd apps/cli && npm link         # exposes `orchestron` globally
orchestron --help
```

Command groups:

| Command | Purpose |
|---|---|
| `orchestron serve` | Boot the API + web bundle (dev alt to systemd) |
| `orchestron tui` | Launch the Ink-based TUI |
| `orchestron token` | Generate / rotate the Bearer token in config.json |
| `orchestron project` | Projects — `list`, `get`, `add`, `edit`, `rm` |
| `orchestron session` | Sessions — spawn, drive, revive, adopt, import/export |
| `orchestron schedule` | Cron entries — full CRUD, pause/resume, YAML round trip |
| `orchestron metrics` | Token and cost query, five group-by axes |
| `orchestron qr` | Print pairing QR to terminal (for phone scan) |
| `orchestron doctor` | Health check — tmux, claude, config, adapters |

The session, project, schedule and metrics groups cover the same
mutations the dashboard does, which is what lets the TUI and a
scripted workflow driver run without a browser.

#### 10.1 Conventions every command shares

**Where it connects.** `--url`, then `$ORCHESTRON_URL`, then
`bindHost` + `port` from the config file, then
`http://127.0.0.1:8080`. `--host` is a deprecated alias for `--url`,
kept because `schedule` shipped with it.

**How it authenticates.** `--token`, then `$ORCHESTRON_TOKEN`, then
`remoteToken` from the config file, then the legacy `token` key (read
only — `token rotate` writes `remoteToken`).

The config file is the one the API itself reads:
`$ORCHESTRON_CONFIG`, else `$ORCHESTRON_DATA_DIR/config.json`, else
`~/.orchestron/config.json`. So on the host that runs the server, a
bare `orchestron session list` already points at the right instance
with the right bearer — and inside a second instance's env (the E2E
environment, say) it points at *that* one.

**Output.** Human by default: one line per action, or a table for the
list commands. `--json` prints a single envelope instead:

```jsonc
{ "ok": true,  "id": "…", "sessionUuid": "…", "status": "idle", … }
{ "ok": false, "error": "Cannot reopen from status running", "status": 409 }
```

The envelope always goes to **stdout**, success or failure, so a caller
can `| jq` without branching. In human mode the error goes to stderr
instead. Exit code is `0` on success and `1` on any failure; callers
that need to tell failures apart read `status` out of the envelope.

**Long prompts.** Anything that takes `--prompt` reads stdin instead
when the flag is absent and stdin is not a terminal:

```bash
orchestron session send "$ID" <<'EOF'
A prompt with blank lines,

quotes and $shell metacharacters, arriving intact.
EOF
```

An interactive shell with no `--prompt` errors immediately rather than
hanging on a terminal nobody is typing into.

**Run mode.** `--headless` and `--tmux` are the two halves of one
tri-state, and passing neither is a third, meaningful value: on
`reopen`, `fork`, `respawn` and `metadata` it means *keep the mode this
session already has*. Passing both is refused rather than resolved.

#### 10.2 Sessions

```bash
# Create
orchestron session spawn --project "$PID" --prompt "…" \
  --model claude-haiku-4-5 --effort low --headless
orchestron session spawn --project "$PID" --template daily-report --var env=stg
orchestron session spawn --project "$PID" --prompt "…" \
  --attachment ./design.png --attachment ./notes.md

# Drive
orchestron session send "$ID" --prompt "next turn"
orchestron session answer "$ID" --choice 2            # tmux selector modal
orchestron session answer "$ID" --field env=staging --field ref=main
orchestron session interrupt "$ID"

# Revive
orchestron session reopen "$ID"                       # keeps its mode
orchestron session fork "$ID" --prompt "try another way"
orchestron session respawn "$ID" --tmux

# Edit + close
orchestron session metadata "$ID" --model claude-opus-5 --effort high
orchestron session archive "$ID"                      # the "mark success" action
orchestron session kill "$ID"
orchestron session rm "$ID"                           # delete the record

# Move between hosts
orchestron session export "$ID" --out bundle.jsonl
orchestron session import bundle.jsonl --project "$PID"
orchestron session adopt "$HARNESS_UUID" --project "$PID" --dry-run

# Read
orchestron session list --project "$PID" --status idle
orchestron session get "$ID" --json
orchestron session logs "$ID"
```

`session answer` is the one command that does real work of its own.
A session can be waiting in two unrelated ways — a **selector modal**
scraped off a live tmux pane, answered by option index, or a
**structured inquiry** returned by a headless turn, answered by text
that starts the next `-p --resume` turn. The command reads the record
and picks; the caller does not have to know which. `--choice` takes
either a number as displayed or text matching an option (exact first,
then unique substring); an ambiguous match is refused with the numbered
list rather than resolved to the first hit.

`session export --format` is an **assertion**, not a request parameter.
The bundle format follows the session's harness and transcript — raw
`.jsonl` for claude and for codex with a rollout on disk, `.tar.gz` for
a codex TUI-only session — so `--format` only fails the command when
what arrived is not what the next step was written for.

`session archive` **is** the "mark success" action. It posts to
`POST /api/sessions/:uuid/archive`, which transitions the record through
`completing` to `succeeded` — the same terminal state the dashboard's
"Mark success" button produces. The route accepts no body: there is no
`success` flag and no second endpoint, so there is no `mark-success`
verb either. It shipped briefly as an alias and was removed, because a
second name implied a distinction the API cannot make.

There is **no** session-level `--group`. `SessionMetadata` has no such
field and `SpawnSessionBodySchema` does not accept one, so a
`--group` on `session spawn` would have been stripped on the wire and
done nothing. Groups live on projects (`project add --group`,
`project edit --group`, `project list --group`); the dashboard's
"group by project" control is a client-side view over `projectId`.

##### Effort is not one enum

`--effort` is validated **before** the request goes out, against the
enum the target route actually accepts. There is no single list:

| Command | Accepts |
|---|---|
| `session spawn` | `low` `medium` `high` `xhigh` `max` `ultra` |
| `session reopen` / `respawn` / `fork` | …no `ultra` |
| `session adopt` | …no `xhigh`, no `max` |
| `session metadata` | …no `ultra` (plus `""` to clear) |
| `schedule create` / `edit` | all six (plus `--clear-effort`) |
| `project add` / `edit` (`--default-effort`) | all six |

A level the route does not take is refused locally with the accepted
list, and **no request is sent** — previously it came back as a
flattened zod dump that read like a typo rather than a per-route
difference. The lists are transcriptions of the API's zod enums and are
asserted against the live routes in `apps/cli/tests/live-api.test.ts`;
reconciling the enums server-side would let this table collapse.

#### 10.3 Schedules

```bash
orchestron schedule create --cron "0 9 * * 1" --project "$PID" \
  --prompt "weekly report" --model claude-haiku-4-5 --headless
orchestron schedule edit "$SID" --cron "0 8 * * 1"
orchestron schedule pause "$SID"
orchestron schedule resume "$SID"
orchestron schedule run "$SID"                  # fire once, now
orchestron schedule delete "$SID"

orchestron schedule export --out schedules.yml
orchestron schedule import schedules.yml --mode merge   # or: replace
```

The three per-schedule overrides (model, effort, run mode) are
three-valued, exactly as they are in the dialog — see
[§ 4.1](#41-model-effort-and-run-mode). Setting one is
`--model` / `--effort` / `--headless|--tmux`; leaving one alone is
omitting the flag; **taking one back off** needs an explicit clear,
because an omitted key merges:

```bash
orchestron schedule edit "$SID" --clear-model --clear-effort --follow-project-mode
```

`schedule export` with no `--out` writes the YAML to stdout;
`--json` then errors, because a YAML document nested inside a JSON
string is not something a caller can use. `--mode replace` deletes
every existing schedule before importing — export a backup first.

**Pin a cheap model on any schedule you will `run` during testing.**
An unpinned entry resolves against its project at fire time, and a
single unattended Opus spawn has cost more than a whole sweep.

#### 10.4 Metrics

```bash
orchestron metrics --group-by day
orchestron metrics --group-by model --from 2026-09-01 --to 2026-09-11
orchestron metrics --group-by session --project "$PID" --json
```

`--group-by` is one of `day`, `project`, `session`, `adapter`, `model`.
`--from` / `--to` accept `YYYY-MM-DD` or a full ISO timestamp, which is
truncated to the date — so a bound copied straight out of
`session list --json` works. The human table appends a **TOTAL** row.

These numbers are priced from the transcript by orchestron's own rate
table and will not match a session record's `costUsd`, which is what
the harness reported. Neither is wrong; they measure different things.
See [§ 3](#3-sessions--the-core-loop).

#### 10.5 Projects

```bash
orchestron project add --name web --path ~/Works/web --agent claude \
  --group frontend --default-model claude-haiku-4-5 --default-headless
orchestron project edit "$PID" --clear-default-model --group ""
orchestron project rm "$PID"
```

`--clear-default-model` / `--clear-default-effort` send `null`, which
is the API's "unset this field". An omitted key merges instead, which
is why clearing needs its own flag — without one, a project pinned to
an expensive model could never be un-pinned. `--group ""` clears the
group.

### TUI — Ink-based dashboard

React-Ink terminal UI. Two screens (Dashboard + Session detail). Same
data as the web dashboard — reads the same API.

```bash
orchestron tui                            # picks up ~/.orchestron/config.json
# or manually
orchestron tui --url http://127.0.0.1:8090 --token "$TOKEN"
```

Useful when SSH'd into the server and you don't want to tunnel a browser
back. Doesn't replace the web UI (no transcript renderer yet); a quick
scan-and-kill or spawn-and-detach workflow.

---

## 11. Keyboard & touch shortcuts

Currently limited (mobile-first UX). Notable:

- **Enter** in the input composer sends the prompt.
- **Shift+Enter** inserts a newline.
- **Paste image** anywhere in the input composer attaches it as a file.
- Session detail is a normal link — swipe-back on iOS works.

More shortcuts are planned; when in doubt, buttons always work.

---

## Appendix — MCP quick recipe for agents

Inside a session started by orchestron, you can call:

```
# From the child agent, tell parent about a discovery
note_set({
  key: "peer:parentid:decision",
  value: { verdict: "reject", reason: "flaky test in module X" }
})

# Spawn a child on a different project with a cheaper model
spawn_session({
  projectId: "<uuid from list_projects>",
  agentType: "claude",
  model: "claude-haiku-4-5-20251001",
  effort: "low",
  initialPrompt: "Cross-check the fix in ~/Works/foo/src/bar.ts against the tests in test/bar_test.ts"
})

# Wait for a sibling to finish then read its verdict
wait_for_idle({ sessionId: "abcd…", timeoutSec: 900 })
read_transcript({ sessionId: "abcd…", offset: -3 })
```

All tools call back to `POST /api/…` under the hood; the Bearer token
is pre-baked in the MCP config so the child agent doesn't see it in its
own conversation context.
