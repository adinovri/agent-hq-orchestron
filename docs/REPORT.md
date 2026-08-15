# Tycho Research Report
**Tanggal:** 2026-08-15  
**Tujuan:** Riset Tycho (usetycho.com) sebagai referensi untuk rewrite ke Next.js + backend + LLM CLI bridge (openclaw-style)

---

## 1. Temuan Utama: Tycho adalah Open Source

**Repository:** `https://github.com/firewalker06/tycho`  
**Lisensi:** MIT  
**Versi saat ini:** v0.10.0  
**Distribusi:** `brew tap firewalker06/tycho && brew install tycho`

Tycho **bukan** closed-source SaaS. Ini open-source CLI tool yang bisa di-fork dan dijadikan referensi langsung.

---

## 2. Stack Tycho Saat Ini

### Bahasa & Framework
| Layer | Teknologi |
|-------|-----------|
| Primary language | **Ruby 3.2+** |
| Dependency manager | Bundler (Gemfile) |
| TUI rendering | Charm Ruby (`bubbles`, `bubbletea`, `glamour`, `lipgloss`) |
| CLI framework | `dry-cli` |
| Distribution | Homebrew (macOS) / source install (Linux/WSL) |
| Config | YAML (`~/.tycho/config/hq.yml`) |
| **Database** | **TIDAK ADA** — pure file-based (YAML + JSON atomic write) |

### Konfirmasi: Tycho TIDAK Pakai Database
Verified dari `Gemfile` — **tidak ada gem database sama sekali**:
- ❌ No `pg`, `mysql2`, `sqlite3`, `sequel`, `activerecord`
- ❌ No `redis`, `mongoid`
- ✅ Cuma `yaml` + native `JSON` untuk semua state

**Semua persistence pakai `HQ::FileStore` module** (`lib/hq/domain/file_store.rb`):
- `read_json` / `write_json` / `write_yaml` untuk config & state
- Atomic write: `file.tmp-<pid>-<hex>` → `fsync` → `File.rename` → `fsync_directory`
- Backup: `.bak` file otomatis dibuat sebelum overwrite
- Recovery: kalau JSON corrupt, auto-recover dari `.bak`
- Permission: `0o600` (owner-only)

**Pattern ini adalah "local-first, crash-safe file storage"** — cocok untuk single-user desktop tool, tidak butuh DB server, tidak butuh migrations.

### Mengejutkan: Bukan TypeScript/Go/Rust
Tycho ditulis dalam **Ruby**, bukan teknologi modern yang mungkin diasumsikan. Ini berimplikasi pada portabilitas dan ekosistem tool.

### Arsitektur Tycho
```
tycho/
├── bin/tycho          # CLI entry point
├── lib/               # Core Ruby logic
├── config/            # Config templates
├── schedules/         # Cron-style agent definitions
├── .claude/skills/    # Claude skill definitions
└── hq.gemspec         # Gem specification
```

### Fitur Utama
- **Multi-agent supervisor**: Dashboard TUI untuk session active/waiting/completed/failed
- **Agent support**: Codex, Claude, OpenCode, custom harness
- **Remote UI**: Web interface ringan (via `--server` flag)
- **Scheduled runs**: Cron-style agent execution
- **GitHub App integration**: PR review automation
- **Session delegation**: Parent-child agent sessions dengan audit trail
- **Structured output validation**: Auto-correction untuk agent output
- **Local JSON API**: REST API lokal saat mode server

### Konsep Positioning
"Factorio for coding agents" — supervisor control center, lokal-first, tidak mengandalkan hosted control plane.

---

## 3. Claude-CLI-Bridge Pattern (OpenClaw)

Dibaca dari `/home/scriberion/Codes/claude-cli-bridge/`:

### Arsitektur Bridge
```
OpenClaw → [JSONL stdin] → bridge.py → [tmux spawn] → claude CLI
                         ← [JSONL stdout] ←           [transcript .jsonl]
```

