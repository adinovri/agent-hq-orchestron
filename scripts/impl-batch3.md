# Orchestron Implementation — Batch 3 (Adapter + Backend Complete)

Working dir: `~/Works/agent-hq-orchestron`. Direct-to-`main` (no feature branch).

**KRITIKAL**: JANGAN pernah pakai `claude -p` atau `--print` di adapter argv.

## Referensi

- HLD: https://claude.ai/code/artifact/dd125bd7-3802-42fd-bf0b-81609817ef2d
- TASKS: https://claude.ai/code/artifact/357e72e5-40a9-4ded-9796-843a79a3ff55
- Batch 1 summary: `scratchpad/orchestron-batch1-summary.md`
- Batch 2 summary: `scratchpad/orchestron-batch2-summary.md`

## State saat ini (post Batch 2)

- 13 commit di main, 117 tests pass
- Done: TASK-001..005, 007..011, 014, 015, 017 (semua foundation + domain services + routes wire-up + streaming)
- Existing packages: `@agent-hq-orchestron/shared`, `@agent-hq-orchestron/file-store`
- Existing api modules: `adapters/{tmux,claude}.ts`, `domain/{session-manager,project-registry,delegation-tracker,hook-runner,template-resolver}.ts`, `routes/{projects,sessions,delegation,stream}.ts`, `streaming/transcript-tailer.ts`, `plugins/auth.ts`

## Batch 3 tasks

### 1. TASK-012 — GitHostAdapter (gh + bb)

Files:
- `apps/api/src/adapters/git-host/gh.ts` — GitHub adapter
- `apps/api/src/adapters/git-host/bb.ts` — Bitbucket adapter
- `apps/api/src/adapters/git-host/registry.ts` — router

Interface (already in `packages/shared/src/git-host.ts`? — kalau belum, create it):
```ts
interface GitHostAdapter {
  name: 'gh' | 'bb'
  detect(projectPath: string): Promise<boolean>
  pr(id: number): Promise<{number, title, body, author, baseRef, headRef, diff, reviewers, comments, status}>
  issue(id: number): Promise<{number, title, body, labels, assignees, comments}>
}
```

Behavior:
- **gh adapter**: exec `gh pr view <N> --json ...` fields via `execFile`. Cache 5min ke `~/.orchestron/cache/gh/<N>.json`.
- **bb adapter**: prefer `bb-cli` binary, fallback ke `curl https://api.bitbucket.org/2.0/...` dgn `BITBUCKET_APP_PASSWORD` env.
- **Detection**: parse `git remote get-url origin` di project path → `github.com/*` → gh, `bitbucket.org/*` → bb.
- **Argv whitelist**: block subcommands `merge`, `close`, `delete` — hanya read commands.
- **Missing binary**: return null adapter (no throw).

Test: `apps/api/tests/adapters/git-host.test.ts`. Mock `execFile`. Cover detection routing (4 URL patterns), cache hit skips exec, whitelist blocks merge, missing gh returns null.

### 2. TASK-013 — MetricsCollector

Files:
- `apps/api/src/domain/metrics-collector.ts`
- `apps/api/src/domain/pricing-table.ts` — hardcode pricing per model (claude-sonnet-4-6, opus, haiku)

Behavior:
- `record(session)`: on session end, extract token count dari session's `tokenUsage`. Compute cost via pricing table.
- Append record ke `metrics/sessions.jsonl` (FileStore appendJsonl).
- `query({groupBy, from, to, projectId?, adapter?})` → return `{buckets: [{key, sessions, tokens, cost_usd, avg_duration_ms}], total}`.
- groupBy: `project` | `adapter` | `model` | `day`.
- `getPricing(model)` → return `{inputPer1M, outputPer1M, cacheReadPer1M?, cacheCreationPer1M?}`.

Test: `apps/api/tests/metrics-collector.test.ts`. Cover: 10 sessions rollup by project sum exact, date range filter, cost derived correctly.

