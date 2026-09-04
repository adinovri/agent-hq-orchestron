# Orchestron Implementation — Batch 2

Working dir: `~/Works/agent-hq-orchestron`. **Semua kerja langsung di branch `main`** (Adi solo, PR flow skip). Commit tiap task selesai + push main setelah batch selesai.

**KRITIKAL**: JANGAN pernah pakai `claude -p` atau `--print` di adapter argv (existing test sudah enforce, jaga).

## Referensi

- **HLD**: https://claude.ai/code/artifact/dd125bd7-3802-42fd-bf0b-81609817ef2d
- **TASKS**: https://claude.ai/code/artifact/357e72e5-40a9-4ded-9796-843a79a3ff55
- Batch 1 summary: `scratchpad/orchestron-batch1-summary.md`

## State saat ini (post Batch 1)

**Done** — 7 commit di main, 50 tests pass:
- TASK-001..008 (foundation + core domain services)
- TASK-015 Auth middleware
- TASK-004 Config loader

**Existing modules (reuse):**
- `@agent-hq-orchestron/shared` — Zod schemas + types + config
- `@agent-hq-orchestron/file-store` — `writeJson`, `readJson`, `appendJsonl`, `readJsonlFrom`, `withLock`, `listDir`
- `apps/api/src/adapters/{tmux,claude}.ts` — real spawn/kill/paste
- `apps/api/src/domain/{session-manager,project-registry}.ts`
- `apps/api/src/plugins/auth.ts`

## Batch 2 tasks (sequential, commit tiap task)

### 1. TASK-009 — DelegationTracker

File: `apps/api/src/domain/delegation-tracker.ts`.

Behavior:
- Append parent-child edge ke `${dataDir}/delegation/<parent>.jsonl` (append-only).
- Row schema: `{childUuid, spawnedAt, spawnPrompt}` — per HLD Delegation Ownership Semantics.
- `getChildren(parentUuid)` — read jsonl, return array of edges.
- `getDescendants(uuid)` — BFS traversal (parent → children → grandchildren).
- `killCascade(rootUuid, sessionManager)` — kill semua descendant recursive via SessionManager.kill.
- `getAncestorChain(uuid)` — scan all `delegation/*.jsonl`, return ancestry list.
- **Detached mode**: kalau session flag `detached: true`, JANGAN append edge.

Test: `apps/api/tests/delegation-tracker.test.ts`. Cover: 3-level tree cascade, ancestor chain, detached exclusion.

### 2. TASK-010 — HookRunner

File: `apps/api/src/domain/hook-runner.ts`.

Behavior:
- Discovery: scan `${dataDir}/hooks/<event>/*` lexicographic (mkdir kalau tidak ada).
- 5 events: `pre-spawn`, `post-transcript-chunk`, `on-session-end`, `on-error`, `on-schedule-fire`.
- Runtime dispatch:
  - `.ts` / `.mjs` → `node --experimental-strip-types <path>`
  - `.sh` / no ext + exec bit → `bash <path>`
- Payload via stdin JSON, capture stdout + stderr.
- **Sync events** (`pre-spawn`, `on-schedule-fire`): non-zero exit → throw `HookAbortError(reason)`.
- **Async events** (`post-transcript-chunk`, `on-session-end`, `on-error`): fire-and-forget, log error only, tidak block.
- Timeout 5s default (kill via `SIGTERM` then `SIGKILL` after 500ms grace).
- Log ke `${dataDir}/logs/hooks-YYYY-MM-DD.jsonl` (via FileStore `appendJsonl`).

Test: `apps/api/tests/hook-runner.test.ts`. Cover: exit non-zero abort semantic, timeout kill, async fire-forget, discovery scan, payload delivery.

### 3. TASK-011 — TemplateResolver

File: `apps/api/src/domain/template-resolver.ts` + `apps/api/src/domain/git-context.ts`.

Behavior:
- Load template dari `${dataDir}/templates/<name>.md`.
- Parse YAML frontmatter via `gray-matter` (npm install kalau belum).
- Validate required variables from frontmatter `variables` spec → miss = throw `TemplateValidationError`.
- Interpolate namespaces:
  - `{{project.name}}`, `{{project.path}}` — dari `ProjectMetadata`
  - `{{git.branch}}`, `{{git.log-N}}`, `{{git.diff}}`, `{{git.status}}` — dari `git-context.ts` (`execFile` in project cwd, safe args). Non-git dir → return empty string, no throw.
  - `{{date}}`, `{{date.iso}}` — dari `new Date()`
  - `{{user}}` — dari `os.userInfo()`
  - `{{env.FOO}}` — dari `process.env.FOO`
  - `{{vars.<key>}}` — user-supplied vars
