# Deployment Guide

Practical step-by-step deploy instructions untuk agent-hq-orchestron.

Referensi arsitektur: [HLD](feature/agent-hq-orchestron/HLD-agent-hq-orchestron.md) — section "Deployment Plan" (target-level analysis), "Deployment Scenarios" (host profile), "Multi-Instance Topology" (single vs federation).

---

## 1. Prerequisites

Wajib present di host:

| Requirement | Min Version | Check | Install (Debian/Ubuntu) |
|---|---|---|---|
| `node` | 20 LTS | `node --version` | `curl -fsSL https://deb.nodesource.com/setup_20.x \| sudo -E bash - && sudo apt install nodejs` |
| `npm` | 10 | `npm --version` | bundled with node |
| `tmux` | 3.2 | `tmux -V` | `sudo apt install tmux` |
| `git` | 2.40 | `git --version` | `sudo apt install git` |
| `claude` CLI | latest | `claude --version` | `curl -fsSL https://claude.ai/install.sh \| bash` |
| Anthropic auth | subscription (Pro/Max) | `claude` (interactive prompt) | run `claude` interactively di TTY, follow browser OAuth |

Optional (fitur akan graceful-degrade kalau absent):

| Optional | Purpose | Notes |
|---|---|---|
| `gh` CLI | GitHub PR/issue context di prompt template | `gh auth login` first |
| `bb` CLI (or `curl` + env `BITBUCKET_APP_PASSWORD`) | Bitbucket PR/issue context | Same idea |
| `tailscale` | Remote access + QR onboarding host resolver | `curl -fsSL https://tailscale.com/install.sh \| sh` |
| `codex` / `opencode` | Codex + OpenCode adapters | Adapter disabled kalau binary absent |

Verify semua at once:

```bash
orchestron doctor
```

(Available setelah `npm link` — see step 3.)

---

## 2. Clone + Install

```bash
git clone git@github.com:adinovri/agent-hq-orchestron.git
cd agent-hq-orchestron

# Node 20 required
node --version   # v20.x.x

# Install deps for all workspaces
npm install

# Build all packages + apps
npm run build
```

Build takes ~30 sec cold. Turborepo caches subsequent builds (~2 sec).

---

## 3. Initialize Data Directory

```bash
bash scripts/init.sh
```

Creates `~/.config/agent-hq-orchestron/`:
```
~/.config/agent-hq-orchestron/
├── sessions/       # session records (JSON)
├── projects/       # project registry (JSON)
├── delegation/     # parent-child edges (JSONL append-only)
├── logs/           # api-YYYY-MM-DD.log, hooks-YYYY-MM-DD.jsonl
├── metrics/        # sessions.jsonl (aggregate rollup source)
├── templates/      # prompt templates (markdown w/ frontmatter)
├── hooks/          # pre-spawn/, post-transcript-chunk/, etc.
├── worktrees/      # snapshot cleanup ledger
└── cache/gh/       # PR metadata cache
```

Optionally link CLI globally:

```bash
cd apps/cli
npm link
which orchestron   # /usr/local/bin/orchestron (or similar)
orchestron --version
```

---

## 4. Configure

Two ways — pick one:

### Option A: Env vars

```bash
export ORCHESTRON_BIND_HOST=127.0.0.1
export ORCHESTRON_PORT=8080
export ORCHESTRON_MAX_CONCURRENT=8
export ORCHESTRON_LOG_LEVEL=info
```

### Option B: Config file

`~/.config/agent-hq-orchestron/config.json`:
```json
{
  "bindHost": "127.0.0.1",
  "port": 8080,
  "maxConcurrent": 8,
  "logLevel": "info",
  "adapters": {
    "claude": true,
    "codex": false,
    "opencode": false
  }
}
```

Precedence: env > config file > built-in defaults.

**Auto-detected default `maxConcurrent`**: `floor(totalmem_MB / 800)`, capped at 20. Overrideable.

---

## 5. Deploy — Scenario A: Laptop Personal

Simplest — localhost only, no auth. Ada dua run mode.

### 5a. Dev mode (development, hot-reload)

```bash
npm run dev
```

Yang jalan:
- **API** (`apps/api`): `tsx watch src/server.ts` — TypeScript langsung tanpa compile, hot-reload saat edit
- **Web** (`apps/web`): `next dev` — HMR, source maps, unminified bundles
- Startup ~2-3s, restart otomatis saat file berubah

