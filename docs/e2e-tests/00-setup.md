# Setup — Global Preconditions

Everything every other file in this directory assumes. Read once, get
the fixtures in place, then go to the scenario file you need.

> **Use the isolated environment.** Since Phase 2 there is a second,
> complete Orchestron for exactly this purpose — own data dir, port,
> bearer, agent credentials and web bundle. Three commands:
>
> ```bash
> ./scripts/e2e-env.sh build      # once, and after any web change
> ./scripts/e2e-env.sh up
> ./scripts/e2e-env.sh fixtures
> . ~/.orchestron-e2e/e2e.env     # $ORCH, $TOKEN, fixture project ids
> ```
>
> Then the dashboard is at <http://127.0.0.1:3011>. Section 8 has the
> details and the limits. Sections 1-7 below describe what a scenario
> needs; the script is what puts it there.

---

## 1. Server

- API is running and reachable. Default `http://127.0.0.1:8090`; on a
  tailnet host it is whatever `bindHost` + `port` say in
  `~/.orchestron/config.json`.
- Web bundle is running and reachable — default
  `http://127.0.0.1:3010`.
- `NEXT_PUBLIC_API_URL` used at **build** time matches the API's actual
  `bindHost:port`. A mismatch does not fail loudly; it fails as a 500
  from Next's server-side render. See
  [DEPLOY.md](../DEPLOY.md).
- `orchestron doctor` reports tmux present, the harness CLI present, and
  the config readable.

```bash
# quick liveness check — anonymous, no token needed
curl -s http://127.0.0.1:8090/api/health
# {"ok":true}
```

In the isolated environment all of the above is one command, and it
asserts each of these rather than asking you to:

```bash
./scripts/e2e-env.sh status
```

## 2. Auth

- Bearer token from `remoteToken` in `~/.orchestron/config.json`
  (isolated env: `./scripts/e2e-env.sh token`).
- The browser has been paired by visiting `/pair?token=<token>` once — it
  writes `orchestron_token` to `localStorage` and `sessionStorage`, then
  redirects to `/dashboard`.

  `/pair` is the **only** token sink. `/dashboard?token=…` stores nothing
  and keeps the query string in the URL: `app/pair/page.tsx` is the one
  place that reads the `token` param. Measured on clean browser profiles
  (NF18) — a runner who pairs that way gets an unpaired browser and then
  debugs 401s unrelated to the scenario.
- For any scenario step that curls the API directly:

```bash
export ORCH=http://127.0.0.1:8090
export TOKEN="$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.orchestron/config.json')))['remoteToken'])")"
curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/health/detail" | head -c 400
```

In the isolated environment, source the generated file instead — it
carries `$ORCH`, `$ORCH_WEB`, `$TOKEN` and every fixture project id:

```bash
. ~/.orchestron-e2e/e2e.env
```

`/api/health/detail` is the authenticated one, and it is where
`enableHeadlessMode` is reported — [`feature-flag.md`](feature-flag.md)
depends on it.

## 3. Harness

- `claude` on `PATH` and authenticated against the `CLAUDE_CONFIG_DIR`
  the fixture projects point at. Headless (`claude -p`) reads the same
  credentials as the interactive TUI, so one login covers both.
- `codex` only if you intend to run the codex-marked scenarios. Codex
  TUI import additionally needs `thread_history_1.sqlite` to already
  exist at the destination, which means `codex` has been run at least
  once on this host.
- A session that has to think costs quota. Keep fixture prompts short
  and cheap — see *Prompts* below.

**One-time setup for the isolated environment.** It spawns agents
against its own `CLAUDE_CONFIG_DIR`, which has to be authenticated by
hand once — OAuth cannot be scripted, so `e2e-env.sh up` checks for the
credentials and refuses to start without them:

```bash
mkdir -p ~/ClaudeConfigs/e2e
CLAUDE_CONFIG_DIR=~/ClaudeConfigs/e2e claude
# /login, finish the browser flow, /exit
```

Use the **dedicated E2E account**, not your own. A sweep burns quota and
leaves every session it spawned in that account's history.

## 4. Fixture projects

Register these once. Every scenario names the one it uses.

