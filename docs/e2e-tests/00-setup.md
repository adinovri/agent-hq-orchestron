# Setup — Global Preconditions

Everything every other file in this directory assumes. Read once, get
the fixtures in place, then go to the scenario file you need.

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

## 2. Auth

- Bearer token from `remoteToken` in `~/.orchestron/config.json`.
- The browser has been paired (visit `/pair`, or open the dashboard with
  the token in the query string once — it lands in `localStorage`).
- For any scenario step that curls the API directly:

```bash
export ORCH=http://127.0.0.1:8090
export TOKEN="$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('~/.orchestron/config.json')))['remoteToken'])")"
curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/health/detail" | head -c 400
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

## 4. Fixture projects

Register these once. Every scenario names the one it uses.

| Fixture name | Path | Agent | Defaults |
|---|---|---|---|
| `e2e-claude` | `/tmp/orchestron-e2e/ws-claude` | claude | none — model, effort and mode all unset |
| `e2e-claude-opus` | `/tmp/orchestron-e2e/ws-opus` | claude | default model `claude-opus-5`, default effort `high` |
| `e2e-headless` | `/tmp/orchestron-e2e/ws-headless` | claude | **Use tmux by default** unticked |
| `e2e-codex` | `/tmp/orchestron-e2e/ws-codex` | codex | none — *optional, only for codex-marked scenarios* |

The three claude fixtures exist so that "what did this field inherit
from" is testable: `e2e-claude` has nothing to inherit, `e2e-claude-opus`
has model and effort, `e2e-headless` has a mode. A scenario that asserts
a `(project)` source tag needs a project that actually sets the value.

```bash
mkdir -p /tmp/orchestron-e2e/ws-claude /tmp/orchestron-e2e/ws-opus \
         /tmp/orchestron-e2e/ws-headless /tmp/orchestron-e2e/ws-codex
```

Register them through the **Projects** page rather than by writing JSON,
so registration itself gets exercised.

> The paths must exist before registration — the form rejects a path
> that does not.

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

## 8. Isolation (Phase 2 — not built yet)

Today these scenarios run against your real orchestron. That is
survivable for a manual sweep and unacceptable for an automated one.
Phase 2 gives a run its own everything:

| | Real | E2E (planned) |
|---|---|---|
| Data dir | `~/.orchestron/` | `~/.orchestron-e2e/` |
| API port | 8090 | 8091 |
| Web port | 3010 | 3011 |
| Bearer token | yours | dedicated |
| `CLAUDE_CONFIG_DIR` | yours | `~/ClaudeConfigs/e2e/` |

Scenarios are written so that switching is a matter of pointing `$ORCH`,
the browser URL and the fixture config dir somewhere else — no scenario
hardcodes a path under `~/.orchestron/` in a step, only in an
explanation. Keep it that way when adding scenarios.

Until then: **do not run a full sweep on a host with live work on it.**
The kill, archive and delete scenarios do what they say.

## 9. Screenshots

Scenarios name a file, e.g. `spawn-01-dialog-defaults.png`. Put them
under `scratchpad/e2e-runs/<date>/`. They are evidence for a human
reviewing a run, and the seed corpus for Phase 3's screenshot-diff
assertions — so frame them tightly on the thing being asserted, not the
whole browser window.

Capture in the app's default theme (Orchestron dark) unless the scenario
is about theming.