Kapan pakai: development, ngoprek code, debugging feature.

### 5b. Production build (stable, faster)

```bash
# Step 1 — compile semua workspace ke dist/
# NEXT_PUBLIC_API_URL only needed when API is bound to a non-loopback
# interface (e.g. tailscale IP). Since 33a8830, next.config.ts auto-reads
# from ~/.orchestron/config.json when the env var is unset, so a bare
# `npm run build` also picks the right target. Setting it explicitly is
# still fine and takes precedence.
NEXT_PUBLIC_API_URL=http://127.0.0.1:8090 \
  npm run build --workspaces --if-present

# Step 2 — run compiled artifacts
npm run start
```

Yang terjadi saat `npm run build`:
- `packages/shared`, `packages/file-store` → `tsup` bundle ke `dist/index.js` + type declarations
- `apps/api` → `tsc` compile ke `apps/api/dist/*.js` (plain runnable Node)
- `apps/web` → `next build` produce optimized bundle (SSR pre-compiled, client minified, static assets fingerprinted)

Yang terjadi saat `npm run start`:
- `node apps/api/dist/server.js` — fast startup ~100ms
- `next start -p 3000` — serves pre-built bundles

Characteristics: fast startup, small bundle, JSON logs (no pretty-print), no file watcher, lower baseline CPU/RAM.

Kapan pakai: **daily driver**, stable use, systemd service target.

**Update cycle** (kalau code berubah — git pull, dst):
```bash
git pull origin main
npm install
npm run build --workspaces --if-present
# Restart process (kalau via systemd: systemctl --user restart orchestron)
```

### Open UI

Kedua mode buka http://localhost:3000 di browser laptop.

**Constraint:**

- **Akses lokal saja.** Bind `127.0.0.1` — HP/tablet/laptop lain di WiFi yang sama tidak bisa connect (connection refused). Cuma browser/CLI di laptop yang sama.
- **No auth layer.** Siapapun yang bisa buka terminal/browser di laptop ini akses semua endpoint tanpa login. Trade-off intentional: single-user laptop = trusted zone.
- **Live subprocess ephemeral saat reboot.** File-based state (session records, transcripts, project registry, metrics) **persist forever**. Yang mati saat reboot / `tmux kill-server` = live `claude` subprocess. Session status yang tadinya `running` / `waiting` auto-transition ke `killed` dgn reason "orphaned" via boot-time orphan scanner. Terminal-state sessions (`completed`, `failed`, `killed`) fully persist — record + transcript readable selamanya.
- **Resumability.** In-flight session yang mati bisa dilanjut: `orchestron session resume <uuid>` → invoke `claude --resume <uuid>` yang restore context dari transcript. Konversasi lanjut seolah tidak putus.
- **API call fail saat offline.** Kalau laptop offline (WiFi off) atau sleep, API call `claude` ke Anthropic timeout — session yang lagi thinking transisi ke `failed`. Tapi transcript sampai poin timeout tetap persist.

---

## 6. Deploy — Scenario B: Home Server + Remote Access

Adi's actual server profile: 4 vCPU, 7.8 GB RAM, 58 GB disk. Capacity: **8-12 concurrent sessions** (RAM constrained). Refer HLD "Deployment Scenarios" untuk detail.

### 6a. Generate Bearer Token

```bash
orchestron token generate
# Output: 48-char hex
export ORCHESTRON_REMOTE_TOKEN="<paste>"
```

Or write ke `~/.orchestron.env`:
```bash
ORCHESTRON_REMOTE_TOKEN=<hex-token>
ORCHESTRON_BIND_HOST=100.x.y.z   # Tailscale IP or 0.0.0.0
ORCHESTRON_PORT=8080
```

**Boot guard**: kalau bind non-loopback (`0.0.0.0`, Tailscale IP, dst) dan `ORCHESTRON_REMOTE_TOKEN` unset → server refuse to start. Fail-fast.

### 6b. Install as systemd user service

Create `~/.config/systemd/user/orchestron.service`:

```ini
[Unit]
Description=Orchestron API server
After=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.orchestron.env
ExecStart=%h/.local/bin/orchestron serve
WorkingDirectory=%h/Works/agent-hq-orchestron
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Enable + start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now orchestron.service
systemctl --user status orchestron.service
```

