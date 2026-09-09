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
| `codex` CLI | Codex adapter — install: `npm i -g @openai/codex` (or brew). Auth: `codex login` (ChatGPT Plus/Pro/Team subscription; API key opt-in). Config: `~/.codex/config.toml` (trust prompts persist here); override root with `CODEX_HOME` env | Adapter disabled kalau binary absent |
| `opencode` CLI | OpenCode adapter | Adapter disabled kalau binary absent |

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

Creates `~/.orchestron/`:
```
~/.orchestron/
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

**Ports at a glance:**

| Service | Code default | Systemd template (§6b) | Adi's setup |
|---|---|---|---|
| API (Fastify) | `8080` | `8090` | `8090` (via `config.json.port`) |
| Web (Next.js) | `3000` | `3010` | `3010` (via unit `PORT=3010` + `-p 3010`) |

The two dropped from `3000`/`8080` (Next / Fastify defaults) to
`3010`/`8090` in the systemd templates so orchestron doesn't clash
with a `next dev` on a sibling project (very common) or a random
tool on `:8080` (also very common — auth-status shows a Python
listener there on this host, unrelated to orchestron). Override
either via `ORCHESTRON_PORT` / `PORT` env or `config.json.port`.

Two ways — pick one:

### Option A: Env vars

```bash
export ORCHESTRON_BIND_HOST=127.0.0.1
export ORCHESTRON_PORT=8080
export ORCHESTRON_MAX_CONCURRENT=8
export ORCHESTRON_LOG_LEVEL=info
# Idle sweeper — sessions in idle/needs_input for longer than this are
# warm-shut-down (tmux released, status → 'sleeping'). 0 disables.
export ORCHESTRON_IDLE_TIMEOUT_MS=900000     # 15 min
# Shared Claude memory pool — every spawn/reopen/clone/respawn ensures
# <configDir>/projects/<mangled-cwd>/memory/ is a symlink here.
# Set to "" to disable the auto-symlink.
export ORCHESTRON_SHARED_MEMORY_DIR=~/.claude/shared-memory
# Shared Codex memories pool — every codex spawn/reopen/clone/respawn
# ensures <CODEX_HOME>/memories_1.sqlite is a symlink into this dir.
# Only the memories DB is shared; thread_history/goals/queue stay per-
# CODEX_HOME so conversation state remains isolated. Set to "" to disable.
export ORCHESTRON_SHARED_CODEX_MEMORY_DIR=~/.codex-shared-memory
```

### Option B: Config file

`~/.orchestron/config.json` (created by hand — `scripts/init.sh` only
scaffolds subdirs, not the config file itself):
```json
{
  "bindHost": "127.0.0.1",
  "port": 8080,
  "maxConcurrent": 8,
  "logLevel": "info",
  "idleTimeoutMs": 900000,
  "enableHeadlessMode": true,
  "remoteToken": "<48-char-hex>",
  "adapters": {
    "claude": true,
    "codex": true,
    "opencode": false
  }
}
```

**Then lock it down** — `remoteToken` is a plaintext bearer credential:
```bash
chmod 600 ~/.orchestron/config.json
```
On startup the API stat-checks the mode and prints a `[orchestron] SECURITY:`
warning to stderr if group/world bits are set (non-fatal, but do the chmod).

Schema (from `packages/shared/src/config.ts`):

| Field | Type | Default | Env override |
|---|---|---|---|
| `bindHost` | string | `127.0.0.1` | `ORCHESTRON_BIND_HOST` |
| `port` | int 1-65535 | `8080` | `ORCHESTRON_PORT` (or legacy `AHQ_API_PORT`) |
| `dataDir` | string | `~/.orchestron` | `ORCHESTRON_DATA_DIR` (or legacy `AHQ_DATA_DIR`) |
| `maxConcurrent` | int 1-200 | `floor(totalmem_MB / 800)`, capped at 20 | `ORCHESTRON_MAX_CONCURRENT` |
| `remoteToken` | string? | none | `ORCHESTRON_REMOTE_TOKEN` |
| `adapters.claude` | bool | `true` | — |
| `adapters.codex` | bool | `false` | — |
| `adapters.opencode` | bool | `false` | — |
| `logLevel` | `error \| warn \| info \| debug` | `info` | `ORCHESTRON_LOG_LEVEL` |
| `idleTimeoutMs` | int ≥ 0 | `900000` (15 min) | `ORCHESTRON_IDLE_TIMEOUT_MS` |
| `enableHeadlessMode` | bool | `true` | — |

Fields **not** in `config.json` (env-only): `ORCHESTRON_SHARED_MEMORY_DIR`,
`ORCHESTRON_SHARED_CODEX_MEMORY_DIR` — set on the API service unit
(§6b `orchestron-api.service`) alongside `NODE_ENV`.

Precedence (highest wins): env > config file > built-in defaults.

**Auto-detected default `maxConcurrent`**: `floor(totalmem_MB / 800)`, capped at 20. Overrideable.
The cap counts **live tmux only** — sessions in `sleeping` (tmux
released, wake on next `--resume`) and terminal states (`succeeded` /
`failed` / `killed`) don't count. Accumulated sleeping records over
days used to trip the cap even with zero live tmux; that's fixed —
sleeping is cheap, keep them around for reopen/adopt without worrying
about pool pressure.

**Headless kill switch (`enableHeadlessMode`)**: default `true`. Set it
to `false` and every headless request is quietly coerced to tmux instead
of rejected — an explicit `useTmux: false` on `POST /api/sessions` or
`PATCH /api/sessions/:uuid`, a headless project default, and a headless
session record on Respawn. Nothing 400s; the response carries
`"coerced": {"useTmux": true, "reason": "headless disabled globally"}`
and the API logs each one at info level. The web UI hides the *Use tmux*
toggle outright while the switch is off and raises a toast whenever a
coercion comes back. Stored preferences are left on disk, so flipping the
switch back on restores each project and session to the mode it asked
for. Running headless sessions are untouched — a live process cannot be
converted mid-flight. Config-file only (no env override) and read at
boot, so restart the API after changing it. See
[USAGE.md § Headless mode](USAGE.md#headless-mode-no-tmux).

**Idle sweeper (`idleTimeoutMs`)**: default 900000 (15 min). Sessions in
`idle` or `needs_input` beyond this go to `sleeping` (tmux killed,
JSONL/rollout preserved). Wake up by sending input — cold-start via the
harness's native resume path (`claude --resume <uuid>` or
`codex resume <uuid>`) takes ~3-5 s. Set 0 to disable. See
[USAGE.md §3](USAGE.md) for details.

**Shared memory (Claude — `ORCHESTRON_SHARED_MEMORY_DIR`)**: default
`~/.claude/shared-memory`. Env-only for now (not in config.json). Every
Claude spawn/reopen/fork/respawn/wake-up symlinks the per-workspace
`<configDir>/projects/<mangled-cwd>/memory/` dir into this pool so all
Claude sessions across all workspaces share one memory pool. If a real
dir is found at that path (Claude CLI created it eagerly), it is
safety-renamed with a timestamp suffix before the symlink is created —
no data lost, but you may want to hand-merge the `.bak-<stamp>` copy
into the pool later.

**Shared memory (Codex — `ORCHESTRON_SHARED_CODEX_MEMORY_DIR`)**:
default `~/.codex-shared-memory`. Env-only. Every Codex spawn/reopen/
fork/respawn/wake-up symlinks the single file
`<CODEX_HOME>/memories_1.sqlite` into this dir. Only the memories DB
(codex's curated cross-thread memory pool) is shared — `thread_history`,
`goals`, and `queue` DBs stay per-`CODEX_HOME` so conversation state
remains isolated per identity. Same safety-rename semantics apply if a
real SQLite file already exists at the target path.

**Enable Codex adapter**: flip `adapters.codex` to `true` in
`config.json` above and restart the API. On startup the adapter probes
for the `codex` binary via `PATH` and disables itself if absent — check
the API log for `[adapter:codex] disabled: binary not found` if a
session refuses to spawn with `agentType: 'codex'`.

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
# Restart process (kalau via systemd: systemctl --user restart orchestron-api.service orchestron-web.service)
```

