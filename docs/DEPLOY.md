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

Simplest — localhost only, no auth.

```bash
# Run dev servers foreground (Ctrl+C to stop)
npm run dev

# Or production build
npm run build && npm run start
```

Open http://localhost:3000 di browser.

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