Persistent across boots requires linger:
```bash
sudo loginctl enable-linger $USER
```

### 6c. Tailscale (recommended for remote)

```bash
sudo tailscale up
tailscale ip -4   # note the IP, e.g. 100.71.6.23
```

Update `~/.orchestron.env`:
```bash
ORCHESTRON_BIND_HOST=100.71.6.23
```

Restart service:
```bash
systemctl --user restart orchestron.service
```

### 6d. QR Onboarding untuk Mobile

```bash
orchestron qr
```

Render QR di terminal berisi `https://100.71.6.23:8080/pair?token=<hex>`. Scan dari HP → auto-open Web UI dengan token pre-filled ke sessionStorage → PWA install prompt.

**Warning:** QR contains full-access token — jangan screen-share saat generate.

### 6e. Rsync Backup (fallback plan)

Kalau server crash / disk full, punya fallback lokal. Setup nightly rsync ke laptop:

```bash
# Di laptop
crontab -e
# Add line:
0 2 * * * rsync -a --delete <server-ip>:~/.config/agent-hq-orchestron/ ~/orchestron-backup/
```

---

## 7. Deploy — Scenario C: Server-Only + Thin Client

Kalau laptop **tidak** perlu jalanin orchestron sendiri — akses semua via browser/PWA ke server.

- Server-side: setup Scenario B
- Laptop-side: **tidak install apa-apa**. Buka https://100.71.6.23:8080/pair?token=<hex> di browser once → PWA installable → shortcut jadi native app di dock.

Trade-off: server / Tailscale down = complete outage. Airplane mode = tidak bisa work.

---

## 7b. Deploy — Dual-Instance (Laptop + Server, keduanya jalan)

Kalau lu butuh **akses orchestron di laptop DAN di server** — pakai kedua-duanya independent. Setup: dua instance orchestron running paralel, state terpisah.

### Kenapa Dual (bukan Scenario B server-only atau A laptop-only)?

Use case: lu kerja di kafe → laptop only (server unreachable). Balik ke rumah → server (untuk supervisi long-running session dari HP). Kadang lu di depan laptop tapi mau spawn session yang ke-track di server (biar bisa lu monitor dari HP nanti).

### Konsekuensi penting

- **State terpisah total.** Sessions yang spawn di laptop **tidak muncul** di server UI, dan sebaliknya. Setiap instance punya `~/.config/agent-hq-orchestron/` sendiri di host masing-masing.
- **Tidak ada auto-sync.** Kalau lu spawn session A di laptop, session A cuma ada di laptop. Server tidak tahu.
- **No cross-host resume.** Session yang started di laptop tidak bisa di-resume dari server (transcript file di `~/.claude/projects/` juga host-specific).
- **Federation view = pending feature.** HLD Multi-Instance Topology Option 2 (peer registry + read-only cross-instance view) belum di-implement — laptop UI hanya show local sessions, tidak show server sessions.

### Setup

**Server** (setup pertama):
- Follow Scenario B (Section 6) sepenuhnya
- Bind ke Tailscale IP + Bearer token + systemd service
- Contoh URL: `https://100.71.6.23:8080`

**Laptop** (setup kedua):
- Follow Scenario A (Section 5, prefer 5b production build untuk stability)
- Bind ke `127.0.0.1` (localhost), **no token** — laptop lu trusted zone
- Port beda dari server tidak masalah (localhost:8080 di laptop tidak clash dgn server-tailscale-ip:8080 di server)
- Optional: install systemd user service di laptop juga supaya auto-start on boot

### Cara akses

- **Sessions di laptop**: buka `http://localhost:3000` di browser laptop
- **Sessions di server**: buka `https://100.71.6.23:8080` (Tailscale HTTPS) di browser mana aja — laptop, HP via PWA, tablet
- **Pilih mana yang jalankan session**: sadar sebelum spawn. Rule of thumb:
  - **Short interactive session** yang lu supervise langsung → laptop
  - **Long-running session** yang mau lu tinggal + monitor via HP → server
  - **Sensitive session** yang butuh workspace file lokal laptop → laptop
  - **Batch/scheduled runs** (via `orchestron schedule daemon`) → server (biar bisa jalan 24/7)

