# scripts/

Operational scripts. Everything here is meant to be run from the repo
root.

| Script | What it does |
|---|---|
| [`init.sh`](init.sh) | First-run scaffold — installs deps and builds the workspace packages. |
| [`dev.sh`](dev.sh) | Runs the API and web in dev mode side by side. |
| [`e2e-env.sh`](e2e-env.sh) | Brings up the isolated Orchestron the E2E scenarios run against. |
| [`e2e-scenario.sh`](e2e-scenario.sh) | Prints one scenario from `docs/e2e-tests/` next to this run's env values. |
| [`e2e-probe/`](e2e-probe) | The rules a sweep probe has to follow, kept out of the `scratchpad/` probes that `.gitignore` swallows. |
| [`systemd/`](systemd) | Unit templates for the E2E instance. `e2e-env.sh up` installs them. |

> `.gitignore` ignores `scripts/*.md` — those are session-scoped
> sub-agent task prompts, not docs. This file is negated back in
> explicitly. A new doc under `scripts/` needs the same treatment.

---

## e2e-env.sh

A second, complete Orchestron on the same host: its own data dir, port,
bearer token, agent credentials and web bundle. It exists because the
[`docs/e2e-tests/`](../docs/e2e-tests) scenarios kill sessions, delete
records and flip config flags — run them against the deployed instance
and they eat real work.

### First run

```bash
# 1. authenticate the E2E agent account (once — OAuth cannot be scripted)
mkdir -p ~/ClaudeConfigs/e2e
CLAUDE_CONFIG_DIR=~/ClaudeConfigs/e2e claude     # /login, then /exit

# 2. build the E2E web bundle (once, and after any apps/web change)
./scripts/e2e-env.sh build

# 3. up, and register the fixture projects
./scripts/e2e-env.sh up
./scripts/e2e-env.sh fixtures

# 4. the dashboard is at http://127.0.0.1:3011
. ~/.orchestron-e2e/e2e.env      # $ORCH, $ORCH_WEB, $TOKEN, project ids
```

Use a **dedicated** account in step 1. A sweep burns that account's
quota and leaves every session it spawned in its history.

### Commands

| | |
|---|---|
| `up` | Write config, install and start units, wait until ready, assert isolation. |
| `down` | Reap E2E tmux windows, stop and disable units, wipe the data dir. `--keep-data` skips the wipe. |
| `reset` | `down` then `up` — a clean slate between runs. |
| `status` | What is running, whether the web bundle matches the API port, and whether isolation holds. |
| `build` | Build the E2E web bundle (and the API, only if it has no `dist/` yet). |
| `fixtures` | (Re-)register the five `e2e-*` fixture projects. Idempotent; also the way to reset fixtures without a full cycle. |
| `logs api\|web` | `journalctl -f` for one unit. |
| `token` | Print the E2E bearer. |
| `env` | Print the generated shell exports. |
| `test-self` | Self-check: `up` → assert → fixtures → `down` → assert. 22 checks. |

### Layout

| | Deployed | E2E |
|---|---|---|
| Data dir | `~/.orchestron/` | `~/.orchestron-e2e/` |
| API | 8090 | 8091 |
| Web | 3010 | 3011 |
| Web build | `apps/web/.next/` | `apps/web/.next-e2e/` |
| `CLAUDE_CONFIG_DIR` | `~/.claude/` | `~/ClaudeConfigs/e2e/` |
| Units | `orchestron-{api,web}` | `orchestron-{api,web}-e2e` |

Both run **the same `apps/api/dist/server.js` from the same working
tree** — an E2E run should exercise the code under review, not a copy of
it. Only the web bundle is built twice, because `NEXT_PUBLIC_API_URL` is
baked in at build time.

`docs/e2e-tests/00-setup.md` § 8 has the full table, and — more
usefully — the list of what is *not* isolated.

### Overrides

Every default is an env var. The ones worth knowing:

