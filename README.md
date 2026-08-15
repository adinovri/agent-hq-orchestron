# agent-hq-orchestron

Web-based supervisor for coding agents (Claude, Codex, OpenCode).
Runs locally, uses subscription-quota CLI (not API credit).

## Status

Phase 0: monorepo scaffold complete. Phase 1 (CLI bridge implementation) not yet started.

## Stack

- Frontend: Next.js 15 (App Router) + shadcn/ui + Tailwind + React Flow + Zustand
- Backend: Fastify 5 + TypeScript
- Storage: File-based JSON + JSONL (atomic write, .bak recovery) — Tycho pattern
- Real-time: SSE (server-push events) + WebSocket (client control)
- CLI subprocess: tmux + interactive `claude` (NOT `claude -p` — uses API credit)

## Quick Start

```bash
git clone <repo> && cd agent-hq-orchestron
bash scripts/init.sh   # create ~/.config/agent-hq-orchestron/
npm install
npm run dev            # FE :3000, BE :8080
```

## Documentation

- [High-Level Design](docs/HLD.md)
- [Tycho Research Report](docs/REPORT.md)
- [Scaffold Plan](docs/PLAN.md)

## Credits

Inspired by [Tycho](https://github.com/firewalker06/tycho) — MIT-licensed Ruby-based agent supervisor by @firewalker06.
This project reimplements the core idea (agent orchestration, session delegation, file-based storage) in TypeScript with a web UI and Node.js backend.

## License

MIT © 2026 Adi Novriansyah