### Mitigasi state split

Karena state terpisah, backup + occasional consolidate:

**Rsync nightly server → laptop archive** (kalau lu mau one-way backup):
```bash
# Di laptop crontab:
0 2 * * * rsync -a --exclude='*.tmp' \
  <server-ip>:~/.config/agent-hq-orchestron/ \
  ~/orchestron-server-archive/
```

Ini bukan sync — cuma backup buat lu bisa browse server session dari laptop offline (via CLI `orchestron project list --data-dir ~/orchestron-server-archive`).

**Federation view (v2, belum ada)**: kalau nanti Option 2 di HLD Multi-Instance Topology di-implement, laptop UI bisa render peer server sessions read-only via `peers.json` config. Untuk sekarang, manual switch browser tab.

### Anti-pattern: Two-way sync

**JANGAN** sync `~/.config/agent-hq-orchestron/` bidirectional (Syncthing/rsync dua arah) — HLD Multi-Instance Topology explicit mark ini sebagai anti-pattern. Race condition kedua sisi nulis `sessions/*.json` bersamaan = corrupt data. Pakai federation view kalau butuh cross-visibility, atau accept state split.

---

## 8. Post-Deploy Verification

```bash
# Doctor check
orchestron doctor

# API health
curl -H "Authorization: Bearer $ORCHESTRON_REMOTE_TOKEN" \
  http://100.71.6.23:8080/api/health

# Web UI
open http://100.71.6.23:8080  # atau http://localhost:3000 kalau dev

# Verify test suite passes
npm test
```

Expected `/api/health` response:
```json
{
  "ok": true,
  "tmux": "tmux 3.4",
  "storage": "/home/adi/.config/agent-hq-orchestron",
  "bindHost": "100.71.6.23",
  "remoteAuth": "enabled",
  "maxConcurrent": 8
}
```

---

## 9. Register First Project

Via CLI:
```bash
orchestron project add \
  --name nanovest-backend \
  --path ~/Works/nanovest-backend \
  --agent claude \
  --config-dir ~/ClaudeConfigs/adi.novriansyah
```

Or via Web UI: Dashboard → "Register Project" button.

---

## 10. Common Operations

### Spawn Session

CLI:
```bash
orchestron session spawn \
  --project nanovest-backend \
  --template refactor \
  --var target=CryptoBuyService.java
```

Web UI: Dashboard → "Spawn Session" → pick project + template + fill vars.

### Watch Metrics

```bash
orchestron metrics --group-by project --from 2026-09-01 --json
```

Or Web UI: `/metrics` route.

### TUI Dashboard

```bash
orchestron tui
```

Keyboard: `j`/`k` navigate, `Enter` open session, `k` kill, `n` new, `q` quit.

### Update Templates

Template file live di `~/.config/agent-hq-orchestron/templates/<name>.md`:

```markdown
---
name: refactor
description: Standard refactor prompt with git context
variables:
  target: { type: string, required: true, prompt: "File/module to refactor?" }
---
Refactor `{{target}}` in `{{project.name}}` (branch: `{{git.branch}}`).

Recent commits:
{{git.log-5}}

Current diff:
```diff
{{git.diff}}
```
```

Reload otomatis pada next spawn — no restart needed.

### Add Hook

Bikin script di `~/.config/agent-hq-orchestron/hooks/pre-spawn/enforce-no-secrets.ts`:

```typescript
import { readFile } from 'node:fs/promises';
const payload = JSON.parse(await readFile(0, 'utf8'));
const banned = ['sk-ant-', 'sk-', 'ghp_', 'AKIA'];
if (banned.some(p => payload.prompt.includes(p))) {
  console.error(`refusing spawn: prompt contains secret-like token`);
  process.exit(1);
}
```

Chmod +x. Auto-discovered pada next spawn.

---

## 11. Upgrade / Redeploy

```bash
cd ~/Works/agent-hq-orchestron
git pull origin main
npm install
npm run build

# Restart service
systemctl --user restart orchestron.service

# Verify
systemctl --user status orchestron.service
orchestron doctor
```

Data schema is additive (Zod schema evolution) — old JSON files always readable.

---

## 12. Troubleshooting