### Open UI

Kedua mode buka http://localhost:3010 di browser laptop.

**Constraint:**

- **Akses lokal saja.** Bind `127.0.0.1` — HP/tablet/laptop lain di WiFi yang sama tidak bisa connect (connection refused). Cuma browser/CLI di laptop yang sama.
- **No auth layer.** Siapapun yang bisa buka terminal/browser di laptop ini akses semua endpoint tanpa login. Trade-off intentional: single-user laptop = trusted zone.
- **Live subprocess ephemeral saat reboot.** File-based state (session records, transcripts, project registry, metrics) **persist forever**. Yang mati saat reboot / `tmux kill-server` = live `claude` / `codex` subprocess. Session status yang tadinya `running` / `waiting` auto-transition ke `killed` dgn reason "orphaned" via boot-time orphan scanner. Terminal-state sessions (`completed`, `failed`, `killed`) fully persist — record + transcript readable selamanya.
- **Resumability.** In-flight session yang mati bisa dilanjut: `orchestron session resume <uuid>` → invoke the harness's native resume path (`claude --resume <uuid>` for Claude, `codex resume <uuid>` for Codex) yang restore context dari transcript/rollout. Konversasi lanjut seolah tidak putus.
- **API call fail saat offline.** Kalau laptop offline (WiFi off) atau sleep, API call ke Anthropic / OpenAI timeout — session yang lagi thinking transisi ke `failed`. Tapi transcript/rollout sampai poin timeout tetap persist.

