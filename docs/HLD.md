# HLD — OpenClaw Hub (Tycho Replacement)

**Author:** Adi Novriansyah
**Date:** 2026-08-15
**Status:** Draft — pending Adi's approval
**Related:** `REPORT.md` (Tycho research), `~/Codes/claude-cli-bridge/` (reference bridge)

---

## 1. Overview

### Background

Tycho (`github.com/firewalker06/tycho`) adalah TUI supervisor untuk coding agents (Claude, Codex, OpenCode) yang ditulis dalam Ruby + Charm TUI. UI-nya OK untuk agent orchestration tapi:

1. Ruby stack tidak sesuai dengan preferensi Adi (Node.js/TS)
2. TUI-only — tidak ada web UI untuk visualisasi DAG orchestration
3. Homebrew-only distribution, tidak cocok untuk Linux dev environment Adi
4. Tidak terintegrasi dengan pattern openclaw yang sudah ada (claude-cli-bridge, nafu-bg-claude)

Rewrite ke Next.js + Fastify + interactive `claude` subprocess memungkinkan:

- Web UI untuk graph visualization (React Flow)
- Reuse pattern openclaw yang sudah proven (`~/Codes/claude-cli-bridge/`, `nafu-bg-claude`)
- Subscription quota (bukan API credit) — sesuai konstraint Adi
- Full TypeScript stack — satu bahasa FE+BE

### Goals

- Agent supervisor web UI untuk manage banyak Claude/Codex session concurrent (personal tool, single user)
- Reuse tmux + interactive CLI subprocess pattern dari `nafu-bg-claude` — subscription quota, bukan API credit
- File-based storage (JSON + JSONL) untuk Phase 1 — nol ops overhead
- DAG visualization untuk parent-child agent delegation
- Extensible ke CLI lain (Codex, OpenCode, Aider) via adapter pattern

### Non-Goals

- Multi-user / team dashboard (single-user local desktop tool)
- Cloud deployment (fully local; kalau perlu remote access → tailscale/ngrok, bukan cloud)
- Windows native support (Linux + macOS via tmux; Windows via WSL)
- Anthropic API credit mode (`claude -p` / SDK) — EXPLICITLY EXCLUDED
- Postgres / Redis / message queue infra — SKIP dulu, cukup file-based

---

## 2. Impacted Applications

| Application | Impact Type | Description |
|-------------|-------------|-------------|
| `openclaw-hub` (Next.js FE) | **New** | Web UI: dashboard, session detail, orchestration graph |
| `openclaw-hub-api` (Fastify BE) | **New** | REST + SSE + WebSocket, spawn `claude` subprocess via tmux |
| `~/Codes/claude-cli-bridge/` | **Reference** | Baca sebagai pattern reference, tidak dimodifikasi |
| `~/.local/bin/nafu-bg-claude` | **Reference** | Pattern reference untuk tmux spawn + JSONL tail |
| `~/.claude/projects/<cwd>/*.jsonl` | **Consumed** | Read-only tail untuk session transcript stream |

---