| Var | Default | Note |
|---|---|---|
| `E2E_REPO` | the tree this script lives in | Which checkout the units run from. Running the copy inside a git worktree points them at that worktree. |
| `E2E_DATA_DIR` | `~/.orchestron-e2e` | `down` refuses to wipe a path that is outside `$HOME`, has no `e2e` in it, or equals `PROD_DATA_DIR`. |
| `E2E_API_PORT` / `E2E_WEB_PORT` | 8091 / 3011 | |
| `E2E_CLAUDE_CONFIG_DIR` | `~/ClaudeConfigs/e2e` | Kept across `down` — it holds the credentials. |
| `E2E_DEFAULT_MODEL` | `claude-haiku-4-5` | Advisory. Applied as the `e2e-haiku` fixture's project default; there is no server-side global default model. |
| `E2E_IDLE_TIMEOUT_MS` | `60000` | 1 minute, so the sleep/wake scenarios do not idle for 15. |
| `PROD_DATA_DIR` / `PROD_REPO` | `~/.orchestron` / `~/Works/agent-hq-orchestron` | Read-only, and only for the isolation assertions. |

### How the isolation actually works

Two env vars on the API unit do all of it:

- `ORCHESTRON_DATA_DIR` moves every record, **and** — via
  `resolveConfigPath` in `packages/shared/src/config.ts` — the
  `config.json` the process reads. That file is what carries the port
  and the bearer, so it is the whole separation.
- `CLAUDE_CONFIG_DIR` is what the adapters fall back to when a project
  names no config dir, and they pass it through to both the headless
  child and the tmux pane.

Plus `NEXT_DIST_DIR` on the web unit, so two `next start`s can coexist.

Nothing here is E2E-specific in the backend: with none of those env vars
set, every path resolves exactly where it did before. That is covered by
`apps/api/tests/config-path-resolution.test.ts`.

### macOS

Not wired up. The env vars are all platform-neutral, so the work is
translating `scripts/systemd/*.service` into two launchd plists and
swapping `systemctl --user` for `launchctl kickstart -k gui/$(id -u)/…`.
`require_linux_systemd` is the single gate to relax.

---

## e2e-scenario.sh

A reader for `docs/e2e-tests/`, not a runner.

```bash
./scripts/e2e-scenario.sh list            # all 96 scenario ids, by file
./scripts/e2e-scenario.sh list --smoke    # the [smoke] set
./scripts/e2e-scenario.sh SPAWN-05        # one scenario, plus this run's env
```

The scenario files are written for a human with a browser; what they
cannot know is this run's bearer, ports and fixture project ids. This
prints the two together.

Running scenarios is Phase 3 (an LLM driving playwright). The reason to
have this now is that the id index and section parsing it will need
already exist and get exercised by hand.

---

## e2e-probe/

A sweep's probes live in `scratchpad/e2e-runs/<date>-<batch>/probes/` and are
gitignored, which is right — they are pointed at one run's fixtures. What is
not right is the *rules* living there too: post-batch-20 filed NF39 and NF40,
both of which were a rule learned the hard way inside a throwaway file, and so
available to be got wrong again on the next sweep.

```js
import { assertRecall, maxSeq } from '<run>/../../scripts/e2e-probe/recall.mjs'
import { loadEnvFile } from '<run>/../../scripts/e2e-probe/env-file.mjs'
```

- `recall.mjs` — recall is asserted on the **transcript**, never on
  `finalResponse` (that field is the structured-output summary), and the entry
  that counts is picked past the resume-nudge pair and past a baseline read
  *before* the turn was sent.
- `env-file.mjs` — the fixture argument is honoured, a missing fixture throws,
  and an argument the probe does not read throws instead of being ignored.
- `recall-probe.mjs` — a runnable example holding both.

`npm test` runs their unit tests (`npm run test:probe`, `node --test`, no
network). See [`e2e-probe/README.md`](e2e-probe/README.md).
