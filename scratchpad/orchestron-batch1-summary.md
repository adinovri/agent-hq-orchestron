# Orchestron Batch 1 — Implementation Summary

Date: 2026-09-04
Branch: `feature/impl-batch1` (local, no remote configured yet)

## Tasks Completed

### TASK-003 — FileStore `listDir`
- Added `listDir(dirPath)` to `packages/file-store/src/index.ts`
- Skips `.bak` files and hidden files (`.`-prefixed)
- Returns empty array for nonexistent dir (no throw)
- Tests: `packages/file-store/tests/list-dir.test.ts` — 4 cases, all pass
- Commit: `d83dbad`

### TASK-015 — Auth Middleware
- Created `apps/api/src/plugins/auth.ts` as Fastify plugin (fastify-plugin)
- `remoteToken` unset → no-op, all routes public
- Set → global `preHandler` with `crypto.timingSafeEqual` Bearer check
- WS/SSE `preValidation` hook reads `?token=` from query
- Whitelist: `/api/health`, `/api/readiness`
- Registered in `server.ts` after cors + sensible
- Tests: `apps/api/tests/auth.test.ts` — 6 cases, all pass
- Commit: `46b4657`

### TASK-005 — Real Claude Adapter + Tmux Wrapper
- Created `apps/api/src/adapters/tmux.ts` — `newSession`, `sendKeys`, `capturePane`, `setBuffer`, `pasteBuffer`, `killSession` via `execFile` (no shell concat)
- Rewrote `apps/api/src/adapters/claude.ts` — all 5 methods implemented
- `spawn` builds argv: `claude --model <m> --permission-mode bypassPermissions --session-id <uuid>`
- `resume` uses `--resume <uuid>` instead of `--session-id`
- **Argv guard throws** if `-p` or `--print` is in argv
- `waitTuiReady` polls `capturePane` every 200ms matching `/❯|│\s*>|\?\s+for shortcuts/`
- `sendPrompt` uses `setBuffer → pasteBuffer → sendKeys Enter`
- Tests: `apps/api/tests/claude.test.ts` — 9 unit tests (argv builder + tmux delegation), all pass via vi.mock
- Commit: `6380fad`

### TASK-007 — SessionManager
- Created `apps/api/src/domain/session-manager.ts`
- 7-state machine with strict transition validation (`InvalidTransitionError`)
- `spawn` checks pool limit via counting non-terminal sessions (`PoolFullError`)
- `transition` validates legal moves, sets `endedAt` on terminal states
- `resume` / `kill` delegate to adapter
- `list` uses `listDir` + `readJson` batch
- Persists to `${dataDir}/sessions/<uuid>.json`
- Tests: `apps/api/tests/session-manager.test.ts` — 11 cases, all pass
- Commit: `7368b82`

### TASK-008 — ProjectRegistry
- Created `apps/api/src/domain/project-registry.ts`
- `create` validates path exists + writable via `fs.access`
- `get` / `list` / `update` / `delete` / `filter({ group?, tags? })`
- `delete` removes both `.json` and `.bak`
- `filter` — all specified tags must be present (AND semantics)
- Tests: `apps/api/tests/project-registry.test.ts` — 13 cases, all pass
- Commit: `9b8e4f3`

## Test Summary

| Package | Tests |
|---------|-------|
| packages/file-store | 11 pass |
| apps/api | 39 pass |
| **Total** | **50 pass** |

## Notes

- `packages/file-store` and `packages/shared` were built (tsup) to resolve import in api tests
- No git remote configured — branch `feature/impl-batch1` exists locally only; push when remote is set up
- Integration tests with real tmux deferred to TASK-030 per spec
