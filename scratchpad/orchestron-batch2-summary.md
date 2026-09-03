# Orchestron Batch 2 — Implementation Summary

Date: 2026-09-04  
Branch: main  
Total new tests: 67 (117 cumulative, 0 failures)

## Tasks completed

### TASK-009 — DelegationTracker (`ac6392a`)
- `apps/api/src/domain/delegation-tracker.ts`
- Append-only JSONL per parent UUID (`delegation/<parent>.jsonl`)
- Row schema: `{childUuid, spawnedAt, spawnPrompt?}`
- Methods: `recordEdge`, `getChildren`, `getDescendants` (BFS), `killCascade` (reverse order, best-effort), `getAncestorChain` (scan all files)
- Detached sessions excluded from edge recording
- 12 tests

### TASK-010 — HookRunner (`0ff0fe7`)
- `apps/api/src/domain/hook-runner.ts`
- Discovers hook scripts in `hooks/<event>/` (lexicographic)
- `.ts/.mjs` → `node --experimental-strip-types`, `.sh` → `bash`
- Sync events (`pre-spawn`, `on-schedule-fire`): throws `HookAbortError` on non-zero exit
- Async events (`post-transcript-chunk`, `on-session-end`, `on-error`): fire-and-forget
- Timeout: SIGTERM + SIGKILL (process group kill via `detached: true`)
- Logs to `logs/hooks-YYYY-MM-DD.jsonl`
- 12 tests

### TASK-011 — TemplateResolver + GitContext (`921abd7`)
- `apps/api/src/domain/template-resolver.ts` + `git-context.ts`
- YAML frontmatter via `gray-matter`
- Required var validation → `TemplateValidationError`
- Namespaces: `{{project.*}}`, `{{git.*}}`, `{{date}}`, `{{date.iso}}`, `{{user}}`, `{{env.FOO}}`, `{{vars.<key>}}`
- Missing var → empty string (no throw)
- Non-git dir → empty strings, no throw
- 18 tests

### TASK-014 — Routes wire-up (`e485fb3`)
- `apps/api/src/routes/{projects,sessions,delegation}.ts`
- Full CRUD for projects + Zod validation
- Sessions: `POST` runs pre-spawn hook → template resolve → spawn → delegation edge
- Delegation: `GET /api/delegation/:rootUuid` returns `{nodes, edges}` for React Flow
- Session state machine: `spawning → killed` added to allowed transitions
- Server.ts updated to wire all real routes (stubs removed)
- 25 tests

### TASK-017 — SSE + WebSocket streaming (`f210770`)
- `apps/api/src/streaming/transcript-tailer.ts` — EventEmitter, `fs.watch` + `readJsonlFrom`, 50ms debounced offset persist, restart-safe
- `apps/api/src/routes/stream.ts` — SSE `event: + data:` format, 30s keepalive ping; WS bi-directional (transcript out, prompt ack in)
- Upgraded `@fastify/websocket` v10 → v11 (Fastify 5 compat)
- 10 tests

## State after Batch 2
- 5 new domain modules + 3 route plugins + 1 streaming module
- All 117 tests pass
- main pushed: `f210770`