### 3. TASK-019 — SnapshotService (agent-scoped worktree)

File: `apps/api/src/domain/snapshot-service.ts` + `apps/api/src/startup/orphan-scanner.ts`.

Behavior:
- `create({sessionUuid, prSource, gitHostAdapter, projectPath})`:
  1. Call `gitHostAdapter.pr(N)` → get baseRef
  2. `git worktree add /tmp/orchestron-worktree/<uuid> origin/<baseRef>` via execFile
  3. `chmod -R a-w <worktree>` (except `.claude/`)
  4. Write ledger to `worktrees/<uuid>.json` — cleanup record
  5. Return `{worktreePath, readOnly: true}`
- `cleanup(sessionUuid)`:
  1. `git worktree remove --force <path>` via execFile
  2. Delete ledger file
- `scanOrphans()` (called at boot from `orphan-scanner.ts`):
  - Iterate `worktrees/*.json` files
  - Check if session still active (via SessionManager)
  - If not active → cleanup

Wire orphan scanner ke `server.ts` startup sebelum `fastify.listen`.

Test: `apps/api/tests/snapshot-service.test.ts`. Cover: create + cleanup roundtrip (mock git), orphan scan cleans up dead sessions, write attempt in worktree throws EACCES (skip real file test, just ensure chmod called).

### 4. TASK-018 — Metrics + delegation graph routes

File: `apps/api/src/routes/metrics.ts`.

Endpoints:
- `GET /api/metrics?groupBy=project&from=YYYY-MM-DD&to=YYYY-MM-DD` — invoke MetricsCollector.query
- Delegation graph endpoint sudah ada di TASK-014. Enhance kalau perlu (include token/cost totals per node).

Register di `server.ts`.

Test: `apps/api/tests/routes/metrics.test.ts` (via fastify.inject). Cover query with different groupBy, date range validation.

### 5. TASK-020 — Next.js scaffold + PWA (manifest + service worker + icons)

Files:
- `apps/web/app/manifest.ts` — Next 15 metadata export
- `apps/web/app/sw.ts` — via `@serwist/next` (install: `@serwist/next` + `serwist`)
- `apps/web/public/icons/{192,512,maskable-512}.png` — placeholder icons (buat simple SVG dgn "AHQ" text, convert ke PNG via node script atau use dummy 1×1)
- `apps/web/next.config.ts` — add serwist config
- `apps/web/app/layout.tsx` — add manifest link, apple-touch-icon meta

Manifest:
- name: "Agent HQ Orchestron"
- short_name: "Orchestron"
- start_url: "/"
- display: "standalone"
- theme_color: "#1a1a1a"
- background_color: "#ffffff"
- icons: 3 sizes (192, 512, 512-maskable)

Service worker (NetworkFirst untuk shell, no-cache untuk /api/*):
- Skip: `/api/*`, SSE, WS
- Cache: shell (`/`, `/session`, static CSS/JS)

iOS quirks di `layout.tsx`:
- `<link rel="apple-touch-icon" href="/icons/192.png">`
- `<meta name="apple-mobile-web-app-capable" content="yes">`
- `<meta name="apple-mobile-web-app-status-bar-style" content="default">`

Test: light — cek `manifest.webmanifest` reachable via next build, service worker registered. Skip Lighthouse test (manual eval later).

## Aturan main

- Direct-to-main, no branch
- Commit tiap task selesai dgn GIT_AUTHOR/GIT_COMMITTER inline
- Test setiap module Vitest
- Selesai batch: push origin main + tulis `scratchpad/orchestron-batch3-summary.md`
- Panggil `nafu-notify "orchestron batch 3 selesai"`
- **Kritikal**: script orchestrator akan auto-spawn batch 4 setelah summary file muncul. Jangan spawn batch 4 sendiri.

Mulai TASK-012. Sequential.
