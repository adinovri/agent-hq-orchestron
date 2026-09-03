# Orchestron Implementation — Batch 5 (TUI + CLI + E2E — FINAL)

Working dir: `~/Works/agent-hq-orchestron`. Direct-to-`main`.

## Referensi

- HLD: https://claude.ai/code/artifact/dd125bd7-3802-42fd-bf0b-81609817ef2d
- TASKS: https://claude.ai/code/artifact/357e72e5-40a9-4ded-9796-843a79a3ff55

## State (post Batch 4)

- Backend + Web UI: 100% done
- Belum ada: TUI, CLI, E2E test suite

## Batch 5 tasks

### 1. TASK-026 — Ink TUI dashboard

Files:
- `apps/tui/package.json` — create workspace kalau belum ada; deps: `ink@^5`, `react`, `@agent-hq-orchestron/shared`
- `apps/tui/src/index.tsx` — entry: render App component with `render(<App/>)`
- `apps/tui/src/screens/{Dashboard,SessionDetail}.tsx` — screens
- `apps/tui/src/components/{SessionRow,Header,StatusBar}.tsx` — atoms
- `apps/tui/src/hooks/useApi.ts` — fetch client with token support

Behavior:
- Root App: keyboard router (`j`/`k` nav, Enter open, `k` kill, `n` new, `q` quit)
- Dashboard: session list dari `/api/sessions`, highlight cursor, status color coded
- SessionDetail: tail transcript via SSE (`eventsource` polyfill for Node), scrollable pane
- Command palette (`/`): open input, common actions
- CLI args: `--url <base>` (default localhost:8080), `--token <t>` untuk remote

Test: `apps/tui/tests/dashboard.test.tsx` via `ink-testing-library`. Snapshot render dgn 3 mock sessions, keyboard nav shifts highlight.

### 2. TASK-027 — Commander CLI scaffold + core subcommands

Files:
- `apps/cli/package.json` — deps: `commander@^12`, `picocolors`, `cli-table3`, `zod`, `@agent-hq-orchestron/shared`
- `apps/cli/src/index.ts` — entry
- `apps/cli/src/commands/{serve,tui,token,project,session,schedule}.ts`
- `apps/cli/src/helpers/defineCommand.ts` — Zod-derived --help hint
- `apps/cli/bin/orchestron` — shebang script pointing to `dist/index.js` (or via tsx untuk dev)

Subcommands:
- `orchestron serve` — spawn Fastify API (import from `apps/api`)
- `orchestron tui` — spawn Ink TUI (import from `apps/tui`)
- `orchestron token generate` — output hex-24 token
- `orchestron token rotate` — regenerate + update config file
- `orchestron project {add,list,edit,rm}` — CRUD ProjectRegistry
- `orchestron session {list,spawn,kill,logs}` — SessionManager
- `orchestron schedule {list,run,daemon}` — stub (Nice-to-Have, defer implementation)

Global flag `--json` — machine-readable output.
Output human: `cli-table3` + `picocolors`.

Startup latency target: < 30ms cold (verify via `time orchestron --help`).

Test: `apps/cli/tests/help.test.ts` — --help lists all subcommands; `--json` output valid JSON per subcommand.

### 3. TASK-028 — CLI `orchestron qr`

Files:
- `apps/cli/src/commands/qr.ts`
- `apps/cli/src/helpers/resolve-host.ts`

Behavior:
- Read `ORCHESTRON_REMOTE_TOKEN` dari env atau config file
- Host resolver:
  1. Try `tailscale ip -4` — pakai kalau exit 0
  2. Else scan `os.networkInterfaces()` — filter loopback, prefer `192.168.*` / `10.*` / `172.16-31.*`
  3. Fallback ke `127.0.0.1` + warning
- Build URL: `http://<host>:<port>/pair?token=<token>`
- Render QR via `qrcode-terminal` (npm install)
- Print warning banner: full-access token, do not screen-share

Test: `apps/cli/tests/qr.test.ts` — mock Tailscale exec, verify URL construction, missing token → clear error + exit 1.

### 4. TASK-029 — CLI `orchestron doctor`

File: `apps/cli/src/commands/doctor.ts`.

Behavior:
- Check binaries: `node` ≥ 20, `tmux` ≥ 3.2, `git` ≥ 2.40, `claude` present, `gh` optional, `bb` optional, `tailscale` optional
- Check filesystem: `~/.orchestron/` writable (mkdir + touch test), disk free > 1GB
- Check config: bind non-loopback + no token → warn
- Output: table (via cli-table3) dgn columns: Check | Status | Version | Hint
- Green ✓ untuk pass, red ✗ untuk fail (via picocolors)
- Exit 0 kalau all critical pass, exit 1 kalau critical fail (missing tmux/claude/node)

Test: `apps/cli/tests/doctor.test.ts` — mock `execFile`, verify table structure + exit code.

### 5. TASK-030 — E2E test suite

Files:
- `test/e2e/spawn-lifecycle.spec.ts` — via Playwright (kalau butuh browser) atau supertest untuk pure API
- `test/e2e/delegation-cascade.spec.ts`
- `test/e2e/snapshot-cleanup.spec.ts`
- `test/fixtures/mock-claude.sh` — deterministic JSONL emitter

Setup:
- Buat mock-claude.sh: read args, emit fixture JSONL (init + assistant message + result). Chmod +x.
- Set env `CLAUDE_CLI=<path-to-mock>` untuk redirect adapter spawn
- Isolated tmux socket per test suite: `tmux -L test-e2e-${pid}`

Scenarios:
1. **spawn-lifecycle**: register project via API → spawn session (mock claude) → SSE consumer sees 3+ events → kill → assert status transitions ke `killed`, tmux killed
2. **delegation-cascade**: spawn parent → 2 children (POST /api/sessions dgn parentSessionId) → 1 grandchild → DELETE root → assert semua descendant killed via list API
3. **snapshot-cleanup**: mock git worktree via execFile spy → spawn session dgn `--snapshot pr:123` (mock gh) → verify worktree created → end session → verify worktree removed + ledger deleted
4. **chaos**: kill API mid-session (SIGKILL) → restart API → orphan scanner cleanups worktree + resume-able sessions

Runtime target: < 5 min total suite.

Add npm script: `test:e2e` di root `package.json`.

## Aturan main + Finalization

- Direct-to-main
- Commit per task
- Selesai batch: push + tulis `scratchpad/orchestron-batch5-summary.md` + tulis **project-level completion** `scratchpad/orchestron-COMPLETE.md` (rangkuman 30 task, cumulative tests, cumulative commits, file tree final)
- Panggil `nafu-notify "orchestron COMPLETE — 30 tasks done"`
- Ini batch terakhir — no next batch.

Mulai TASK-026.