### Flow Per Request
1. Parse `openclaw_session_id` dari args
2. Resolve/generate `claude_uuid`
3. Save UUID ke `bridge-state/sessions.json` (sebelum spawn — crash-safe)
4. Spawn `claude --resume <uuid>` di detached tmux session
5. Poll pane sampai TUI ready (detect `❯`, `│ >`, `? for shortcuts`)
6. Paste prompt via tmux buffer + Enter
7. Tail JSONL transcript dari pre-send offset → wait `stop_reason=end_turn`
8. Emit `system` + `assistant` + `result` ke stdout
9. Kill tmux session

### Two-Layer Session Model
| Layer | Lifetime | Storage |
|-------|----------|---------|
| tmux session | Ephemeral (per-request, kill setelah done) | RAM only |
| Claude session | Persistent | `~/.claude/projects/<cwd>/<uuid>.jsonl` |

### nafu-bg-claude Extension
Sama seperti bridge.py tapi untuk background execution:
- Spawn tmux detached session
- Register ke `~/.openclaw/bg_registry.json`
- `nafu-bg-watchdog.timer` poll registry → notify Telegram saat done

---

## 4. Gap Analysis: Tycho vs. Kebutuhan Rewrite

### Keterbatasan Tycho Saat Ini
| Aspek | Tycho (Ruby) | Kebutuhan Rewrite |
|-------|-------------|-------------------|
| Frontend | TUI + minimal web | Full web UI (graph visualization) |
| Multi-user | Tidak ada | Multi-user / team dashboard |
| Real-time | Polling | WebSocket/SSE streaming |
| Orchestration graph | Tidak ada | React Flow DAG visualization |
| Session persistence | File-based | PostgreSQL + Redis |
| Multi-agent parallel | Limited | Concurrent subprocess pool |
| Agent extensibility | Config-based | Plugin architecture |

---

## 5. Rekomendasi Stack Rewrite

### 5.1 Frontend: Next.js App Router
```
Next.js 15 (App Router)
├── shadcn/ui (komponen UI)
├── Tailwind CSS
├── React Flow (orchestration graph / DAG visualization)
├── Zustand (state management - session list, agent status)
└── TanStack Query (server state / polling agent status)
```

**Kenapa React Flow:** Tycho's "parent-child delegation" sangat natural sebagai directed graph. React Flow sudah proven untuk workflow visualization (LangFlow, Dify pakai ini).

**Pattern halaman utama:**
- `/` → Dashboard: grid of agent sessions (active/waiting/done/failed)
- `/session/:id` → Session detail: log stream, token usage, parent/child links
- `/graph` → Orchestration graph: React Flow DAG antar sessions
- `/projects` → Project registry (setara `~/.tycho/config/hq.yml`)
- `/settings` → Agent config, API keys

### 5.2 Backend: Node.js / Fastify (CONFIRMED by Adi)

```
Fastify 5 + TypeScript
├── child_process.spawn() + node-pty → claude/codex CLI subprocess (INTERAKTIF, bukan claude -p)
├── SSE via @fastify/sse-v2 → streaming ke FE
├── WebSocket via @fastify/websocket → bidirectional control
├── better-sqlite3 → local file DB (default, single-user)
│   ATAU
├── Prisma → PostgreSQL (opt-in, multi-user mode)
└── ioredis → Redis (opsional, cuma untuk multi-user pub/sub)
```

**Kenapa Fastify (vs Express/Hono/raw Node):**
- **Fastify:** Native TypeScript, plugin architecture, SSE + WS mature, JSON schema validation built-in, faster than Express ~2x. Ekosistem plugin (`@fastify/websocket`, `@fastify/sse-v2`) cocok untuk streaming use case ini.
- **Hono:** Bagus untuk edge/Cloudflare Workers, TAPI kita butuh long-lived processes (spawn CLI subprocess) — Hono kurang cocok untuk server-full pattern.
- **Express:** Legacy, slower, plugin ecosystem lebih rapuh untuk streaming.
- **Raw Node http:** Terlalu manual, maintenance beban.

**Verdict:** Fastify 5 + TypeScript. Satu monorepo (Turborepo/pnpm workspaces) — FE + BE share types via `@app/shared` package.