## 3. Requirements Overview

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-01 | User dapat spawn Claude session dari web UI dengan prompt awal | Must Have |
| FR-02 | Setiap session di-track: status (active/waiting/done/failed), tmux name, JSONL path, tokens, cost | Must Have |
| FR-03 | Real-time stream event JSONL dari Claude ke browser via SSE | Must Have |
| FR-04 | User dapat lihat parent-child session (delegation) sebagai DAG di React Flow | Must Have |
| FR-05 | User dapat kill running session dari UI (kill-session tmux) | Must Have |
| FR-06 | Session history persist across restart — resume via `claude --resume <uuid>` | Must Have |
| FR-07 | User dapat register project (path folder) sebagai workspace untuk session | Must Have |
| FR-08 | Pool limit (max N concurrent subprocess) — reject spawn kalau full | Should Have |
| FR-09 | Session search (filter by project, status, date, tag) | Should Have |
| FR-10 | Support CLI adapter: Codex, OpenCode, Aider (via config, extensible) | Nice to Have |
| FR-11 | Scheduled agent runs (cron-style, mirip Tycho's `schedules/`) | Nice to Have |

### Non-Functional Requirements

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-01 | Session spawn latency | < 3s (tmux boot + TUI ready) |
| NFR-02 | JSONL event streaming latency | < 200ms (tail → SSE → browser) |
| NFR-03 | Max concurrent sessions | 20 subprocess (configurable) |
| NFR-04 | Storage | File-based, atomic write, `.bak` recovery |
| NFR-05 | Portability | Copy `~/.openclaw-hub/` folder = full backup |
| NFR-06 | Dev bootstrap | `pnpm i && pnpm dev` → running dalam < 30s |
| NFR-07 | No API credit consumed | Interactive TUI mode only, verify via Anthropic dashboard |

---

## 4. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (Next.js 15)                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ Dashboard    │  │ Session View │  │ Orchestration Graph    │ │
│  │ (session grid)│  │ (log stream) │  │ (React Flow DAG)       │ │
│  └──────────────┘  └──────────────┘  └────────────────────────┘ │
└────────────────────┬────────────────────────────────────────────┘
                     │ SSE (event stream) + WebSocket (control)
                     │ HTTP REST (CRUD)
                     ▼
┌─────────────────────────────────────────────────────────────────┐
│  Fastify 5 API Server (localhost:8080)                           │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │  Routes: /api/sessions, /api/projects, /api/stream/:id    │   │
│  └───────────────────────────────────────────────────────────┘   │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │  Services:                                                 │   │
│  │  - AgentPool (spawn/kill, max concurrent)                 │   │
│  │  - SessionRegistry (file-based FileStore)                 │   │
│  │  - TranscriptTailer (fs.watch JSONL → EventEmitter)       │   │
│  │  - DelegationTracker (parent-child DAG)                   │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────┬─────────────────────────────┬────────────────────────┘
           │                             │
           │ FileStore                   │ spawn tmux + send-keys
           ▼                             ▼
   ┌───────────────────┐         ┌─────────────────────────────┐
   │ ~/.openclaw-hub/  │         │ tmux sessions               │
   │  config/hq.yml    │         │  agent-<uuid>-1  claude ... │
   │  sessions/*.json  │         │  agent-<uuid>-2  claude ... │
   │  sessions/*.jsonl │         │  ...                        │
   │  projects/*.json  │         └─────────────────────────────┘
   │  delegation/*.json│                     │
   └───────────────────┘                     ▼
                                  ┌──────────────────────────┐
                                  │ ~/.claude/projects/      │
                                  │  <mangled-cwd>/          │
                                  │    <session-uuid>.jsonl  │ ← tail
                                  └──────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|----------------|
| **AgentPool** | Track running subprocess (Map<sessionId, AgentProcess>), enforce max concurrent, kill on-demand |
| **SessionRegistry** | CRUD session metadata via `FileStore` (atomic JSON write + `.bak`) |
| **TranscriptTailer** | Watch `~/.claude/projects/<cwd>/<uuid>.jsonl` from offset, emit events via EventEmitter |
| **DelegationTracker** | Maintain parent-child edges (source-of-truth JSON file, in-memory index) |
| **FileStore** | Atomic write (tmp → fsync → rename + fsync_dir), `.bak` backup, JSON recovery |

---

## 5. Technical Implementation

### 5.1 Repository Structure (Monorepo)

```
openclaw-hub/
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── turbo.json                    # Turborepo pipeline
├── .env.example
├── README.md
├── docs/
│   ├── HLD.md                    # this doc
│   ├── REPORT.md                 # tycho research
│   └── ADR/                      # decisions
├── packages/
│   ├── shared/                   # Types shared FE ↔ BE
│   │   ├── src/types.ts          # AgentConfig, SessionEvent, etc.
│   │   └── package.json
│   └── file-store/               # Port of Tycho's HQ::FileStore ke TS
│       ├── src/index.ts
│       └── package.json
├── apps/
│   ├── web/                      # Next.js 15 App Router
│   │   ├── app/
│   │   │   ├── page.tsx          # Dashboard
│   │   │   ├── session/[id]/     # Session detail
│   │   │   ├── graph/            # Orchestration DAG
│   │   │   └── projects/         # Project registry
│   │   ├── components/ui/        # shadcn/ui
│   │   ├── lib/api.ts            # Fetch wrapper
│   │   └── package.json
│   └── api/                      # Fastify 5 backend
│       ├── src/
│       │   ├── server.ts         # Fastify entry
│       │   ├── routes/
│       │   │   ├── sessions.ts
│       │   │   ├── projects.ts
│       │   │   └── stream.ts     # SSE
│       │   ├── services/
│       │   │   ├── agent-pool.ts
│       │   │   ├── session-registry.ts
│       │   │   ├── transcript-tailer.ts
│       │   │   └── delegation-tracker.ts
│       │   ├── adapters/
│       │   │   ├── claude.ts     # tmux + claude CLI
│       │   │   ├── codex.ts      # future
│       │   │   └── opencode.ts   # future
│       │   └── file-store/       # Wrap @openclaw-hub/file-store
│       └── package.json
└── scripts/
    ├── dev.sh                    # Concurrent FE + BE dev
    └── init.sh                   # Init ~/.openclaw-hub/
```

### 5.2 Data Model — File-Based (Tycho Pattern)

**Storage root:** `~/.openclaw-hub/`

```
~/.openclaw-hub/
├── config/
│   ├── hq.yml                    # Projects, agent templates, defaults
│   └── hq.yml.bak
├── sessions/
│   ├── <session-uuid>.json       # metadata
│   ├── <session-uuid>.json.bak
│   └── <session-uuid>.jsonl      # append-only event log (mirror JSONL Claude)
├── projects/
│   ├── <project-uuid>.json
│   └── <project-uuid>.json.bak
├── delegation/
│   └── edges.json                # parent-child adjacency list
└── logs/
    └── api-YYYY-MM-DD.log
```

**Session metadata schema (JSON):**

```typescript
interface SessionMetadata {
  id: string                          // internal session UUID
  projectId: string
  agentType: 'claude' | 'codex' | 'opencode'
  status: 'active' | 'waiting' | 'completed' | 'failed'
  parentSessionId: string | null      // delegation
  claudeSessionUuid: string           // --session-id value for `claude`
  tmuxName: string                    // agent-<hex>
  jsonlPath: string                   // ~/.claude/projects/<cwd>/<uuid>.jsonl
  initialPrompt: string
  finalResponse: string | null
  tokenUsage: { input: number; output: number } | null
  costUsd: number | null              // 0 kalau subscription
  startedAt: string                   // ISO
  endedAt: string | null
  metadata: Record<string, unknown>
}
```

**Delegation edges schema:**

```typescript
interface DelegationEdges {
  version: 1
  edges: Array<{ parent: string; child: string; createdAt: string }>
}
```

### 5.3 CLI Adapter Pattern — Interactive TUI Only

```typescript
// packages/shared/src/types.ts
export interface AgentAdapter {
  name: string
  spawn(config: SpawnConfig): Promise<TmuxHandle>
  resume(sessionUuid: string, config: ResumeConfig): Promise<TmuxHandle>
  sendPrompt(handle: TmuxHandle, prompt: string): Promise<void>
  waitTuiReady(handle: TmuxHandle, timeoutMs: number): Promise<void>
  kill(handle: TmuxHandle): Promise<void>
}

// apps/api/src/adapters/claude.ts
export const claudeAdapter: AgentAdapter = {
  name: 'claude',
  async spawn(config) {
    const tmuxName = `agent-${randomId(8)}`
    const claudeUuid = crypto.randomUUID()

    // spawn interactive claude via tmux — NO claude -p
    await execFile('tmux', [
      'new-session', '-d', '-s', tmuxName,
      '-x', '220', '-y', '50',
      '-c', config.workspace,
      'env', `CLAUDE_CONFIG_DIR=${config.configDir}`,
      'claude',
      '--model', config.model,
      '--permission-mode', 'bypassPermissions',
      '--session-id', claudeUuid,
    ])

    return { tmuxName, claudeUuid, jsonlPath: resolveJsonlPath(config, claudeUuid) }
  },
  // ...
}
```

### 5.4 API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/sessions` | Spawn new session `{ projectId, agentType, prompt, parentSessionId? }` |
| GET | `/api/sessions` | List all sessions (filter by status/project/date) |
| GET | `/api/sessions/:id` | Get single session detail |
| DELETE | `/api/sessions/:id` | Kill running session |
| POST | `/api/sessions/:id/input` | Send follow-up prompt to running session |
| GET | `/api/stream/:id` | **SSE** — stream JSONL events for session |
| GET | `/api/graph` | Full delegation graph `{ nodes, edges }` |
| GET | `/api/projects` | List registered projects |
| POST | `/api/projects` | Register new project `{ name, path, agentType, config }` |
| GET | `/api/health` | Liveness — check tmux available, storage writable |

### 5.5 Real-time Streaming — SSE (Simple, Server-Push)

```typescript
// apps/api/src/routes/stream.ts
fastify.get('/api/stream/:id', async (req, reply) => {
  const { id } = req.params
  reply.raw.setHeader('Content-Type', 'text/event-stream')
  reply.raw.setHeader('Cache-Control', 'no-cache')
  reply.raw.setHeader('Connection', 'keep-alive')

  const tailer = transcriptTailer.subscribe(id)
  tailer.on('event', (evt) => {
    reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`)
  })
  tailer.on('end', () => reply.raw.end())

  req.raw.on('close', () => tailer.unsubscribe())
})
```

**Kenapa SSE bukan WebSocket:**
- Streaming JSONL = uni-directional (server → client) → SSE cocok
- Native `EventSource` di browser, no lib
- Auto-reconnect built-in
- WebSocket cuma untuk control command (kill, send follow-up) — separate endpoint

---

## 6. Testing Strategy

| Layer | Coverage | Tool |
|-------|----------|------|
| Unit | FileStore atomic write, adapter contract, DAG builder | Vitest |
| Integration | Spawn tmux → wait TUI → paste prompt → assert JSONL event received | Vitest + real tmux |
| E2E | Playwright: register project, spawn session, watch stream, kill | Playwright |
| Contract | Zod schema validation antara FE ↔ BE | Zod + shared types |

**Kritis:**
- FileStore concurrent write test (2 process bareng — atomic rename harusnya ok, tapi verify)
- Tmux crash recovery (session hilang di tengah → status auto → `failed`)
- JSONL tailer offset tracking (restart API server → resume dari offset lama, jangan duplicate emit)

---

## 7. Deployment Plan

### 7.1 Prerequisites

- Node.js ≥ 20 (LTS)
- pnpm ≥ 9
- tmux ≥ 3.0
- `claude` CLI installed + authenticated (Adi's Claude Pro/Max subscription)
- `~/.claude/` dan `~/.openclaw-hub/` writable
- macOS / Linux (Windows via WSL only)

### 7.2 Phases

**Phase 0: Bootstrap (Day 1)**
- Scaffold monorepo (Turborepo + pnpm workspaces)
- Setup Fastify hello world + Next.js hello world
- FileStore package port from Tycho `HQ::FileStore`

**Phase 1: MVP CLI Bridge (Week 1)**
- Claude adapter (tmux spawn + send-keys + wait TUI)
- SessionRegistry + FileStore
- SSE endpoint + basic web dashboard (list sessions, spawn button)
- Manual test: 1 session spawn → stream → complete

**Phase 2: DAG + Delegation (Week 2)**
- DelegationTracker (parent-child edges)
- React Flow orchestration graph page
- Support `--resume` untuk existing session

**Phase 3: Polish + Extensibility (Week 3)**
- Codex + OpenCode adapters
- Session search / filter UI
- Scheduled runs (cron)
- README + install script

### 7.3 Local Distribution

- `pnpm build` → build FE + BE
- `pnpm start` → run localhost:3000 (FE) + localhost:8080 (BE)
- systemd user unit template (opt-in) untuk auto-start
- Optional: Electron shell (Phase 4, kalau butuh desktop app)

### 7.4 Rollback

Personal tool — rollback = `git checkout <prev-tag>` + `pnpm i`. Data di `~/.openclaw-hub/` compatible across versions (atomic JSON, backward-compat schema).

---

## 8. Risk, Limitations & Out of Scope

### 8.1 Out of Scope

- Multi-user / auth / team dashboard
- Cloud hosting (fully local desktop tool)
- Windows native (WSL only)
- `claude -p` / SDK mode (**EXPLICITLY EXCLUDED** — consume API credit)
- Postgres / Redis (skip Phase 1-3, cuma kalau jadi multi-user product)
- Anthropic API key management (pakai `claude` CLI's own auth via subscription)

### 8.2 Known Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| tmux TUI ready detection race condition | Medium | Session spawn timeout | Poll pane with `❯` / `│ >` regex + retry paste up to 3x (persis pattern bridge.py) |
| Claude JSONL schema berubah upstream | Low | Tailer parse error | Zod schema validation + fallback ke raw text |
| Concurrent write ke `edges.json` (2 subprocess selesai bareng) | Medium | File corrupt | Atomic write + advisory lock (`proper-lockfile`) |
| Filesystem full → JSONL append gagal | Low | Session data lost | Pre-check disk space, log warning, dispatch alert |
| `claude` CLI upgrade break `--session-id` semantic | Medium | Resume broken | Pin CLI version di README + regression test |
| User accidentally run `claude -p` di adapter | Low | Bill API credit | Enforce di adapter (assertion: never `-p` in argv) |

### 8.3 Design Limitations

- **File-based storage tidak cocok** kalau > 10K session (list scan lambat) → migration path ke SQLite (Phase 2 post-MVP)
- **Single-machine only** — no distributed session (out of scope)
- **No live collaboration** — session state cuma untuk 1 user

### 8.4 Edge Cases Not Handled

- Tmux session hijack (kalau user attach + type manual di tmux) — expected: state jadi corrupt, mark session failed
- `claude` CLI crash mid-stream — tailer detect end + no `end_turn` → status auto-failed
- Long-running session (> 24 jam) — no soft-limit, user manual kill

---

## 9. Open Items

- **Name:** `openclaw-hub` (draft) — Adi setuju? Alternative: `nafu-hub`, `agent-hq`, `orchestron`
- **Fork or rewrite?** Tycho MIT license — bisa fork + swap TUI → web. Trade-off: Ruby ecosystem vs full TS. Rekomendasi: **rewrite** karena Adi mau TS.
- **Adapter for `codex` CLI**: apakah OpenAI Codex CLI juga pakai `--session-id` pattern? Perlu spike.
- **Scheduled runs** (Phase 3): simple cron di Node atau delegate ke systemd timer?
- **Storage location default**: `~/.openclaw-hub/` (mimic `~/.tycho/`) vs `~/.config/openclaw-hub/` (XDG)? — rekomendasi `~/.openclaw-hub/` untuk konsistensi Tycho.

---

## 10. Assumptions

- Adi's Claude Pro/Max subscription tetap valid — otherwise `claude` CLI tidak bisa auth
- tmux akan tetap ada di macOS/Linux dev environment
- `~/.claude/projects/<mangled-cwd>/*.jsonl` format tidak berubah drastis di future Claude CLI versions
- Adi sanggup maintain single-person side project ini (no team review needed)

---

## 11. Appendix

### 11.1 Reference Implementations

- Tycho (Ruby): `github.com/firewalker06/tycho`
- claude-cli-bridge (Python): `~/Codes/claude-cli-bridge/`
- nafu-bg-claude (Python): `~/.local/bin/nafu-bg-claude` → `~/.openclaw/agents/nafutech/workspace/nafu-bg-claude`
- Shannon (TypeScript ref for tmux+JSONL): `github.com/dexhorthy/shannon`

### 11.2 Naming Convention

- `openclaw-hub` = repo name (project)
- `~/.openclaw-hub/` = user data folder
- `agent-<hex>` = tmux session name
- `<session-uuid>` = internal session ID (UUID v4)
- `<claude-session-uuid>` = Claude CLI's session ID (passed via `--session-id`)