---

## 6. Deploy — Scenario B: Home Server + Remote Access

Adi's actual server profile: 4 vCPU, 7.8 GB RAM, 58 GB disk. Capacity: **8-12 concurrent sessions** (RAM constrained). Refer HLD "Deployment Scenarios" untuk detail.

### 6a. Generate Bearer Token

```bash
orchestron token generate
# Output: 48-char hex
export ORCHESTRON_REMOTE_TOKEN="<paste>"
```

Persist them one of two ways (whichever fits your setup):

- **In `~/.orchestron/config.json`** for `bindHost` / `port` /
  `remoteToken` — see the schema table in §4 Option B.
- **Inline in the systemd unit** (`Environment="KEY=VALUE"` lines in
  `orchestron-api.service` — §6b below) for env-only settings like
  `ORCHESTRON_SHARED_MEMORY_DIR` / `ORCHESTRON_SHARED_CODEX_MEMORY_DIR`
  or when you want an env to win over the config file.

There is no `EnvironmentFile=` on the current unit — put values
directly on the `Environment=` lines. An external `.env` file wouldn't
be read.

**Boot guard**: kalau bind non-loopback (`0.0.0.0`, Tailscale IP, dst) dan `ORCHESTRON_REMOTE_TOKEN` unset → server refuse to start. Fail-fast.

### 6b. Install as systemd user services (API + Web)

Orchestron runs as **two** separate services — the Fastify API and the
Next.js dashboard. Both are needed for the browser/PWA to work; the
`orchestron serve` CLI only spawns the API (via `tsx` on source, dev
convenience) and doesn't cover the web, so production installs should
skip the CLI and wire the two dist builds directly.

`~/.config/systemd/user/orchestron-api.service`:

```ini
[Unit]
Description=Orchestron API — Fastify backend for coding agent supervisor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
# Delegate=yes lets orchestron-api manage its own cgroups so tmux's
# transient scope creation (StartTransientUnit for tmux-spawn-*.scope)
# isn't denied by systemd — without this the spawned pane dies within
# a few seconds.
Delegate=yes
WorkingDirectory=%h/Works/agent-hq-orchestron/apps/api
Environment="NODE_ENV=production"
Environment="PATH=%h/.local/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin"
# Shared memory pools — env-only (not in config.json). Uncomment to
# override the defaults (~/.claude/shared-memory for claude,
# ~/.codex-shared-memory for codex). Set to "" to disable that pool
# and keep memory strictly per-workspace. Leave commented for defaults.
#Environment="ORCHESTRON_SHARED_MEMORY_DIR=%h/.claude/shared-memory"
#Environment="ORCHESTRON_SHARED_CODEX_MEMORY_DIR=%h/.codex-shared-memory"
ExecStart=/home/linuxbrew/.linuxbrew/bin/node dist/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

`~/.config/systemd/user/orchestron-web.service`:

```ini
[Unit]
Description=Orchestron Web UI — Next.js frontend
After=network-online.target orchestron-api.service
Wants=network-online.target
Requires=orchestron-api.service

