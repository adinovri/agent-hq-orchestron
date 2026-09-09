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
- **Attachments** — drag/drop files (or paperclip button, or paste
  images). Saved to `/tmp/orchestron/uploads/pending/<hex>/` with
  `0600` perms and appended to the prompt as `Attached files:`.

Click **Spawn** and you'll land on the session detail page. Status
progresses: `spawning` → `running` (once TUI is ready + prompt paste
lands) → `needs_input` / `idle` / `succeeded`.

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
  until validation is green.
- **Adopt session** — orchestron spawns a fresh tmux with the harness's
  native resume flag (`claude --resume <uuid>` / `codex resume <uuid>`),
  reads the first user prompt out of the transcript to seed the
  dashboard title, wires the record through the same
  `spawning → waiting → idle` path a Reopen would follow (no
  re-sending the prompt — the resumed conversation already carries
  its history), then redirects to the session detail page.

Adopted records get `metadata.adopted: true` and
`metadata.adoptedFromUuid` so you can distinguish them from natively-
spawned records later if needed.

Not for:

- Reopening a session orchestron already knows about — use the Reopen
  action on the session card instead.
- Read-only "just look at the transcript" — adopt spawns a real tmux
  with a real `--resume`. If you only want to read past output, open
  the JSONL directly.

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
     the imported session picks up an orchestron record, seeds
     `initialPrompt` from the transcript, and spawns a fresh tmux
     via `claude --resume` / `codex resume`.

Response includes `importedFromUuid` (the original) and
`regeneratedUuid: true|false` so the caller can tell whether a
collision fired the rewrite path.

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
`failed` / `sleeping`). It opens a metadata-only dialog with Model +
Effort selects (plus a *Reset to project default* option). The change
is written to the session record via `PATCH /api/sessions/:uuid` and
takes effect on the next spawn — Reopen, Respawn, or wake from sleep.
Active sessions have claude already bound to a specific model, so the
server refuses the patch (409) and the UI hides the button.

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

The API enforces `ALLOWED_TRANSITIONS` in `SessionManager`; illegal
transitions throw `InvalidTransitionError`.

### Sleep / wake-up (idle sweeper)

Sessions in `idle` or `needs_input` for longer than `idleTimeoutMs`
(default **15 min**) automatically warm-shutdown:

- Tmux window is killed → no resources held.
- Session status transitions to `sleeping`.
- Claude session state stays intact in JSONL — nothing is lost.

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
`idle`/`needs_input` session and either warm-shuts-down immediately
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
`failed`). Reopen and Fork are additionally hidden when
`hasTranscript === false` (session died before writing any JSONL) —
Respawn stays visible as the only recovery for that case.

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

- Cron expressions are full 5-field (`min hour day month dow`). Preset
  buttons cover the common ones (hourly, daily 9am, weekly Mon 9am, …).
- Live-preview shows the **next 3 fires** while you type, using
  `cron-parser`. The human-readable description under the input comes
  from `cronstrue`.
- Every entry has: pause/resume, run-once, edit, delete.
- **Export** → YAML dump you can commit to a repo, share, or back up.
- **Import** → paste/upload YAML. Query param `?mode=merge|replace`
  controls whether existing entries are kept or wiped first.
- Each schedule fires by calling the local `POST /api/sessions` with
  the same Bearer token, so guardrails and project checks apply
  identically to interactive spawns.

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
| `spawn_session` | Spawn a child session (project, agent, model, effort per-call — all independent from caller) |
| `send_input` | Queue a user turn into any session by uuid |
| `get_status` | Read a session's current metadata |
| `read_transcript` | Read entries with offset+limit |
| `wait_for_idle` | Poll (3s interval) until session reaches idle / needs_input / terminal, up to timeoutSec |
| `list_projects` | Discover which projects to target |
| `list_sessions` | Discover peer sessions (filter by projectId/status) |
| `note_get` | Read a shared note |
| `note_set` | Set/upsert a shared note (`updatedBy` auto-filled with your session id) |
| `note_list` | List notes, optional prefix filter |

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
descending — `endedAt ?? startedAt` — matches Tycho's `finished_at ||
started_at || created_at`. Needs-input does NOT float to top; it rises
naturally because status transitions update timestamps.

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

Subcommands:

| Command | Purpose |
|---|---|
| `orchestron serve` | Boot the API + web bundle (dev alt to systemd) |
| `orchestron tui` | Launch the Ink-based TUI |
| `orchestron token rotate` | Regenerate Bearer token in config.json |
| `orchestron project` | CRUD projects (`list`, `add`, `remove`) |
| `orchestron session` | Spawn / list / kill sessions |
| `orchestron schedule` | Manage cron entries |
| `orchestron qr` | Print pairing QR to terminal (for phone scan) |
| `orchestron doctor` | Health check — tmux, claude, config, adapters |

Good for scripting: e.g. `orchestron session spawn --project=<uuid> --prompt="…"`
from a git hook or a shell one-liner.

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
