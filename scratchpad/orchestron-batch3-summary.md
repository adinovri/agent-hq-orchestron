# Orchestron Batch 3 Summary

Date: 2026-09-04
Branch: main (direct)
Commits: 5 (one per task)
Tests after batch: 154 pass, 0 fail (was 117 post-batch2, +37 new tests)

## Tasks Completed

### TASK-012 — GitHostAdapter (gh + bb)
- `apps/api/src/adapters/git-host/gh.ts` — GitHub adapter via `gh` CLI, 5-min cache to `~/.orchestron/cache/gh/`
- `apps/api/src/adapters/git-host/bb.ts` — Bitbucket adapter, prefers `bb-cli`, falls back to curl + BITBUCKET_APP_PASSWORD
- `apps/api/src/adapters/git-host/registry.ts` — router, resolves adapter from `git remote get-url origin`
- Whitelist blocks `merge`, `close`, `delete` subcommands (read-only enforcement)
- Missing binary → returns null adapter, no throw
- Tests: 17 pass (detection routing 4 URL patterns, cache hit skips exec, whitelist, null adapter)

### TASK-013 — MetricsCollector + PricingTable
- `apps/api/src/domain/pricing-table.ts` — pricing for claude-sonnet-4-6, opus-5, haiku-4-5 + aliases + prefix match
- `apps/api/src/domain/metrics-collector.ts` — records sessions to `metrics/sessions.jsonl`, queries with groupBy (project/adapter/model/day), date range, projectId, adapter filters
- Tests: 8 pass (10-session rollup exact, date range filter, cost derivation, prefix match)

### TASK-019 — SnapshotService + OrphanScanner
- `apps/api/src/domain/snapshot-service.ts` — creates git worktrees at `/tmp/orchestron-worktree/<uuid>`, chmod -R a-w (except .claude/), ledger at `worktrees/<uuid>.json`
- `apps/api/src/startup/orphan-scanner.ts` — scans ledgers at boot, cleans up worktrees for dead sessions
- `apps/api/src/server.ts` — wired orphan-scanner before `fastify.listen`
- Tests: 4 pass (create+cleanup roundtrip, orphan scan cleans dead, skips active)

### TASK-018 — Metrics Routes
- `apps/api/src/routes/metrics.ts` — `GET /api/metrics` with groupBy, from/to date range, adapter filter validation
- Registered in `server.ts`
- Tests: 8 pass (groupBy variations, date validation, invalid adapter 400, range check)

### TASK-020 — Next.js PWA Scaffold
- `apps/web/app/manifest.ts` — Next 15 metadata manifest export (name, short_name, start_url, display: standalone, theme_color, 3 icon sizes)
- `apps/web/app/sw.ts` — serwist service worker (NetworkOnly for /api/*, NetworkFirst for shell)
- `apps/web/next.config.ts` — withSerwist config (swSrc: app/sw.ts, swDest: public/sw.js)
- `apps/web/public/icons/{192,512,maskable-512}.png` — placeholder 1×1 PNG icons
- `apps/web/app/layout.tsx` — updated title, apple-touch-icon, apple-mobile-web-app-capable meta
- Packages installed: @serwist/next, serwist

## Notes
- server.ts already used `new ClaudeAdapter()` (class pattern) but adapter exports `claudeAdapter` const — pre-existing mismatch, not in scope for batch 3
- All 154 API tests pass