[Service]
Type=simple
WorkingDirectory=%h/Works/agent-hq-orchestron/apps/web
Environment="NODE_ENV=production"
Environment="PORT=3010"
# Bind to loopback only when fronted by Tailscale Serve (recommended).
# Set to your bind interface if exposing directly.
Environment="HOSTNAME=127.0.0.1"
# NEXT_PUBLIC_API_URL is baked at build time — must match the API's
# actual bind so the browser can reach it. Same-origin `/api/*` also
# rewrites through next.config.ts as a fallback.
Environment="NEXT_PUBLIC_API_URL=http://<api-host>:8090"
Environment="PATH=%h/.local/bin:/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin"
# Next.js 16 no longer honors HOSTNAME env for bind — pass -H explicitly.
ExecStart=/home/linuxbrew/.linuxbrew/bin/npx next start -H 127.0.0.1 -p 3010
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Enable + start both:

```bash
systemctl --user daemon-reload
systemctl --user enable --now orchestron-api.service orchestron-web.service
systemctl --user status orchestron-api.service orchestron-web.service
```

Persistent across boots requires linger:
```bash
sudo loginctl enable-linger $USER
```

Restart / logs — both services:
```bash
systemctl --user restart orchestron-api.service orchestron-web.service
journalctl --user -u orchestron-api.service -u orchestron-web.service -f
```

Front the web with Tailscale Serve for HTTPS + PWA + safe public bind:
```bash
tailscale serve --bg --https=443 3010
# https://<hostname>.<tailnet>.ts.net/ becomes the frontdoor;
# firewall-drop :3010 from public so only loopback → TS Serve → 3010
# path exists.
```

### 6b-macOS. launchd LaunchAgent (macOS equivalent of §6b)

macOS has no systemd. Use `launchd` LaunchAgents — plists live in
`~/Library/LaunchAgents/`, load with `launchctl bootstrap`. Notes
vs the Linux setup:

- **No `loginctl enable-linger`** — LaunchAgents auto-start at user
  login; for headless / lid-closed operation, keep the user logged in
  (System Settings → Users → Automatic login) or convert to a
  system-wide `LaunchDaemon` (needs sudo, runs as root — bigger blast
  radius; only do it if the box is truly headless).
- **No `Delegate=yes` equivalent needed** — the tmux transient-scope
  cgroup issue that motivated `Delegate=yes` on Linux is systemd-
  specific; macOS tmux spawns don't hit it.
- **Homebrew binary paths differ by arch** — Apple Silicon:
  `/opt/homebrew/bin/{node,npx,tmux,tailscale}`; Intel:
  `/usr/local/bin/…`. Adjust the plist templates below.
- **Home is `/Users/<you>`** — `~/.orchestron/`, `~/.claude/`,
  `~/.codex/` all still work the same relative to the user's home.
- **⚠ Substitute both placeholders before loading** — the templates
  below use `/Users/YOU/` for your macOS username and `<REPO_ROOT>/`
  for where you cloned the repo (common choices: `Works`, `Codes`,
  `Sites`, `Projects`, `Developer` — pick whatever `pwd` in the
  cloned repo prints). Missing / wrong values here surface at load
  as exit code 78 (`EX_CONFIG`) — launchd fails to `cd` into a
  non-existent `WorkingDirectory` or can't find `dist/server.js`.
  Verify with `launchctl list | grep orchestron` — a `0` in the exit
  column means running, non-zero means the plist references a path
  that doesn't exist. Also worth: `launchd` doesn't tail the plist
  to a log for these early-boot failures (nothing lands in
  `StandardErrorPath` because the process never starts), so cross-
  check paths by hand with `ls`.

`~/Library/LaunchAgents/com.orchestron.api.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.orchestron.api</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/YOU/<REPO_ROOT>/agent-hq-orchestron/apps/api/dist/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOU/<REPO_ROOT>/agent-hq-orchestron/apps/api</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <!-- Shared memory pools — env-only (not in config.json). Omit either
         key to accept the code default (~/.claude/shared-memory for claude,
         ~/.codex-shared-memory for codex). Set to empty string to disable
         that pool entirely and keep memory strictly per-workspace. -->
    <!--
    <key>ORCHESTRON_SHARED_MEMORY_DIR</key><string>/Users/YOU/.claude/shared-memory</string>
    <key>ORCHESTRON_SHARED_CODEX_MEMORY_DIR</key><string>/Users/YOU/.codex-shared-memory</string>
    -->
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>/Users/YOU/.orchestron/logs/api.out.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/.orchestron/logs/api.err.log</string>
</dict>
</plist>
```