### 5.2.1 Managing Concurrent CLI Subprocess

**Pattern:**
```typescript
// Session pool — max concurrent CLI subprocesses
class AgentPool {
  private processes = new Map<string, AgentProcess>()
  private maxConcurrent = 10  // configurable
  
  async spawn(config: AgentConfig): Promise<AgentSession> {
    if (this.processes.size >= this.maxConcurrent) {
      throw new Error('Pool full — queue or reject')
    }
    // node-pty untuk TUI mode (bypassPermissions)
    // atau child_process.spawn untuk JSONL streaming mode
    const proc = spawn(config.cliPath, [...])
    // ...
  }
}
```

**Kenapa `node-pty` bukan `child_process` untuk mode TUI:**
- Claude CLI (interactive) butuh PTY (pseudo-terminal) untuk render TUI, bukan pipe biasa
- `node-pty` = same pattern seperti tmux di bridge.py, tapi native di Node
- Alternatif: spawn `tmux new-session -d ...` dari Node (persis pattern nafu-bg-claude), lalu send-keys via `tmux` CLI

**Rekomendasi:** Start dengan `tmux + child_process` (proven di bridge.py) → migrate ke `node-pty` kalau butuh cross-platform (Windows tanpa tmux).

---

### 5.3 CLI Backend Integration — HANYA TMUX/INTERAKTIF, JANGAN `claude -p`