- Mustache-style substitution (hand-roll, gak perlu library). Missing var → empty string.

Test: `apps/api/tests/template-resolver.test.ts` + `apps/api/tests/git-context.test.ts`. Cover: required var missing, git resolver di git dir vs non-git, unresolved var → empty.

### 4. TASK-014 — Fastify routes wire-up (real session + project routes)

File: Update `apps/api/src/server.ts` — replace stub routes with real handlers.
Buat routes-registry pattern: `apps/api/src/routes/{sessions,projects,delegation}.ts` — register masing-masing sebagai Fastify plugin.

Endpoints:
- **Projects** (uses `ProjectRegistry`):
  - `POST /api/projects` — validate body `RegisterProjectBodySchema`, call registry.create
  - `GET /api/projects` — return list, support `?group=` `?tag=` filter
  - `GET /api/projects/:id` — return one, 404 kalau tidak ada
  - `PATCH /api/projects/:id` — partial update
  - `DELETE /api/projects/:id`
- **Sessions** (uses `SessionManager` + `HookRunner` + `TemplateResolver`):
  - `POST /api/sessions` — validate `SpawnSessionBodySchema`. Flow: run `pre-spawn` hooks → resolve template (kalau ada) → manager.spawn. Return session metadata.
  - `GET /api/sessions` — list, support `?status=` `?projectId=` filter
  - `GET /api/sessions/:uuid` — one
  - `DELETE /api/sessions/:uuid` — manager.kill + cascade descendants
- **Delegation**:
  - `GET /api/delegation/:rootUuid` — return `{nodes: SessionMetadata[], edges: [...]}` for React Flow

Semua route Zod-validated (request + response). Test masing-masing route file: `apps/api/tests/routes/*.test.ts`. Cover happy path + validation error + not found.

### 5. TASK-017 — SSE + WebSocket streaming (transcript stream)

File: `apps/api/src/routes/stream.ts`.

Endpoints:
- **SSE**: `GET /api/sessions/:uuid/stream` — pipe TranscriptTailer events. Include `event:` + `data:` per event. Ping every 30s untuk keep-alive.
- **WebSocket**: `WS /api/sessions/:uuid/socket` — bi-directional. Server→client transcript events, client→server prompt input (POST-equivalent).

Perlu `TranscriptTailer` module baru — `apps/api/src/streaming/transcript-tailer.ts`:
- `watch(sessionUuid, jsonlPath, startOffset)` — pakai `fs.watch` + `readJsonlFrom` (existing FileStore).
- EventEmitter emits `{type, sessionUuid, event}` per line.
- Persist offset ke `${dataDir}/sessions/<uuid>.offset` setiap 50ms debounced batch.
- Malformed line → log warn, skip.
- Restart-safe: resume dari offset lama tanpa duplicate.

Test:
- `apps/api/tests/transcript-tailer.test.ts` — unit: watch temporary file, 100 line emit, offset persist, malformed line skip.
- `apps/api/tests/routes/stream.test.ts` — integration ringan pakai supertest atau fastify.inject. Verifikasi SSE format (2 event lines) + WS handshake.

## Aturan main

- **Argv assertion enforced**: adapter test HARUS tetap verify no `-p`/`--print` reachable.
- **Direct to main**: JANGAN buat branch baru, commit langsung ke `main`. Push `git push origin main` setelah setiap commit (atau batch akhir).
- **Commit format**: `feat(TASK-XXX): <ringkasan>`. GIT identity inline:
  ```
  GIT_AUTHOR_NAME="Adi Novriansyah" GIT_AUTHOR_EMAIL="adi.novriansyah@nanovest.io" \
  GIT_COMMITTER_NAME="Adi Novriansyah" GIT_COMMITTER_EMAIL="adi.novriansyah@nanovest.io" \
  git commit -m "..."
  ```
- **Test setiap module Vitest**. E2E defer ke TASK-030.
- **Isolate tmux socket** kalau butuh (jarang di batch 2): `tmux -L test-${pid}`.
- **Stuck**: pakai `nafu-task-ask <TASK_ID> "?"` — tulis ctx dulu ke `~/.openclaw/tasks/<TASK_ID>/`.
- **Selesai**: tulis `scratchpad/orchestron-batch2-summary.md` — commit + push (main sudah ready to push). Panggil `nafu-notify "orchestron batch 2 selesai: <ringkasan>"`.

Mulai TASK-009. Sequential.