| Fixture name | Path | Agent | Defaults |
|---|---|---|---|
| `e2e-claude` | `/tmp/orchestron-e2e/ws-claude` | claude | none — model, effort and mode all unset |
| `e2e-claude-opus` | `/tmp/orchestron-e2e/ws-opus` | claude | default model `claude-opus-5`, default effort `high` |
| `e2e-headless` | `/tmp/orchestron-e2e/ws-headless` | claude | **Use tmux by default** unticked |
| `e2e-codex` | `/tmp/orchestron-e2e/ws-codex` | codex | none — *optional, only for codex-marked scenarios* |
| `e2e-haiku` | `/tmp/orchestron-e2e/ws-haiku` | claude | default model `claude-haiku-4-5` |

The three plain claude fixtures exist so that "what did this field
inherit from" is testable: `e2e-claude` has nothing to inherit,
`e2e-claude-opus` has model and effort, `e2e-headless` has a mode. A
scenario that asserts a `(project)` source tag needs a project that
actually sets the value.

`e2e-haiku` is the odd one out and exists for cost, not coverage. Each
of the others is shaped by what it must *not* set, so none of them can
carry a cheap default: putting a model on `e2e-claude` would destroy the
"nothing to inherit" case, and putting one on `e2e-headless` would break
the `(project)` source-tag assertions in
[`metadata-edit.md`](metadata-edit.md). Any scenario that just needs a
session to exist should use `e2e-haiku` — a turn there costs a few cents
and lands in ~10-20s.

> There is no server-side global default model. `defaultModel` is a
> *project* field; `ConfigSchema` has no such key, and a `defaultModel`
> line in `config.json` is silently dropped. Cheapness is a property of
> the fixture, or of what the scenario picks in the dialog.

```bash
mkdir -p /tmp/orchestron-e2e/ws-{claude,opus,headless,codex,haiku}
```

Register them through the **Projects** page rather than by writing JSON,
so registration itself gets exercised.

> The paths must exist before registration — the form rejects a path
> that does not.

In the isolated environment, `./scripts/e2e-env.sh fixtures` registers
all five over the API and prints their ids. It is idempotent: it deletes
projects named `e2e-*` and recreates them, so it also doubles as "reset
the fixtures" between runs without a full down/up. Scenarios that assert
the registration *form* still have to use the Projects page.

## 5. Prompts

Scenarios use short prompts so a turn costs a few seconds and almost no
quota. Unless a scenario says otherwise, use:

- **Fast prompt** — `Reply with the single word: ready. Do nothing else.`
- **Slow prompt** (when you need a turn long enough to interrupt or to
  observe `running`) — `Count slowly from 1 to 40, one number per line,
  with a short pause between each.`
- **Inquiry prompt** (to provoke a structured question from a headless
  agent) — `I want to deploy something, but I have not told you where.
  Ask me which environment and which region before doing anything.`

The inquiry prompt is a *request* to the model, not a guarantee — see
[`headless-flow.md`](headless-flow.md) `HEADLESS-04` for what to do when
a model answers in prose instead.

## 6. Config keys these scenarios touch

All in `~/.orchestron/config.json`. **The API reads them once at boot** —
every change needs a restart before it is in effect.

| Key | Default | Used by |
|---|---|---|
| `enableHeadlessMode` | `true` | [`feature-flag.md`](feature-flag.md) |
| `headlessStructuredOutput` | `true` | [`headless-flow.md`](headless-flow.md) |
| `idleTimeoutMs` | `900000` (15 min) | [`session-lifecycle.md`](session-lifecycle.md) sleep scenarios |

Restore every one of these to its default when you finish a file that
changed it. A left-over `enableHeadlessMode: false` makes half of the
other files fail for the wrong reason.

`idleTimeoutMs` can also come from `ORCHESTRON_IDLE_TIMEOUT_MS` in the
environment, which is the faster lever for the sleep scenarios — it does
not require editing the file.

**In the isolated environment**, the file is
`~/.orchestron-e2e/config.json` and the restart is:

```bash
systemctl --user restart orchestron-api-e2e.service
```

`e2e-env.sh up` **merges** rather than overwrites: it forces the keys
that define the environment (port, token, data dir, `maxConcurrent`,
`idleTimeoutMs`, adapters) and only *seeds* `enableHeadlessMode` and
`headlessStructuredOutput`. So a scenario can flip a flag and re-run
`up` without its own setup being silently undone. `down` wipes the file
entirely, which is the reliable way back to defaults.