`~/Library/LaunchAgents/com.orchestron.web.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.orchestron.web</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/npx</string>
    <string>next</string><string>start</string>
    <string>-H</string><string>127.0.0.1</string>
    <string>-p</string><string>3010</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOU/<REPO_ROOT>/agent-hq-orchestron/apps/web</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>PORT</key><string>3010</string>
    <key>HOSTNAME</key><string>127.0.0.1</string>
    <key>NEXT_PUBLIC_API_URL</key><string>http://100.x.y.z:8090</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>/Users/YOU/.orchestron/logs/web.out.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/.orchestron/logs/web.err.log</string>
</dict>
</plist>
```

Load + start:

```bash
# GUI user session (uid = $(id -u))
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.orchestron.api.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.orchestron.web.plist
launchctl kickstart -k gui/$(id -u)/com.orchestron.api
launchctl kickstart -k gui/$(id -u)/com.orchestron.web
```

Status / logs / restart:

```bash
launchctl print gui/$(id -u)/com.orchestron.api   # verbose state
tail -f ~/.orchestron/logs/api.err.log ~/.orchestron/logs/web.err.log
launchctl kickstart -k gui/$(id -u)/com.orchestron.api   # restart
launchctl bootout gui/$(id -u)/com.orchestron.web        # stop + unload
```

Tailscale Serve works the same as Linux — Tailscale ships a native
macOS app + `tailscale` CLI (`brew install tailscale` for the CLI-only
package, or use the Mac App Store version's Serve toggle in the menu
bar). The `tailscale serve --bg --https=443 3010` invocation is
identical.

