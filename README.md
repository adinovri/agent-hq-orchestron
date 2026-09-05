# agent-hq-orchestron

A web-based supervisor for coding agents (Claude, Codex, OpenCode). Runs
locally, drives interactive `claude` under tmux — uses your subscription
quota, not API credit.

Inspired by [Tycho](https://github.com/firewalker06/tycho); this project
reimplements the core ideas (agent orchestration, delegation lineage,
file-based storage) as a TypeScript + Node.js + Next.js web app.

## What it does

- **Spawn & supervise** long-running Claude sessions from any device on
  your tailnet, each running in its own tmux window on the host.
- **Multi-project + multi-harness** — one dashboard, sessions scoped per
  project, mix Claude / Codex / OpenCode harnesses (whichever adapters
  are installed).
- **Full session lifecycle** — reopen a completed session, clone/fork one
  to explore a divergent path, interrupt a running turn, queue prompts
  while the model is thinking.
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
- **Subprocess model:** tmux + interactive `claude` CLI. Never
  `claude -p` / `--print` (those bill against API credit)
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