`idleTimeoutMs` there defaults to **60000** (1 minute), not 900000 — the
sleep scenarios are the slowest thing in the sweep and 15 minutes of
waiting each is not a test, it is a coffee break. If a scenario asserts
the *deployed* default, set it explicitly.

## 7. Cleanup helpers

Scenarios state their own cleanup. These are the two things worth having
to hand.

**Kill everything spawned by a run:**

```bash
curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/sessions" \
  | python3 -c "import sys,json;[print(s['id'],s['status']) for s in json.load(sys.stdin)]"
# then, per id you want gone:
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" "$ORCH/api/sessions/<uuid>/record"
```

**Check for stray tmux windows** (a session record can be deleted while
its window lingers):

```bash
tmux ls | grep orch
```

Deleting a session **record** does not delete the harness transcript —
that is deliberate, and it is what makes a session re-adoptable. It also
means a run leaves JSONL behind under the config dir. That is fine and
does not need cleaning between scenarios.

### Waiting for a status, without tripping the rate limiter

The API rate-limits fast polling. A tight `curl` loop over
`GET /api/sessions/:uuid` earns

```
429 {"message":"Rate limit exceeded, retry in 4 seconds"}
```

and so does `DELETE /api/sessions/:uuid` when a cleanup loop runs flat out.
This is correct product behaviour, not a fault — but a scenario that does not
expect it reads the 429 as a wedged environment and starts debugging the wrong
thing. It cost real time in the 2026-09-10 sweep.

Two rules for anything that polls: **leave at least 500ms between polls**, and
**when a 429 comes back, honour the delay it names** (4s, as of this writing)
rather than retrying immediately.

The helper does both:

```bash
./scripts/e2e-env.sh wait <uuid> <status> [timeout-secs]

# a status alternation is usually what you actually want
./scripts/e2e-env.sh wait "$SESSION" 'idle|needs_input' 120
```

It polls every 500ms, backs off for as long as a 429 asks, treats a 404 as a
hard failure (the session is gone — waiting longer will not help), and gives up
after the timeout, which defaults to 60s. Exit status is 0 on arrival and 1
otherwise, so it drops straight into a scenario's control flow. Time spent
backing off counts against the timeout, so a run cannot silently double its own
budget by being throttled.

Scenario steps that spawn a session and then assert on its state should use it
instead of a bare `sleep` — a fixed sleep is either too short on a cold cache or
wasted wall-clock on a warm one.

## 8. Isolation

`scripts/e2e-env.sh` brings up a second, complete Orchestron so a sweep
is destructive only to itself:

| | Deployed | E2E |
|---|---|---|
| Data dir | `~/.orchestron/` | `~/.orchestron-e2e/` |
| Config | `~/.orchestron/config.json` | `~/.orchestron-e2e/config.json` |
| API port | 8090 | 8091 |
| Web port | 3010 | 3011 |
| Web build | `apps/web/.next/` | `apps/web/.next-e2e/` |
| Bearer token | yours | generated per `up`, `e2e-…` |
| `CLAUDE_CONFIG_DIR` | `~/.claude/` | `~/ClaudeConfigs/e2e/` |
| `CODEX_HOME` | `~/.codex/` | `~/.orchestron-e2e/codex-home/` |
| Shared memory pool | `~/.claude/shared-memory/` | `~/.orchestron-e2e/shared-memory/` |
| systemd units | `orchestron-{api,web}` | `orchestron-{api,web}-e2e` |
| `maxConcurrent` | RAM-derived | 4 |
| `idleTimeoutMs` | 900000 | 60000 |

Both instances run **the same build from the same working tree** — same
`apps/api/dist/server.js`. That is deliberate: an E2E run should
exercise the code under review, not a copy of it. Only the web bundle is
built twice, because `NEXT_PUBLIC_API_URL` is baked in at build time.

`up` asserts the separation rather than assuming it: that the E2E API
reports the E2E data dir, that its bearer differs from the deployed
one, and that the ports do not collide. `./scripts/e2e-env.sh test-self`
goes further and checks that the deployed instance is still answering on
its own address, still on its own data dir, and **rejects the E2E
bearer**.

### What is *not* isolated

Worth knowing before you trust a result:

