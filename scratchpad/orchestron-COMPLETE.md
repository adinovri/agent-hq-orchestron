# Orchestron — Project Complete

**All 30 tasks implemented across 5 batches.**  
**Date**: 2026-09-04  
**Branch**: main (direct-to-main, all commits pushed)

---

## Project Overview

**Orchestron** is a web-based supervisor for coding agents (Claude, Codex, OpenCode).  
It provides a Fastify REST API backend, a Next.js PWA frontend, an Ink TUI, and a Commander CLI — all in a TypeScript monorepo.

---

## Batch Summary

### Batch 1 (TASK-001 → TASK-009): Core Monorepo + Domain Layer
- Monorepo scaffold: npm workspaces, `packages/shared`, `packages/file-store`, `apps/api`
- Shared schemas (Zod): Session, Project, Delegation, Snapshot, Metrics, Hooks, Templates
- Config loader with env-var precedence and boot guard (non-loopback without token → refuse)
- `SessionManager`: 7-state FSM (spawning/waiting/running/completing/completed/failed/killed), pool limit
- `ProjectRegistry`: CRUD with group/tag filtering, atomic `.bak` cleanups
- `DelegationTracker`: edge append, BFS descendants, cascade kill
- Claude adapter: tmux-based (no `-p`/`--print`), `waitTuiReady`, `sendPrompt`, `kill`
- FileStore: `writeJson`/`readJson`/`listDir` with atomic tmp-then-rename

### Batch 2 (TASK-010 → TASK-015): Backend Services + Auth
- `HookRunner`: pre-spawn / post-transcript / on-session-end / on-error hooks, timeout, async dispatch
- `TemplateResolver`: frontmatter parse with Zod validation, variable substitution, git context
- `GitHostAdapter`: `gh` + `bb` PR adapter with host detection and caching
- `MetricsCollector`: session cost recording, groupBy project/adapter/day query
- Fastify routes: `/api/projects`, `/api/sessions`, `/api/delegation`, `/api/metrics`
- Auth middleware: Bearer token + WS `?token=` param + whitelist for `/api/health`

### Batch 3 (TASK-016 → TASK-019): Streaming + Snapshot + Orphan Scanner
- `TranscriptTailer`: JSONL line tailer with SSE push
- SSE + WebSocket streaming routes (`/api/sessions/:id/transcript`)
- `SnapshotService`: git worktree creation, chmod read-only, ledger CRUD, `cleanup()`
- Orphan scanner: boot-time scan of ledger, removes dangling worktrees
- SSE stream route: offset-based resume, heartbeat

### Batch 4 (TASK-020 → TASK-025): Next.js PWA Web UI
- Next.js scaffold: App Router, PWA manifest, Serwist service worker
- Web Dashboard: polling SessionList + FilterBar + SpawnDialog
- Web Session Detail: SSE transcript with markdown render, kill confirm dialog
- Web Delegation DAG: ReactFlow + dagre layout, status colors, click-to-session
- Web Metrics Dashboard: Recharts daily cost chart + per-project bar + summary tiles
- Pair/onboarding page: token store, QR scan, PWA install prompt, global NavBar, QueryProvider

### Batch 5 (TASK-026 → TASK-030): TUI + CLI + E2E (Final)
- `apps/tui`: Ink TUI with keyboard nav, session list, SSE detail pane, command palette
- `apps/cli`: Commander CLI with 8 top-level subcommands (serve/tui/token/project/session/schedule/qr/doctor)
- `orchestron qr`: Tailscale → LAN → loopback host resolution, QR pair URL, security banner
- `orchestron doctor`: binary checks, filesystem checks, table output, `--json` machine output
- E2E test suite: spawn-lifecycle, delegation-cascade, snapshot-cleanup (8 tests, 1.49s)

---

## Cumulative Stats

| Metric             | Count     |
|--------------------|-----------|
| Tasks              | 30        |
| Batches            | 5         |
| Workspaces         | 6 (shared, file-store, api, web, tui, cli) |
| Source files (.ts/.tsx) | ~112  |
| Test files         | ~26       |
| Total commits      | ~28       |

---

## Final File Tree (key paths)

```
agent-hq-orchestron/
├── packages/
│   ├── shared/         # Zod schemas, config, types
│   └── file-store/     # Atomic JSON I/O helpers
├── apps/
│   ├── api/            # Fastify server + domain services
│   │   ├── src/adapters/   # claude, tmux, git-host
│   │   ├── src/domain/     # SessionManager, ProjectRegistry, DelegationTracker, ...
│   │   ├── src/routes/     # projects, sessions, delegation, stream, metrics
│   │   ├── src/plugins/    # auth
│   │   └── src/startup/    # orphan-scanner
│   ├── web/            # Next.js PWA
│   │   ├── app/        # App Router pages
│   │   └── components/ # SessionList, FilterBar, SpawnDialog, DelegationDAG, ...
│   ├── tui/            # Ink TUI
│   │   └── src/screens/    # Dashboard, SessionDetail
│   └── cli/            # Commander CLI
│       └── src/commands/   # serve, tui, token, project, session, schedule, qr, doctor
├── test/
│   ├── e2e/            # spawn-lifecycle, delegation-cascade, snapshot-cleanup
│   └── fixtures/       # mock-claude.sh
└── scratchpad/         # batch summaries
```

---

## Key Architecture Decisions

1. **No `-p`/`--print` in Claude adapter** — interactive tmux mode only (subscription quota constraint)
2. **Boot guard** — refuses non-loopback bind without `ORCHESTRON_REMOTE_TOKEN`
3. **7-state session FSM** — spawning→waiting→running→completing→completed/failed/killed with valid transition table
4. **Pool-based concurrency** — `maxConcurrent` derived from RAM (800MB/process)
5. **Snapshot as read-only worktree** — `git worktree add` + `chmod a-w` except `.claude/`
6. **Orphan scanner at boot** — cleans dangling worktrees from crashed sessions
7. **SSE with offset** — clients resume streams without missing events
8. **E2E via Fastify inject** — no real HTTP server needed, mock adapter = no tmux/claude dependency
