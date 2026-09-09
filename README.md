# agent-hq-orchestron

A web-based supervisor for coding agents (Claude and Codex; OpenCode
adapter on the roadmap). Runs
locally, drives interactive `claude` / `codex` under tmux — uses your
subscription quota (Anthropic Pro/Max, ChatGPT Plus/Pro), not API credit.

Inspired by [Tycho](https://github.com/firewalker06/tycho); this project
reimplements the core ideas (agent orchestration, delegation lineage,
file-based storage) as a TypeScript + Node.js + Next.js web app.

## What it does

- **Spawn & supervise** long-running Claude or Codex sessions from any
  device on your tailnet, each running in its own tmux window on the
  host.
- **Multi-project + multi-harness** — one dashboard, sessions scoped per
  project, mix Claude / Codex harnesses (OpenCode planned; whichever adapters
  are installed).
- **Full session lifecycle** — reopen a terminal session (resume the
  same conversation via `claude --resume` or `codex resume <uuid>`),
  fork one to explore a divergent path, respawn from the same prompt
  with a fresh conversation, interrupt a running turn, queue prompts
  while the model is thinking. Each of those three actions opens a
  dialog with per-call model + effort override.
- **Headless mode (opt-in)** — untick *Use tmux* on a spawn (or set the
  project default) and the session runs without an interactive TUI: each
  turn is its own `claude -p --resume` / `codex exec resume` child process,
  and the session rests in `idle` between them. Still multi-turn, still
  interruptible, still forkable — what you give up is the live TUI to
  attach to and sleep-on-idle. An agent with no pane asks questions through
  a structured `inquiry` field that the session page renders as a form.
  Reopen, Fork and Respawn each carry a *Use tmux* checkbox, so a session
  can cross between modes in either direction without losing context.
  `"enableHeadlessMode": false` in `~/.orchestron/config.json` is the
  fleet-wide off switch — it hides the toggle and coerces headless
  requests to tmux rather than failing them. See
  [Headless mode](docs/USAGE.md#headless-mode-no-tmux).
- **Sleep on idle** — sessions unused for 15 min go to `sleeping`
  (tmux released, no resources held). Sending input auto-wakes them
  via the harness's native resume flag in ~3 s.
- **Shared memory pool** — Claude sessions across every workspace
  symlink `<configDir>/projects/<cwd>/memory/` → `~/.claude/shared-memory/`,
  so MEMORY.md and entries are visible fleet-wide. Codex sessions get
  the equivalent for their curated cross-thread memory: every session
  symlinks `<CODEX_HOME>/memories_1.sqlite` → `~/.codex-shared-memory/memories_1.sqlite`
  (only the memories DB is pooled — `thread_history` / `goals` / `queue`
  stay per-CODEX_HOME so conversation state remains isolated per identity).
- **Context indicator** — the transcript header shows live
  `ctx N / limit [bar] ⤴compactions` so you know how heavy a session
  is running. Claude uses a fixed 200K ceiling client-side; Codex
  reports the model's native context window per turn.
- **AskUserQuestion inline** — when Claude asks a structured question,
  the transcript renders it as a card with the options as clickable
  pills (plus an `✎ Other` free-text). Pick, hit send, answer goes
  back to the session — no need to attach to the tmux pane to reply.
- **Pending-prompt banner** — a 20 s background sweep watches every
  live claude AND codex tmux pane for the universal TUI selector
  modal (permission approval, AskUserQuestion buffered by claude,
  codex trust prompt). When detected the session transitions to
  `needs_input` and the session detail page renders a clickable
  banner — pick an option, orchestron sends the corresponding
  arrow-nav + Enter into the pane to answer the modal.
- **Adopt existing sessions** — import a claude / codex session started
  outside orchestron (via `claude --resume`, a background job, another
  supervisor) into a new orchestron record. Pre-check refuses adoption
  when a live process on the host is already holding the UUID, so two
  writers can't race the same transcript.
- **Delete record** — trash icon on terminal-state sessions removes the
  orchestron record without touching the harness transcript, so a
  session can always be re-adopted later.
- **Export / import session bundles** — download the harness transcript
  as a single `.jsonl` (claude / codex rollout) or `.tar.gz` (codex TUI
  SQLite dump), upload it into another orchestron host to restore the
  session in-place. UUID collisions at the destination are auto-resolved
  by regenerating and rewriting the transcript.
- **Cron-scheduled spawns** — YAML-importable schedules with live-preview
  of the next fires.
- **Agent-to-agent coordination** — auto-injected MCP server so a running
  agent can spawn children, poll their state, message peers, and share
  key-value notes (with depth/rate guardrails).
- **PWA UI** — installable on iOS/Android, dark themes (Orchestron
  default, Tycho warm-orange, light), polling-based transcript view.

## Stack

- **Frontend:** Next.js 16 (App Router) + Tailwind + React Query + Serwist SW
- **Backend:** Fastify 5 + TypeScript, plain HTTP + REST polling
- **Storage:** File-based JSON + JSONL (atomic writes with `.bak`
  recovery — Tycho pattern) under `~/.orchestron/`
- **Subprocess model:** tmux + interactive `claude` / `codex` CLI.
  Never `claude -p` / `--print` or `codex exec` (those bill against
  API credit — orchestron uses your subscription quota instead)
- **Auth:** Bearer token, QR-code pairing at `/pair`, HTTPS via Tailscale
  Serve

## Quick start

```bash
git clone git@github.com:adinovri/agent-hq-orchestron.git
cd agent-hq-orchestron
npm install
NEXT_PUBLIC_API_URL=http://127.0.0.1:8090 npm run build
node apps/api/dist/server.js       # or: systemd-run --user … (see DEPLOY.md)
npx --prefix apps/web next start   # separate terminal
```

Point your browser at `http://127.0.0.1:3010`, scan the QR at `/pair`
from your phone (once Tailscale Serve is up), and you're in.

## Documentation

- **[User manual](docs/USAGE.md)** — day-to-day workflows, dashboard
  tour, MCP tools, shared notes, keyboard shortcuts.
- **[Deployment guide](docs/DEPLOY.md)** — systemd units, Tailscale
  Serve, PWA setup, upgrade path.
- **[High-level design](docs/HLD.md)** — architecture, module
  boundaries, storage schema.
- **[Tycho research report](docs/REPORT.md)** — original comparative
  study that seeded the project.

## Credits

Built on top of the design ideas from
[Tycho](https://github.com/firewalker06/tycho) (MIT, @firewalker06).

## License

MIT © 2026 Adi Novriansyah