- **Service worker / PWA.** The E2E web build runs with Serwist off,
  because `public/sw.js` lands outside `distDir` and is shared by every
  build of the tree — an E2E build would hand the deployed PWA a
  precache manifest full of E2E chunk hashes. So there is no service
  worker at :3011. Offline and install-prompt behaviour has to be
  checked against a real deploy.
- **The tmux server.** Both instances spawn into the same one, with the
  same `orchestron-<8hex>` naming. `e2e-env.sh down` reaps only the
  windows named in E2E session records, which is why it does that
  *before* wiping them. A `tmux kill-server` during a sweep takes the
  deployed sessions with it.
- **Agent transcripts.** `down` keeps `~/ClaudeConfigs/e2e/` — wiping it
  would take the OAuth credentials too, and re-login is manual. Old
  `.jsonl` files accumulate there; that is also what keeps a session
  re-adoptable.
- **The agent account's quota and history.** Isolated from your own
  session only if `~/ClaudeConfigs/e2e/` is logged into a *dedicated*
  E2E account. Log it into your own and a sweep burns your quota.

Scenarios are written so that switching is a matter of pointing `$ORCH`,
the browser URL and the fixture config dir somewhere else — no scenario
hardcodes a path under `~/.orchestron/` in a step, only in an
explanation. Keep it that way when adding scenarios.

**Do not run a full sweep against the deployed instance.** The kill,
archive and delete scenarios do what they say.

## 9. Screenshots

Scenarios name a file, e.g. `spawn-01-dialog-defaults.png`. Put them
under `scratchpad/e2e-runs/<date>/`. They are evidence for a human
reviewing a run, and the seed corpus for Phase 3's screenshot-diff
assertions — so frame them tightly on the thing being asserted, not the
whole browser window.

Capture in the app's default theme (Orchestron dark) unless the scenario
is about theming.

## 10. Sweep coordination protocol

A sweep measures one commit. If `main` moves underneath it, some results
describe code that is no longer there — and you will not notice, because
nothing in the run reports it.

This is not hypothetical. During the post-batch-8 sweep `main` moved
`5d1a641` → `9cb1d4d` and the deployed instance was restarted mid-run by
a concurrent agent. That run's results held up only by luck: the commits
touched `apps/cli` and docs, so nothing under test changed. Had they
touched `apps/api`, every scenario after the restart would have been
measuring a different build than the ones before it, and the report would
have said 14/14 PASS either way.

So pin the base and check it:

**Before spawning the sweep** — record the sha the sweep is about:

```bash
cd ~/Works/agent-hq-orchestron && git rev-parse HEAD
```

Put it in the brief and in the report header. A report without a base sha
cannot be reproduced or superseded.

**If `main` moves during the sweep**, the blast radius decides:

| Commits touched | Verdict |
|---|---|
| `apps/api` or `apps/web` | **Restart the sweep** from the new HEAD. The instance under test was rebuilt or restarted; results from before the move describe a build that no longer exists. |
| `apps/cli`, `apps/tui`, `docs/`, `test/`, `scripts/` only | Sweep stays **valid**. Record the drift (`<old>..<new>`) in the report and say which files moved. |
| Mixed | Treat as the first row. Partial validity is not worth adjudicating scenario by scenario. |

Check it, do not assume:

```bash
git diff --name-only <base-sha> HEAD | cut -d/ -f1-2 | sort -u
```

**After the sweep**, verify the sha is still the one you started from. If
it moved, the table above applies, and a sweep that came out clean still
needs a post-sweep sanity check — re-run the two or three scenarios that
touch whatever the new commits changed, rather than re-running everything.

**The sweep script must do this itself.** Read `main`'s sha at the start
and at the end, carry both into the final report, and on a mismatch
**warn in the report** with the drift range and the touched top-level
paths. A human reading the report is the last line of defence here, and
they can only act on drift the report mentions.

```bash
BASE_SHA="$(git -C ~/Works/agent-hq-orchestron rev-parse HEAD)"
# … run the sweep …
END_SHA="$(git -C ~/Works/agent-hq-orchestron rev-parse HEAD)"
[ "$BASE_SHA" = "$END_SHA" ] || echo "WARN: main drifted $BASE_SHA..$END_SHA during the sweep"
```

One more coordination rule, learned the same way: **do not restart the
deployed instance during someone else's sweep.** If a deploy cannot wait,
say so in the sweep's channel first — a restart mid-run invalidates every
uptime, session-state and rate-limit assertion already taken.
