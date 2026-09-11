# Settings — E2E Test Plan

`/settings` — server info, the restart commands, the theme picker, and
the token-rotation instructions.

**The page is read-only apart from the theme.** Its own subtitle says
so: *Server configuration — read-only view*. Every server-side value is
displayed, never edited; the two things it offers are a **copyable
command** you run in a terminal and a **theme select** that writes to
`localStorage`. Scenarios expecting in-page toggles for log level,
adapters or concurrency are expecting a page that does not exist — the
config keys are real, the UI for them is not, and `SET-03` and `SET-04`
below cover them where they actually live.

[`feature-flag.md`](feature-flag.md) `FLAG-01` covers the headless flag
*state* as read from this page; this file covers everything else on it.

Spec: [USAGE.md § Themes & appearance](../USAGE.md#7-themes--appearance)
· [USAGE.md § Configuration](../USAGE.md#configuration)

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- A paired browser (the page is authed — it reads
  `/api/health/detail`).
- For `SET-03` and `SET-04`: willingness to **edit `config.json` and
  restart the API**. Run them last, and only against the isolated
  instance.

---

## Scenarios

### SET-01 — Theme select, and where it persists `[smoke]`

**Covers**: the one interactive control on the page, the `localStorage`
key behind it, and that it is **per-browser** rather than per-server.
Also that the OS colour scheme has no say — a common wrong assumption
in automated runs.

**Steps**

1. Open `$ORCH_WEB/settings` and find the **Appearance** section.
2. Read the three options.
3. Pick **Light**. Watch the page without reloading.
4. Read the storage and the root element:

   ```js
   localStorage.getItem('orchestron_theme')
   document.documentElement.getAttribute('data-theme')
   document.documentElement.classList.contains('dark')
   ```

5. Reload. Then navigate to `/dashboard`, `/metrics` and `/graph`.
6. Pick **Tycho**, then **Orchestron**, checking storage each time.
7. Emulate the OS dark/light preference
   (`prefers-color-scheme`) **without** touching the select.
8. Clear the key and reload:
   `localStorage.removeItem('orchestron_theme')`.
9. Set a junk value and reload:
   `localStorage.setItem('orchestron_theme','neon')`.

**Expect**

- Three options, labelled **Orchestron (default dark)**, **Tycho (warm
  orange)** and **Light**, next to a palette icon. The body text says
  the choice is **saved per-browser** — assert that claim in step 5 by
  confirming a second browser profile is unaffected.
- The theme applies **immediately**, with no reload.
- Storage key is exactly **`orchestron_theme`**; values are
  `orchestron` / `tycho` / `light` — the raw slug, not the label.
- `<html data-theme>` matches the slug. `light` **removes** the `dark`
  class and adds `light`; both `orchestron` and `tycho` keep `dark`.
  So `tycho` is a dark theme with `data-theme="tycho"`, and a scenario
  that tests "dark mode" by the class alone cannot tell them apart.
- The theme holds across reloads and across every route in step 5,
  including `/graph`, whose React Flow chrome follows it live (see
  [`graph.md`](graph.md) `GRAPH-05`).
- **Step 7 changes nothing.** The app never reads
  `prefers-color-scheme`; the only input is the stored slug. An
  automated run that sets `colorScheme` on the browser context and
  expects the app to follow will report a false failure — set the
  `localStorage` key instead.
- Steps 8 and 9 both fall back to **`orchestron`**. An unknown value is
  treated as unset, not as an error, and nothing is written back until
  the user picks something.

**📷 Screenshot**: `set-01-themes.png` — the Appearance section in all
three themes.

**Cleanup**: restore **Orchestron**.

---

### SET-02 — Server Info rows, and the two health endpoints

**Covers**: every row in the **Server Info** section, and the security
split behind them — `/api/health` is anonymous and says almost nothing;
the verbose fields moved to `/api/health/detail` behind the Bearer
token.

**Steps**

1. Read all seven rows on the page.
2. Compare with both endpoints:

   ```bash
   . ~/.orchestron-e2e/e2e.env
   curl -s "$ORCH/api/health"                                   # no auth
   curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/health/detail" | python3 -m json.tool
   curl -s -o /dev/null -w 'detail unauth → %{http_code}\n' "$ORCH/api/health/detail"
   ```

3. Read the **Configuration** section: the config path and both restart
   commands.
4. Click the copy button on the **Linux** command, then paste
   somewhere.
5. Read the **Bearer Token** section and the amber note.
6. Break the endpoint (stop the API) and reload the page.

**Expect**

- Rows, in order: **Status**, **Bind host**, **Remote auth**, **Max
  concurrent**, **tmux**, **Headless mode**, **Storage dir**. Each
  matches the corresponding `/api/health/detail` field.
- **Status is hardcoded `online`** with a green check — it is not a
  probe. If the page rendered at all, the fetch succeeded. Do not treat
  it as a health signal.
- **Remote auth** reads `enabled` with a shield when a `remoteToken` is
  set, `disabled` with a struck-through shield otherwise. It reports
  whether a token **exists**, never its value.
- **tmux** is the `tmux -V` string, or `unavailable` where tmux is not
  installed — the row renders either way.
- Anonymous `/api/health` returns exactly `{"ok":true}` — **no**
  `storage`, `bindHost`, `remoteAuth`, `maxConcurrent`, `platform` or
  `tmux`. That minimalism is deliberate (an unauthed caller on the
  tailnet must not be able to fingerprint the host), so a scenario
  asserting rich fields on `/api/health` is asserting a security
  regression. `/api/health/detail` without the header is **401**.
- Config path shows `~/.orchestron/config.json`. **Both** restart
  commands are shown — Linux `systemctl` and macOS `launchctl` — with a
  green **THIS HOST** badge on the one matching `platform`. The
  `launchctl` form uses `$(id -u)`, resolved on the target machine at
  paste time, not the serving host's uid.
- The copy button copies the **exact** command string and flips to a
  green check for ~1.5 s.
- **Bearer Token** offers no in-page rotate — only the copyable
  `orchestron token rotate` and an amber note to re-scan the QR at
  `/pair` afterwards. **The page never displays the token**; assert its
  absence, and do not add a scenario that asks for it.
- Step 6 shows the red **Failed to load server info** panel with the
  error message, and the Server Info rows are absent — not zeroed, not
  stale.

> **`orchestron token rotate` — fixed at `a4a28dd`, verify it stays
> fixed.** It used to write `config.json` key **`token`** while the API
> read **`remoteToken`**, so rotate printed a token that never
> authenticated and left the old one working — the page advertising it
> as the way to *"invalidate all existing PWA sessions"* while it did
> nothing (B6-F1, the only high-severity finding of the batch-6 sweep).
> Batch-7 settled `remoteToken` as canonical and moved the CLI onto it,
> with two migration layers for configs already written the old way: an
> in-memory fold in `loadConfig` and a one-shot rewrite at API boot.
> **Verify it now works**: rotate, restart the API (the process caches
> the token at boot — the command prints that reminder for a reason),
> then confirm the new token authorises and the old one 401s. A sweep
> that reports "rotate is a no-op" is reading this note's pre-`a4a28dd`
> revision, not the running code.

**📷 Screenshot**: `set-02-server-info.png` — all seven rows plus the
THIS HOST badge.

**Cleanup**: restart the API if step 6 stopped it.

---

### SET-03 — Log level lives in config, not in the UI

**Covers**: `logLevel` — a real config key with **no** surface on this
page. The scenario covers the key where it actually works and pins the
absence so that "add a log level dropdown" is a deliberate change.

**Steps**

1. Search the Settings page for any log-level control — a select, a
   row, a mention.
2. Read the current value and the valid set:

   ```bash
   python3 -c "import json,os;p=os.path.expanduser('~/.orchestron-e2e/config.json');print(json.load(open(p)).get('logLevel','<unset>'))"
   ```

3. Set `logLevel` to `debug` in the isolated instance's `config.json`,
   restart the API, and watch the log:

   ```bash
   ./scripts/e2e-env.sh logs api | tail -30
   ```

4. Set it to `error` and restart again.
5. Try an invalid value (`trace`) and restart.
6. Override it from the environment instead:
   `ORCHESTRON_LOG_LEVEL=debug`.

**Expect**

- **No log-level control anywhere on the page**, and no Server Info row
  for it — `/api/health/detail` does not return `logLevel` either. The
  only way to see or change it is the config file or the environment.
- Valid values are exactly `error`, `warn`, `info`, `debug`; the
  default is **`info`**.
- `debug` visibly increases log volume; `error` visibly reduces it.
  Assert the direction, not a line count.
- An invalid value **fails schema validation at boot** — the API does
  not fall back to `info` silently. Record the actual failure mode
  (refuses to start, or starts with an error) as the observed
  behaviour.
- `ORCHESTRON_LOG_LEVEL` takes precedence over the file value.
- **The API reads config once at boot.** Every change in this scenario
  needs a restart; a change with no restart must show **no** effect.
  That is the assertion, not a caveat.

**Cleanup**: restore `logLevel` (or remove the key) and restart.

---

### SET-04 — The adapter matrix lives in config, not in the UI

**Covers**: `config.adapters` — three booleans that decide which
adapters are registered **at boot**. Also the gap they create: the
project form offers all three harnesses regardless, so a project can be
registered for an adapter the server will not run.

**Steps**

1. Search the Settings page for any adapter list or enable/disable
   control.
2. Read the current matrix:

   ```bash
   python3 -c "import json,os;p=os.path.expanduser('~/.orchestron-e2e/config.json');print(json.load(open(p)).get('adapters','<unset>'))"
   ```

3. Open the **Register Project** dialog and read the Agent Type
   options.
4. With `adapters.codex` **false** (the default), register a project
   with Agent Type `codex` and try to spawn a session against it.
5. Set `adapters.codex` to `true`, restart the API, and retry the
   spawn.
6. Set `adapters.claude` to `false`, restart, and observe.

**Expect**

- **No adapter control on the page**, and no Server Info row for it.
  `/api/health/detail` does not report the matrix — so the UI gives no
  way to discover which adapters are live.
- Defaults are `claude: true`, **`codex: false`**, **`opencode:
  false`**.
- Step 3: the Agent Type select offers **all three** unconditionally.
  It is not filtered by the matrix. That mismatch is the point of this
  scenario — assert the select shows three options even when only one
  adapter is registered.
- Step 4: registration **succeeds** (the registry does not validate the
  harness against the matrix) and the **spawn fails**. Record the exact
  status and message; the failure surfaces at spawn time, which is late
  and far from the cause.
- Step 5: after the restart the same spawn works, given a working codex
  credential ([`00-setup.md`](00-setup.md) § 3).
- Step 6: with claude disabled, every claude spawn fails the same way.
  Do not leave the instance in this state.
- Restart required for every change, as in `SET-03`.

**Cleanup**: restore the matrix to `{claude: true, codex: false,
opencode: false}`, restart, and delete the codex project from step 4.

---

### SET-05 — `/api/readiness` answers the anonymous probe `[smoke]`

**Covers**: the readiness endpoint — its anonymous access, its body,
and the 503 path. Added in batch-8; before that the path was in
`AUTH_WHITELIST` and in `HLD.md` but **no route served it**, so it
answered 404 to everyone (NF13). It went unnoticed for months because
`apps/api/tests/auth.test.ts` registered a `/api/readiness` stub in its
own fixture and asserted the whitelist against that.

**Steps**

```bash
. ~/.orchestron-e2e/e2e.env
curl -s -o /dev/null -w 'anon      → %{http_code}\n' "$ORCH/api/readiness"
curl -s -o /dev/null -w 'bad token → %{http_code}\n' -H 'Authorization: Bearer nope' "$ORCH/api/readiness"
curl -s "$ORCH/api/readiness" | python3 -m json.tool
```

**Expect**

- **200** on all three of anonymous, wrong bearer and good bearer — it
  is whitelisted, so the bearer check never runs.
- Body is `{"status":"ready","uptime":<seconds>,"checks":{"config":true,
  "storage":true,"adapters":true}}`. `uptime` is `process.uptime()`
  rounded, so it grows across two calls and resets on restart — a cheap
  way to confirm a deploy actually restarted the process.
- **No host detail in the body**: no `dataDir` path, no `bindHost`, no
  adapter names. Same reasoning as anonymous `/api/health` — an
  unauthed caller on the tailnet must not be able to fingerprint the
  host. A scenario asserting rich fields here is asserting a security
  regression.
- **It does not gate on tmux**, though `HLD.md` once said it would. A
  headless-only instance with no tmux installed is ready; failing it
  would mark a working server permanently unhealthy to a balancer.
- A failing check returns **503** with `status:"not_ready"` and the
  offending check `false`. Not reproducible against a healthy instance
  without breaking it — the unit suite
  (`apps/api/tests/routes/readiness.test.ts`) covers the unwritable
  data dir and the empty adapter registry instead. **Do not make the
  data dir unwritable on a live E2E instance to see it.**

**Cleanup**: none.

---

### SET-06 — The idle chip states the server's real sleep threshold

**Covers**: NF14. Both idle chips (dashboard card and session header)
used to hardcode *"Auto-sleeps at 15 min."* and an amber warning at a
flat 10 minutes — the schema default, not the value in force. The E2E
instance runs `idleTimeoutMs: 60000`, so the tooltip was 15x off and
the amber warning, meant to fire five minutes before sleep, never fired
at all.

**Steps**

1. Confirm the instance's threshold, and that the server publishes it:

   ```bash
   . ~/.orchestron-e2e/e2e.env
   curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/health/detail" \
     | python3 -c 'import json,sys; print(json.load(sys.stdin)["idleTimeoutMs"])'
   ```

2. Bring a session to `idle` (any completed turn) and hover its chip on
   the dashboard, then on `/session/<id>`.

**Expect**

- `/api/health/detail` carries **`idleTimeoutMs`**, matching the
  instance's config — 60000 on the E2E instance, 900000 on a default
  one.
- Both tooltips read **`Idle since <time>. Auto-sleeps at 1 min.`** on
  the E2E instance. **`15 min` appearing anywhere is the regression**,
  and it is what the pre-batch-8 build printed.
- The chip turns amber at `idleTimeoutMs − min(5 min, timeout/3)`: at
  40s in on a 60s instance, at 10 minutes on a default one — the latter
  reproducing the old rule exactly, which is the point of expressing it
  as remaining time rather than as a constant.
- Formatting boundaries are unit-tested in
  `apps/web/lib/idle-chip.test.ts` (`45s`, `1 min`, `15 min`, `1h 30m`,
  and `disabled` for `idleTimeoutMs: 0`); do not re-derive them by
  reconfiguring a live server.

**Cleanup**: none.

---

## Notes for scenario authors

- **Read-only means read-only.** Theme is the only thing this page
  writes, and it writes to the browser. Anything server-side changes in
  `config.json` plus a restart. A PR that adds an editable server field
  here needs a new scenario, not an edit to `SET-02`.
- **Two health endpoints, on purpose.** Keep `/api/health` (anonymous,
  `{ok:true}`) and `/api/health/detail` (Bearer, verbose) apart in
  every assertion. Conflating them is how the security split gets
  quietly undone.
- **`platform` and `uid` exist only to render the restart commands.**
  They are the reason the macOS command is correct when read on Linux.
  Do not repurpose them as general host facts in other scenarios.
- **Do not screenshot the Bearer Token section on a real instance
  without checking.** The page does not print the token, but a terminal
  or another tab in frame might.
- **Cost: zero.** Nothing here spawns except `SET-04` step 4/5, which
  are *meant* to fail and cost nothing when they do. `SET-03` and
  `SET-04` restart the API, so run them after every other file.