**Untested here** — the API + web on this project have been verified on
Linux (systemd). The launchd templates above are the direct translation
based on the equivalent primitives; verify with `launchctl print` and
the log paths after first load, and read
[Apple launchd docs](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
if anything misbehaves. Report back so this section can be tightened.

### 6c. Tailscale (recommended for remote)

```bash
sudo tailscale up
tailscale ip -4   # note the IP, e.g. 100.71.6.23
```

Set the bind host — either in `~/.orchestron/config.json`:
```json
{ "bindHost": "100.71.6.23" }
```
Or inline on the API systemd unit (add to the `[Service]` block):
```ini
Environment="ORCHESTRON_BIND_HOST=100.71.6.23"
```

Restart both services:
```bash
systemctl --user daemon-reload   # only if you edited the unit file
systemctl --user restart orchestron-api.service orchestron-web.service
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
0 2 * * * rsync -a --delete <server-ip>:~/.orchestron/ ~/orchestron-backup/
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

- **State terpisah total.** Sessions yang spawn di laptop **tidak muncul** di server UI, dan sebaliknya. Setiap instance punya `~/.orchestron/` sendiri di host masing-masing.
- **Tidak ada auto-sync.** Kalau lu spawn session A di laptop, session A cuma ada di laptop. Server tidak tahu.
- **No cross-host resume.** Session yang started di laptop tidak bisa di-resume dari server — transcript/rollout file host-specific: Claude di `~/.claude/projects/<mangled-cwd>/<uuid>.jsonl`, Codex di `~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`.
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

- **Sessions di laptop**: buka `http://localhost:3010` di browser laptop
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
  <server-ip>:~/.orchestron/ \
  ~/orchestron-server-archive/
```

Ini bukan sync — cuma backup buat lu bisa browse server session dari laptop offline (via CLI `orchestron project list --data-dir ~/orchestron-server-archive`).

**Federation view (v2, belum ada)**: kalau nanti Option 2 di HLD Multi-Instance Topology di-implement, laptop UI bisa render peer server sessions read-only via `peers.json` config. Untuk sekarang, manual switch browser tab.

### Anti-pattern: Two-way sync

**JANGAN** sync `~/.orchestron/` bidirectional (Syncthing/rsync dua arah) — HLD Multi-Instance Topology explicit mark ini sebagai anti-pattern. Race condition kedua sisi nulis `sessions/*.json` bersamaan = corrupt data. Pakai federation view kalau butuh cross-visibility, atau accept state split.

---

## 8. Post-Deploy Verification

```bash
# Doctor check
orchestron doctor

# API health
curl -H "Authorization: Bearer $ORCHESTRON_REMOTE_TOKEN" \
  http://100.71.6.23:8080/api/health

# Web UI — via Tailscale Serve (recommended, HTTPS + PWA-ready):
open https://<hostname>.<tailnet>.ts.net/
# Or, if you exposed web directly on a tailnet IP + firewalled off public:
open http://100.71.6.23:3010

# Verify test suite passes
npm test
```

### SSE / WS auth — `?ticket=` (preferred) vs `?token=` (legacy)

SSE and WebSocket endpoints can't send an `Authorization` header from
the browser, so they authenticate via a query-string credential. Two
modes are accepted:

```bash
# Preferred — mint a one-shot 60-second ticket, then open the stream:
TICKET=$(curl -s -X POST \
  -H "Authorization: Bearer $ORCHESTRON_REMOTE_TOKEN" \
  http://100.71.6.23:8080/api/sse-ticket | jq -r .ticket)
curl -N "http://100.71.6.23:8080/api/stream?ticket=$TICKET"

# Legacy — long-lived remoteToken directly (still accepted):
curl -N "http://100.71.6.23:8080/api/stream?token=$ORCHESTRON_REMOTE_TOKEN"
```

Tickets are single-use, expire in 60 s, and live in the API's memory
only. Prefer them for any client that can POST first — the ticket
approach keeps the long-lived `remoteToken` out of proxy access logs,
browser history, and `Referer` headers.

Expected `/api/health` response:
```json
{
  "ok": true,
  "tmux": "tmux 3.4",
  "storage": "/home/adi/.orchestron",
  "bindHost": "100.71.6.23",
  "remoteAuth": "enabled",
  "maxConcurrent": 8
}
```

---

## 9. Register First Project

Via CLI:
```bash
# Claude-backed project
orchestron project add \
  --name nanovest-backend \
  --path ~/Works/nanovest-backend \
  --agent claude \
  --config-dir ~/ClaudeConfigs/adi.novriansyah

# Codex-backed project — --config-dir maps to CODEX_HOME, so a custom
# path lets you isolate model/trust/auth from your personal ~/.codex.
orchestron project add \
  --name research-scratch \
  --path ~/Works/research-scratch \
  --agent codex \
  --config-dir ~/.codex
```

Or via Web UI: Dashboard → "Register Project" button (agent dropdown
lists whichever adapters are enabled + have their binary on `PATH`).

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

Template file live di `~/.orchestron/templates/<name>.md`:

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

Bikin script di `~/.orchestron/hooks/pre-spawn/enforce-no-secrets.ts`:

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
systemctl --user restart orchestron-api.service orchestron-web.service

# Verify
systemctl --user status orchestron-api.service orchestron-web.service
orchestron doctor
```

Data schema is additive (Zod schema evolution) — old JSON files always readable.

---

## 12. Troubleshooting

| Symptom | Diagnose | Fix |
|---|---|---|
| `EADDRINUSE :8080` | Port already used | `lsof -i:8080` → kill or change `ORCHESTRON_PORT` |
| Boot guard error `refusing to bind` | Non-loopback + no token | Set `ORCHESTRON_REMOTE_TOKEN` env |
| `401 Unauthorized` | Missing/wrong Bearer header | Verify token, check WS uses `?token=` param (or `?ticket=` from `POST /api/sse-ticket`) |
| `413 Payload Too Large` on `/transcript` | Session transcript exceeded the 50MB in-memory cap | Use `GET /api/sessions/:uuid/export` — it streams the file instead of buffering |
| `413 Payload Too Large` on `/api/sessions/import` | Bundle decompresses past the 200MB tar-bomb cap | Confirm the bundle is a legitimate export; if legitimate but oversized, split it |
| `429 Too Many Requests` | Global rate limit hit (600 req/min per bearer, loopback exempted) | Back off; check for a polling loop or an MCP agent in a tight spawn cycle |
| `/api/health` body is only `{ok:true}` where scripts expected full detail | Verbose fields moved to `/api/health/detail` to stop unauth path/host fingerprinting | Update scripts to hit `/api/health/detail` with the Bearer token |
| `[orchestron] SECURITY:` on boot | `~/.orchestron/config.json` is group/world-readable | `chmod 600 ~/.orchestron/config.json` |
| `Session pool is full` when 0 live tmux | Legacy — cap counted sleeping records. Fixed in 481855e; sleeping and terminal states no longer count against `maxConcurrent` | Update to that commit or later |
| Forgot the restart command for this host | Open **Settings** page — Configuration section shows both Linux (`systemctl`) and macOS (`launchctl … $(id -u) …`) restart commands with a `THIS HOST` chip on the applicable one. Copy button included | — |
| Sessions stuck `spawning` (Claude) | tmux marker not detected | Check `claude` CLI authenticated; run `claude` manually to verify |
| Sessions stuck `spawning` (Codex) | Ready marker (`>_ OpenAI Codex` banner) not detected, or trust prompt blocking | Run `codex` manually in the workspace dir once to accept the trust prompt (persists in `~/.codex/config.toml`); check `codex login` status; confirm `CODEX_HOME` (if set) points to the same dir orchestron passes via `--config-dir` |
| Codex session shows `agentType: codex` but never captures a session id | Interactive TUI mode does NOT write rollout JSONL — orchestron scans `$CODEX_HOME/sessions/YYYY/MM/DD/` for a NEW rollout newer than spawn time | Check the rollout dir date subfolders exist and are writable; watch API log for `[adapter:codex] rollout scan` warnings |
| Empty metrics | No completed sessions yet | Spawn session → wait for `on-session-end` → refresh `/metrics` |
| Web UI blank | Service worker stale | Ctrl+Shift+R hard reload; or clear site data |
| Orphan tmux sessions | Server killed mid-session | Restart server → orphan-scanner cleans automatically |

Logs:
```bash
tail -f ~/.orchestron/logs/api-$(date +%F).log
journalctl --user -u orchestron-api.service -u orchestron-web.service -f
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

**Also check for a permission prompt in the tmux pane:**
`tmux attach -rt <tmux-name>` (read-only). If Claude is waiting on a
tool-approval prompt that orchestron has no UI to answer, the session
sits idle mid-turn without emitting `turn_duration`. Root cause is
usually a Claude Team/Enterprise managed policy overriding
`--permission-mode bypassPermissions` (via `disableBypassPermissionsMode:
"disable"` in the config-dir's `remote-settings.json`), so any tool call
outside the user's `settings.json` `permissions.allow` list hits the
default gate. Fix: either add the tool to `permissions.allow`, or point
the project at a non-Team-plan config-dir where bypass actually takes
effect. See HLD "Managed-policy caveat" section under Adapters.

### "Cannot find pane" on spawn

Transient auth/quota failure at tmux boot. `completeSpawn` auto-retries
once with a fresh session UUID; if it fails again, check per harness:

**Claude:**
- `claude` CLI can start interactively (`claude` in a plain terminal)
- Anthropic subscription is not exhausted
- tmux version (`tmux -V` must be ≥ 3.2)

**Codex:**
- `codex` CLI can start interactively (`codex` in a plain terminal —
  should show the `>_ OpenAI Codex` banner within ~2 s)
- `codex login` still valid (ChatGPT subscription active, or `OPENAI_API_KEY` set if you opted into API-key mode)
- Workspace trust prompt already accepted — check `~/.codex/config.toml`
  for `[projects."<abs-workspace-path>"] trust_level = "trusted"`; if
  missing, run `codex` once inside the workspace dir manually and press
  Enter on the trust prompt
- tmux version (`tmux -V` must be ≥ 3.2)

---

## 13. Uninstall

```bash
# Stop + disable both services
systemctl --user disable --now orchestron-api.service orchestron-web.service
rm ~/.config/systemd/user/orchestron-api.service ~/.config/systemd/user/orchestron-web.service

# Unlink CLI
cd ~/Works/agent-hq-orchestron/apps/cli && npm unlink -g

# Remove data (⚠ irreversible — backup first if needed)
rm -rf ~/.orchestron/

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
