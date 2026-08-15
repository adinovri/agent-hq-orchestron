# Scaffold Plan — agent-hq-orchestron

**Target:** `/home/scriberion/Works/agent-hq-orchestron/`
**Package manager:** **npm** (npm workspaces, not pnpm)
**Data folder:** `~/.config/agent-hq-orchestron/`
**Push:** Local only for now — future push to Adi's public GitHub with credit to Tycho reference
**Approach:** Background task via `nafu-bg-claude`, mengeksekusi step-by-step di bawah.

---

## Phase 0 — Repo Bootstrap (Day 1, ~2-3 jam autonomous)

### Step 0.1: Create repo folder + git init
```bash
mkdir -p ~/Works/openclaw-hub
cd ~/Works/openclaw-hub
git init -b main
```

### Step 0.2: Root config files
- `package.json` (monorepo root, private, workspaces)
- `pnpm-workspace.yaml`
- `tsconfig.base.json` (strict, ES2022, moduleResolution bundler)
- `turbo.json` (dev, build, lint, test pipelines)
- `.gitignore` (node_modules, .next, dist, .turbo, .env, ~/.openclaw-hub tempfiles)
- `.env.example`
- `.editorconfig`
- `.nvmrc` → `20`
- `README.md` (quickstart, dev command, arsitektur ringkas)
- `LICENSE` (MIT — same as Tycho reference)

### Step 0.3: Copy HLD + REPORT ke docs/
```bash
mkdir -p docs
cp ~/.openclaw/agents/nafutech/workspace/tasks/tycho-research/HLD.md docs/
cp ~/.openclaw/agents/nafutech/workspace/tasks/tycho-research/REPORT.md docs/
```

### Step 0.4: Scaffold packages/shared
- `package.json` name `@openclaw-hub/shared`
- `src/types.ts` — SessionMetadata, AgentAdapter, SpawnConfig, SessionEvent (dari HLD section 5)
- `src/schemas.ts` — Zod schemas untuk validation
- `tsup` config untuk build

### Step 0.5: Scaffold packages/file-store
- `package.json` name `@openclaw-hub/file-store`
- Port dari Ruby `HQ::FileStore`:
  - `writeJson(path, value)` — atomic tmp → fsync → rename + fsync_dir + `.bak`
  - `readJson(path, fallback)` — try main, fall back to `.bak`
  - `appendJsonl(path, event)` — append-only untuk event log
  - `readJsonlFrom(path, offset)` — read from offset ke EOF
- Deps: `write-file-atomic`, `proper-lockfile`
- Vitest test — verify atomic write, `.bak` recovery, concurrent write safety

### Step 0.6: Scaffold apps/api (Fastify)
- `package.json` name `@openclaw-hub/api`
- `src/server.ts` — Fastify instance, register CORS, sensible defaults
- Deps: `fastify`, `@fastify/sensible`, `@fastify/cors`, `@fastify/websocket`, `pino-pretty` (dev)
- `pnpm dev` → tsx watch, port 8080
- Hello route `/api/health` → `{ ok: true, tmux: 'x.y.z' }`

### Step 0.7: Scaffold apps/web (Next.js 15)
- `pnpm dlx create-next-app@latest apps/web --ts --app --tailwind --eslint --src-dir=false --import-alias='@/*'`
- Install shadcn/ui: `pnpm dlx shadcn@latest init` + button, card, dialog, table components
- Install React Flow: `pnpm add @xyflow/react`
- Install Zustand: `pnpm add zustand`
- Install SWR/TanStack Query: `pnpm add @tanstack/react-query`
- Rewrite `app/page.tsx` → placeholder dashboard
- `apps/web/package.json` → `dev` port 3000

### Step 0.8: Root scripts
- `scripts/dev.sh` → concurrent `pnpm --filter api dev` + `pnpm --filter web dev`
- `scripts/init.sh` → `mkdir -p ~/.openclaw-hub/{config,sessions,projects,delegation,logs}`

### Step 0.9: First commit
- `git add . && git commit -m "chore: initial scaffold (HLD + monorepo skeleton)"`
- **JANGAN push** (belum ada remote — Adi decide push atau tidak)

### Step 0.10: Smoke test
- `bash scripts/init.sh`
- `pnpm i`
- `pnpm dev` (background 20s) → curl `localhost:8080/api/health` + curl `localhost:3000`
- Kalau dua-duanya OK → phase 0 done

---

## Phase 1 — MVP CLI Bridge (Week 1, TIDAK di scope bg task ini)

Yang berikut ini SKIP dulu — tunggu Adi review Phase 0 scaffold.

- Implement `claudeAdapter` di `apps/api/src/adapters/claude.ts`
- Implement `AgentPool`, `SessionRegistry`, `TranscriptTailer`
- API endpoint POST /api/sessions + GET /api/stream/:id (SSE)
- Web dashboard: list sessions + spawn button
- Manual test: 1 session end-to-end

---

## Background Task Scope

**In scope untuk bg task:**
- Semua Step 0.1 – 0.10 (Phase 0 bootstrap)
- Commit lokal (jangan push)
- Smoke test verify FE + BE running

**Out of scope untuk bg task:**
- Phase 1 implementation logic (Adi review dulu Phase 0)
- Push ke Bitbucket (belum ada repo remote)
- npm publish

**Success criteria bg task:**
- `~/Works/openclaw-hub/` exists dengan struktur monorepo lengkap
- `pnpm dev` bisa jalan tanpa error
- `curl localhost:8080/api/health` return `{ ok: true, ... }`
- `curl localhost:3000` return HTML
- 1 initial git commit di branch `main`
- Notify Adi via Telegram: "Scaffold done — cek `~/Works/openclaw-hub/`"

---

## Approval Gate

**Sebelum spawn bg task, konfirmasi ke Adi:**

1. Repo name: `openclaw-hub` OK atau ganti (`nafu-hub`, `agent-hq`, `orchestron`)?
2. Location: `~/Works/openclaw-hub/` OK atau folder lain?
3. Package manager: pnpm (recommended) atau npm/bun?
4. Data folder: `~/.openclaw-hub/` OK atau XDG `~/.config/openclaw-hub/`?
5. Push ke Bitbucket sekalian? (default: no, cukup local)

---

## Timeline Estimasi bg task

- Phase 0 scaffold: **20-40 menit** autonomous (mostly pnpm install + create-next-app + component add)
- Smoke test: 5 menit
- Total: **< 1 jam** di bg