| Symptom | Diagnose | Fix |
|---|---|---|
| `EADDRINUSE :8080` | Port already used | `lsof -i:8080` → kill or change `ORCHESTRON_PORT` |
| Boot guard error `refusing to bind` | Non-loopback + no token | Set `ORCHESTRON_REMOTE_TOKEN` env |
| `401 Unauthorized` | Missing/wrong Bearer header | Verify token, check WS uses `?token=` param |
| Sessions stuck `spawning` | tmux marker not detected | Check `claude` CLI authenticated; run `claude` manually to verify |
| Empty metrics | No completed sessions yet | Spawn session → wait for `on-session-end` → refresh `/metrics` |
| Web UI blank | Service worker stale | Ctrl+Shift+R hard reload; or clear site data |
| Orphan tmux sessions | Server killed mid-session | Restart server → orphan-scanner cleans automatically |

Logs:
```bash
tail -f ~/.config/agent-hq-orchestron/logs/api-$(date +%F).log
journalctl --user -u orchestron.service -f
```

---

## 12b. Troubleshooting quick-hits

### Settings page shows "HTTP 500: Internal Server Error"

Web app's `/api/*` rewrite is targeting a host that isn't listening.
Common cause: rebuilt `apps/web` without `NEXT_PUBLIC_API_URL` while the
API bound to a non-loopback interface (e.g. tailscale IP).

- Since commit `33a8830`, `next.config.ts` falls back to reading
  `bindHost`+`port` from `~/.orchestron/config.json` so a bare
  `npm run build` also picks the right target.
- Verify baked URL: `grep -o '127.0.0.1:8090\|<your-ip>:8090' apps/web/.next/routes-manifest.json | sort | uniq -c`
- Rebuild with explicit env if needed:
  `NEXT_PUBLIC_API_URL=http://<api-host>:8090 npm run build --workspace @agent-hq-orchestron/web`

Watch the web journal on start:
```
journalctl --user -u orchestron-web.service | grep 'next.config'
# → [next.config] Rewriting /api/* → http://100.82.168.18:8090
```

### PWA / Service Worker stuck on old bundle

Visit `/api/reset` — the endpoint is served by the API (bypasses SW) and
runs a small page that:

1. Unregisters every service worker.
2. Deletes every `caches.open()` cache.
3. Clears `localStorage`, `sessionStorage`, and `indexedDB.databases()`.
4. Redirects to `/pair` after 3 s.

Alternatively: Chrome DevTools → Application → Clear site data.

### Session stuck on `running` status

The transcript polling endpoint has a safety-net that reconciles this
automatically — but only when the latest `turn_duration` event was
written AFTER the latest user prompt. If Claude interrupt writes
`[Request interrupted by user]` with no `turn_duration`, the
`/interrupt` endpoint proactively transitions to `idle`. If it still
looks stuck, kill from the dashboard.

### "Cannot find pane" on spawn

Transient Claude auth/quota failure at tmux boot. `completeSpawn` auto-
retries once with a fresh Claude session UUID; if it fails again, check:

- `claude` CLI can start interactively (`claude` in a plain terminal)
- Claude subscription is not exhausted
- tmux version (`tmux -V` must be ≥ 3.2)

---

## 13. Uninstall

```bash
# Stop + disable service
systemctl --user disable --now orchestron.service
rm ~/.config/systemd/user/orchestron.service

# Unlink CLI
cd ~/Works/agent-hq-orchestron/apps/cli && npm unlink -g

# Remove data (⚠ irreversible — backup first if needed)
rm -rf ~/.config/agent-hq-orchestron/

# Remove repo
rm -rf ~/Works/agent-hq-orchestron/
```

---

## Appendix: Deployment Scenarios Matrix

Ringkas — detail di HLD "Deployment Scenarios":

| Scenario | Host | Auth | Concurrent | Fit |
|---|---|---|---|---|
| **A** — Laptop | Localhost | None | 10-15 | Baseline, offline-first |
| **B** — Home Server + Tailscale | Server + PWA | Bearer + Tailscale | 8-12 | Adi's actual setup (recommended) |
| **C** — Server-only + Thin Client | Server only | Bearer + Tailscale | 8-12 | If always-online |
| **D** — Team Dashboard | Shared server | ⚠️ NOT SUPPORTED | — | Fork required — violates Non-Goals |