**⚠️ CONSTRAINT PENTING (Adi's directive):**
> JANGAN pake `claude -p` (print mode / SDK mode).

**Kenapa:**
- `claude -p` = non-interactive SDK mode → **consume Anthropic API credit langsung** ($/token)
- Interactive `claude` TUI (via tmux/PTY) → pake **subscription quota** (Claude Pro/Max fixed monthly)
- Untuk Tycho-like usage (banyak session, long context) → subscription jauh lebih murah dari pay-per-token

**Satu-satunya pattern yang digunakan: interactive TUI via tmux + send-keys** (persis pattern `bridge.py` + `nafu-bg-claude`).

```typescript
// packages/cli-bridge/src/runner.ts

import { spawn } from 'child_process'
import { readFileSync, statSync } from 'fs'
import { setTimeout as sleep } from 'timers/promises'

export async function spawnAgentSession(config: AgentConfig): Promise<AgentSession> {
  const tmuxName = `agent-${config.sessionId}`
  const claudeUuid = config.claudeSessionUuid ?? crypto.randomUUID()
  
  // 1. Spawn detached tmux session dengan `claude` interaktif
  //    JANGAN pake -p / --print / stdin mode.
  await execCmd('tmux', [
    'new-session', '-d', '-s', tmuxName,
    '-x', '220', '-y', '50',
    '-c', config.workspace,
    'env', `CLAUDE_CONFIG_DIR=${config.configDir}`,
    config.cliPath,                          // 'claude'
    '--model', config.model,                 // 'claude-sonnet-4-6'
    '--permission-mode', 'bypassPermissions',
    '--session-id', claudeUuid,              // atau --resume kalau existing
  ])
  
  // 2. Wait TUI ready (poll pane sampai detect `❯` / `│ >` / `? for shortcuts`)
  await waitTuiReady(tmuxName)
  
  // 3. Track transcript offset SEBELUM inject prompt
  const jsonlPath = `${process.env.HOME}/.claude/projects/${mangledCwd(config.workspace)}/${claudeUuid}.jsonl`
  const tailOffset = statSync(jsonlPath, { throwIfNoEntry: false })?.size ?? 0
  
  // 4. Inject prompt via tmux buffer + paste (aman untuk multiline)
  await execCmd('tmux', ['set-buffer', '--', config.prompt])
  await execCmd('tmux', ['paste-buffer', '-t', tmuxName])
  await sleep(500)
  await execCmd('tmux', ['send-keys', '-t', tmuxName, 'Enter'])
  
  // 5. Tail JSONL transcript → stream events via SSE ke FE
  return new AgentSession({ tmuxName, jsonlPath, tailOffset, claudeUuid })
}
```

**AgentSession behavior:**
- Baca `jsonlPath` dari `tailOffset` → parse line-by-line
- Setiap line = JSONL event dari Claude (`system`, `assistant`, `tool_use`, `result`)
- Forward via SSE/WebSocket ke Next.js FE
- Detect `stop_reason=end_turn` → mark session done → `tmux kill-session`

**Pattern sudah proven di production:**
- `/home/scriberion/Codes/claude-cli-bridge/` (Python) — dipakai OpenClaw
- `/home/scriberion/.local/bin/nafu-bg-claude` (Python) — dipakai Adi setiap hari
- Node.js port cukup translate 1:1 (sama API tmux CLI)

**Ekstensi ke CLI lain:**
- `codex` (OpenAI) → sama pattern, `--session-id` flag
- `opencode` → sama pattern, config path beda
- `aider` → sedikit beda (stdin-based), butuh adapter

**JANGAN LAKUKAN:**
- ❌ `claude -p "prompt"` → API credit
- ❌ `claude --print --output-format stream-json` → API credit
- ❌ Anthropic SDK direct call (`@anthropic-ai/sdk`) → API credit
- ❌ Skip tmux dengan pipe biasa → Claude TUI butuh PTY, akan crash

---

### 5.4 Real-time Streaming: SSE vs WebSocket

```
SSE (Server-Sent Events): Agent output stream ke browser
WebSocket: Bidirectional control (kill session, send follow-up)
```

**Pattern:**
- FE subscribe ke `GET /api/sessions/:id/stream` (SSE)
- FE kirim command via `POST /api/sessions/:id/input` atau WebSocket channel
- Backend publish ke Redis pub/sub → fan-out ke semua connected clients (multi-user support)

---

### 5.5 Session Persistence — Trade-off File vs SQLite vs Postgres

**Konteks pertanyaan Adi:** "Kalo pake file aja utk DB ok?"

**Jawaban singkat:** YA — untuk single-user desktop use case (persis pattern Tycho), file storage adalah pilihan terbaik. Bahkan lebih simple dari SQLite.

**Perbandingan 3 opsi:**

| Aspek | File-based (Tycho-style) | SQLite (better-sqlite3) | PostgreSQL |
|-------|--------------------------|-------------------------|------------|
| Setup | Nol — cuma `mkdir` | 1 file, no server | Server proses + migrations |
| Multi-user | ❌ Concurrent write susah | ⚠️ WAL mode OK sd ~100 req/s | ✅ Native concurrent |
| Query complexity | ❌ Full-scan JSON, no index | ✅ SQL + index | ✅ SQL + JSONB + advanced |
| Deployment | ✅ Pure local, no ops | ✅ Pure local, no ops | ❌ Butuh Postgres server |
| Backup | Copy `.json` files | Copy `.sqlite` file | `pg_dump` |
| Crash safety | ✅ Atomic rename + `.bak` | ✅ WAL journal | ✅ WAL journal |
| Search full-text | ❌ Manual | ✅ FTS5 | ✅ tsvector / pg_search |
| History replay | ✅ File per session | ✅ Query by session_id | ✅ Query by session_id |
| Ops complexity | Nol | Nol | Managed service ($) |

**Rekomendasi berdasarkan target user:**

#### Opsi 1: **File-based (Tycho-style)** ⭐ untuk MVP / personal tool
```
~/.tychoclone/
├── config/hq.yml              # projects, agents, templates
├── sessions/
│   ├── <session-uuid>.json    # metadata (status, timestamps, cost)
│   ├── <session-uuid>.jsonl   # JSONL event stream (append-only)
│   └── <session-uuid>.json.bak
├── projects/
│   └── <project-uuid>.json    # project registry
└── delegation/
    └── <parent-uuid>.json     # parent-child links
```
- **Pro:** Zero ops, portable (copy folder), audit trail readable, sesuai spirit Tycho
- **Con:** Kalo mau list all sessions filter by status → harus baca semua file
- **Kapan pakai:** Personal desktop tool, < 10K session total, single user

#### Opsi 2: **SQLite (better-sqlite3)** ⭐⭐ untuk single-user tapi butuh query
```
~/.tychoclone/tycho.sqlite

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  agent_type TEXT,
  status TEXT,
  parent_session_id TEXT,
  cli_session_uuid TEXT,
  tmux_name TEXT,
  prompt TEXT,
  response TEXT,
  token_usage TEXT,  -- JSON as string
  cost_usd REAL,
  started_at INTEGER,
  ended_at INTEGER,
  metadata TEXT
);
CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);
```
- **Pro:** SQL + index (list active sessions instant), FTS5 untuk search, 1 file portable, no server
- **Con:** Concurrent write via WAL mode OK sd ~1-10 writer, tapi kalau > 100 subprocess bikin session bareng bisa jadi bottleneck
- **Kapan pakai:** Single-user desktop tool dengan banyak session history, butuh query (filter by status/date/project)
- **Note:** `better-sqlite3` = synchronous Node lib, sangat cepat, ~10x lebih cepat dari `sqlite3` async lib untuk workload ini

#### Opsi 3: **PostgreSQL** untuk multi-user team dashboard
- Pakai HANYA kalau scope berubah jadi team product (multi-user, auth, shared workspaces)
- Overkill untuk single-user local tool
- Butuh Redis untuk pub/sub kalau realtime broadcast antar user

**⭐ REKOMENDASI FINAL untuk Tycho clone:**

**Phase 1 (MVP, 1-2 minggu):** File-based (JSON + JSONL append-only).
- Ikuti persis pattern `HQ::FileStore` di Tycho — atomic write + `.bak`
- Node.js equivalent: `write-file-atomic` package
- Cukup untuk validate UX + agent orchestration flow

**Phase 2 (Post-MVP, kalau butuh):** Migrate ke **SQLite** kalau session count > 1000 atau butuh advanced filter.
- better-sqlite3 + Drizzle ORM (lightweight, TS-native)
- Migration script: baca semua JSON → bulk insert ke SQLite

**Phase 3 (kalau jadi team product):** Postgres + Redis. Skip dulu.

**Redis: SKIP untuk single-user.** Cuma perlu Redis kalau multi-user broadcast antar tab/user. Untuk single-user, in-process EventEmitter cukup.

---

### 5.6 Deployment

```yaml
# docker-compose.yml (development)
services:
  web:       # Next.js (port 3000)
  api:       # Fastify/Go (port 8080)
  postgres:  # PostgreSQL
  redis:     # Redis
  
# Production: Cloud Run (stateless web + api) + Cloud SQL + Memorystore
# Catatan: CLI agent perlu akses ke filesystem lokal → tidak cocok untuk pure cloud
# → Hybrid: API di cloud, CLI agent subprocess di user's machine (via agent daemon)
```

---

## 6. Architecture Diagram: Rewrite Target

```
Browser (Next.js)
    │ WebSocket / SSE
    ▼
Fastify API Server
    ├── Session Manager
    │     ├── PostgreSQL (session state)
    │     └── Redis (pub/sub, cache)
    └── Agent Runner Pool
          ├── claude CLI subprocess  ─── tmux (TUI mode)
          ├── codex CLI subprocess   ─── direct spawn (headless)
          └── opencode CLI subprocess ── direct spawn
              │
              └── JSONL stream → SSE → Browser
```

---

## 7. Risk & Unknowns

### 7.1 TUI-only Constraint (by design)
**Constraint:** Adi eksplisit MELARANG `claude -p` (API credit). Pattern satu-satunya = interactive `claude` via tmux/PTY (subscription quota).  
**Risk:** Windows tidak punya tmux native → butuh `node-pty` alternatif atau WSL. macOS/Linux OK.  
**Action needed:** Confirm target OS. Kalau Windows support wajib → prototype `node-pty` di Phase 1.

### 7.2 Multi-user vs Single-user
**Risk:** Tycho aslinya dirancang untuk single user (local-first). Multi-user menambah kompleksitas di session isolation, credential management, dan filesystem access.  
**Action needed:** Clarify apakah ini untuk personal use (single user) atau team dashboard.

### 7.3 Filesystem Access dari Server
**Risk:** CLI agents butuh akses ke project filesystem. Kalau API server di cloud, agents tidak bisa akses local repos.  
**Two options:**
- a. Desktop app (Electron) atau local daemon yang host API, FE di cloud
- b. Full local deployment (Docker Compose) — lebih simple, sesuai Tycho's "local-first" philosophy

### 7.4 Claude CLI Licensing
**Risk:** Claude CLI (`claude`) adalah Anthropic product. Spawning sebagai subprocess untuk production product perlu check ToS.

### 7.5 Concurrent Process Limit
**Risk:** Setiap agent session = satu OS process. Di server, 50 concurrent agents = 50 processes + 50 tmux sessions.  
**Mitigation:** Process pool dengan max concurrent limit, queue untuk pending sessions.

---

## 8. Recommended Next Steps

1. **Clarify scope:** Personal desktop tool atau team dashboard? → Kalau personal → file-based DB sudah cukup selamanya.
2. **PoC bridge (1-2 hari):** Node.js + Fastify + spawn `tmux new-session -d claude --session-id ...` → tail JSONL → SSE stream ke browser. Verify subscription quota (bukan API credit) via Anthropic dashboard.
3. **PoC React Flow (1 hari):** Prototype visualisasi parent-child agent session sebagai DAG (dummy data dulu).
4. **File storage helper (0.5 hari):** Port `HQ::FileStore` pattern ke TS — pakai `write-file-atomic` + `.bak` backup + JSONL append. Ini fondasi Phase 1.
5. **Go/no-go decision:** Fork Tycho Ruby (MIT) + wrap web UI, ATAU full rewrite Next.js + Fastify?
   - Fork = lebih cepat kalau Tycho core sudah cukup, tinggal ganti TUI → web UI
   - Rewrite = lebih fleksibel, satu bahasa (TS full stack), tapi 4-6 minggu effort

---

## 9. Summary (Final — with Adi's constraints)

| Aspek | Temuan |
|-------|--------|
| Tycho open source? | **Ya** — MIT, `github.com/firewalker06/tycho` (43 stars, pushed today) |
| Stack Tycho | **Ruby 3.2** + Charm Ruby TUI + `dry-cli` + Homebrew |
| **Tycho DB** | **TIDAK ADA DB** — pure file-based (YAML config + JSON atomic write + `.bak`) |
| Pattern agent | Supervisor CLI, spawn Codex/Claude/OpenCode subprocess |
| Reference bridge | `~/Codes/claude-cli-bridge/` (Python + tmux) + `~/.local/bin/nafu-bg-claude` |
| **Recommended FE** | **Next.js 15** App Router + shadcn/ui + React Flow + Tailwind + Zustand |
| **Recommended BE** | **Node.js + Fastify 5 + TypeScript** (confirmed by Adi) |
| **CLI bridge pattern** | **HANYA tmux + interactive `claude`** (subscription quota). **JANGAN `claude -p`** (API credit) |
| **Recommended DB** | **File-based (Phase 1 MVP)** → **SQLite via better-sqlite3 (Phase 2)** → skip Postgres/Redis kecuali multi-user |
| Realtime | SSE (server → client stream) + WebSocket (client → server control) |
| Biggest unknown | Windows support (tmux tidak native → node-pty alternatif) |

**TL;DR untuk implementasi:**
1. Next.js 15 App Router + shadcn/ui + Tailwind + React Flow (untuk DAG orchestration graph)
2. Fastify + TypeScript, spawn `tmux new-session -d claude --session-id ...` (interactive, bukan `-p`)
3. File-based storage dulu (JSON + JSONL append-only, atomic write pola Tycho `HQ::FileStore`)
4. Kalau session > 1K atau butuh filter/search → migrate ke SQLite (better-sqlite3 + Drizzle)
5. Postgres + Redis: SKIP dulu, cuma dipakai kalau berubah jadi multi-user team product
