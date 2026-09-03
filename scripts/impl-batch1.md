# Orchestron Implementation — Batch 1

Working dir: `~/Works/agent-hq-orchestron`. Greenfield TypeScript rewrite of Tycho pattern; supervisor untuk Claude/Codex sessions via tmux + interactive TUI.

**KRITIKAL**: JANGAN pernah pakai `claude -p` atau `--print` di adapter argv. Verifikasi via test — argv assertion.

## Referensi

- **HLD**: https://claude.ai/code/artifact/dd125bd7-3802-42fd-bf0b-81609817ef2d
- **TASKS**: https://claude.ai/code/artifact/357e72e5-40a9-4ded-9796-843a79a3ff55
- **Memory**: `~/.openclaw/agents/nafutech/workspace/memory/MEMORY.md` + `memory/2026-09-01.md`

## State saat ini (2026-09-03)

Repo scaffold done + baru di-extend session terakhir:

- **TASK-001 Monorepo**: Done (npm workspaces + tsconfig.base + concurrently)
- **TASK-002 Shared**: Done — `packages/shared/src/{schemas,types,config,index}.ts` cover semua entity ER diagram HLD + 7-state session lifecycle + AgentAdapter interface + Config schema + boot guard (`assertSafeBind`, `BootGuardError`)
- **TASK-003 FileStore**: In Progress — `writeJson` (.bak recovery), `readJson`, `appendJsonl`, `readJsonlFrom` (offset), `withLock` (proper-lockfile) ada. **Missing: `listDir` helper.**
- **TASK-004 Config loader**: Done (di `packages/shared/src/config.ts`)
- **TASK-014 Fastify bootstrap**: In Progress — `server.ts` pakai `loadConfig` + `assertSafeBind`. Stub routes.
- **TASK-005 Claude adapter**: Stub only — semua method throw `not yet implemented`.

## Batch 1 tasks (sequential, commit tiap task)

### 1. TASK-003 tail-end — FileStore `listDir`

File: `packages/file-store/src/index.ts`.

```typescript
export async function listDir(dirPath: string): Promise<string[]>
```

Behavior:
- Return array of filenames di dirPath.
- Skip files ending `.bak`.
- Skip hidden files (starting `.`).
- Empty array kalau dir tidak ada (no throw).

Test: `packages/file-store/tests/list-dir.test.ts`. Cover: empty dir, mix of .json + .bak (only .json returned), nonexistent dir.

### 2. TASK-015 — Auth middleware

File: `apps/api/src/plugins/auth.ts`.

Behavior:
- Fastify plugin. Ambil `remoteToken` dari config.
- Kalau `remoteToken` unset → no-op, all routes public.
- Kalau set → global `preHandler`: cek `Authorization: Bearer <token>` header pakai `crypto.timingSafeEqual`.
- Whitelist: `/api/health`, `/api/readiness` — skip auth.
- WS/SSE `preValidation` hook: baca `?token=` dari query.
- Missing/wrong → 401.

Register di `server.ts` setelah cors + sensible.

Test: `apps/api/src/plugins/auth.test.ts` unit. Cover: no token set (public), correct, wrong, missing header, whitelisted path skips auth. Vitest.

### 3. TASK-005 — Claude adapter (real impl)

Files:
- `apps/api/src/adapters/tmux.ts` — tmux wrapper (`newSession`, `sendKeys`, `capturePane`, `setBuffer`, `pasteBuffer`, `killSession`). Pakai `execFile` promisified. Every function ambil argv array, no shell string concat.
- Update `apps/api/src/adapters/claude.ts` — implement all 5 methods.

`spawn` config → argv assertion. **HARUS THROW** kalau argv mengandung `-p` atau `--print`. Build argv:

```
env CLAUDE_CONFIG_DIR=${config.configDir}
claude --model <model> --permission-mode bypassPermissions --session-id <uuid>
```

Session uuid via `crypto.randomUUID()`.

`waitTuiReady`: poll `capturePane` setiap 200ms, match regex `/❯|│\s*>|\?\s+for shortcuts/`. Timeout param.

`sendPrompt`: `setBuffer(prompt)` → `pasteBuffer(handle)` → `sendKeys(handle, "Enter")`.

`kill`: `killSession(handle.tmuxName)`.

`resume`: rebuild argv dgn `--resume <sessionUuid>` bukan `--session-id`.

Test: `apps/api/src/adapters/claude.test.ts`
- Unit: argv builder — assert `-p` throws, semua flag benar
- Unit: mock tmux wrapper via vi.mock
- Integration ringan (via mock claude shim di `test/fixtures/mock-claude.sh`) skip untuk sekarang, defer ke TASK-030

### 4. TASK-007 — SessionManager

File: `apps/api/src/domain/session-manager.ts`.

State machine 7 states:
- `spawning → waiting | failed`
- `waiting → running | killed`
- `running → running | completing | killed`
- `completing → completed | failed`
- `completed / failed / killed → terminal`

API:
- `spawn(config)` → return `SessionMetadata`. Cek pool limit (max = `config.maxConcurrent`); reject dgn Error `PoolFullError` kalau full.
- `transition(uuid, newStatus)` → validate transition legality, persist ke FileStore (`sessions/<uuid>.json`).
- `resume(uuid)` → load record, invoke adapter `resume`.
- `kill(uuid)` → adapter kill + transition ke `killed`.
- `list()` → scan `sessions/*.json` via FileStore `listDir` + `readJson` batch.

Persist path: `${config.dataDir}/sessions/<uuid>.json`.

Test unit: state machine transition matrix (valid + invalid throws), pool limit enforced.

### 5. TASK-008 — ProjectRegistry

File: `apps/api/src/domain/project-registry.ts`.

API:
- `create(input)` → validate `path` exists + writable via `fs.access`. Persist ke `projects/<id>.json`.
- `get(id)`, `list()`, `update(id, patch)`, `delete(id)`.
- `filter({ group?, tags? })` → filter subset.

Test unit: create round-trip, filter group + tags, delete removes file + .bak.

## Rules main

- **Argv assertion enforced**: adapter test HARUS verify no `-p`/`--print` reachable.
- **Commit per task**: format `feat(TASK-XXX): <ringkasan>`. Set inline:
  ```
  GIT_AUTHOR_NAME="Adi Novriansyah" GIT_AUTHOR_EMAIL="adi.novriansyah@nanovest.io" \
  GIT_COMMITTER_NAME="Adi Novriansyah" GIT_COMMITTER_EMAIL="adi.novriansyah@nanovest.io" \
  git commit -m "..."
  ```
- **Test setiap module Vitest**. E2E defer ke TASK-030.
- **Isolate tmux socket** kalau test butuh real tmux: `tmux -L test-${pid}`.
- **Stuck**: pakai `nafu-task-ask <TASK_ID> "?"` — tulis ctx dulu ke `~/.openclaw/tasks/<TASK_ID>/`.
- **Selesai**: buat `scratchpad/orchestron-batch1-summary.md`. Push branch `feature/impl-batch1`. Panggil `nafu-notify "orchestron batch 1 selesai: <ringkasan>"`.

Mulai TASK-003 listDir. Sequential.
