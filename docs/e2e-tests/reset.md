# Reset — E2E Test Plan

The escape hatch for a browser that has wedged itself: a stale service
worker, a poisoned cache, a bad token that makes every page 401.

There are **two** reset surfaces, and the difference matters:

| Route | Served by | Auth | Why it exists |
|---|---|---|---|
| `/reset` | web (Next) | via the app | the normal one |
| `/api/reset` | api (inline HTML) | **none** — whitelisted | works when the service worker is what is broken |

They do the same four things. `/api/reset` exists because a broken
service worker on the web origin can serve a stale `/reset` — so the
API hands you an identical page from an origin the worker does not
control.

**Neither asks for confirmation.** Both start wiping on load. That is
the single most important fact in this file and the thing every
scenario here is shaped around.

Spec: [USAGE.md § Pairing & mobile](../USAGE.md#8-pairing--mobile) ·
`/api/reset` is inline in `apps/api/src/server.ts`.

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- **A scratch browser profile, paired, with state worth losing** —
  a non-default theme, a collapsed project group, a dashboard filter.
  The scenarios verify those are gone, which needs them there first.
- **Do not run this file in the browser profile you are working in.**
  It will clear your token and every preference. This is the one file in
  the plan that is destructive to the *client*.

---

## Scenarios

### RESET-01 — `/reset` wipes client state on load, with no confirmation `[smoke]`

**Covers**: the four wipe steps, the log they write, and the absence of
a confirm gate. If a confirmation dialog is ever added, this scenario is
the spec that has to change first — and it should, because the current
behaviour means a mis-typed URL is unrecoverable.

**Steps**

1. In the scratch profile, set up recognisable state: switch the theme
   to **Tycho**, collapse a project group on the dashboard, and confirm
   `localStorage` has several `orchestron_*` keys:

   ```js
   Object.keys(localStorage).filter(k => k.startsWith('orchestron'))
   ```

2. Load the dashboard once so the service worker registers, and confirm
   it:

   ```js
   navigator.serviceWorker.getRegistrations().then(r => console.log(r.length))
   caches.keys().then(console.log)
   ```

3. Open `$ORCH_WEB/reset`.
4. Read the log as it fills, **without clicking anything**.
5. Wait out the redirect.
6. Re-run the step 1 and step 2 probes.

**Expect**

- **No confirmation of any kind.** No dialog, no button, no "are you
  sure". The page reads `Resetting...` and work has already begun by
  the time it paints — the wipe runs in an effect on mount.
- The page body is bare white-on-black monospace with the heading
  `Orchestron Reset`, inline-styled and **theme-independent** on
  purpose. But it is a normal route inside the root layout, so **the
  global nav bar still renders above it** — the version chip and the
  six nav links are in frame. Only `/api/reset` (`RESET-03`) is truly
  standalone, which is part of why it exists.
- The log lists, in order, one line per thing actually done:
  - `✓ Unregistered SW: <scope>` per worker, or `- No SW registered`
  - `✓ Deleted cache: <key>` per cache, or `- No caches`
  - `✓ Cleared session + local storage`
  - `✓ Deleted DB: <name>` per IndexedDB database
- Then `Done. Refreshing in 3s...`, and after ~3 s a redirect to
  **`/pair`** — with no token, so it lands on the `✗ No token found`
  state from [`pairing.md`](pairing.md) `PAIR-02`. **That is the
  expected end state**: reset deliberately leaves you unpaired, and
  re-pairing is the next step, not a failure.
- After reset: zero service worker registrations, zero caches, an
  **empty** `localStorage` and `sessionStorage`, and the theme back to
  the **Orchestron** default.
- If storage is blocked (a hardened profile), the log shows
  `⚠ Could not clear storage` and the rest of the steps still run. The
  page must not die on the first failure.

**📷 Screenshot**: `reset-01-log.png` — the completed log including the
`Done.` line.

**Cleanup**: re-pair the profile (`PAIR-01`) and restore the theme.

---

### RESET-02 — What reset does not touch

**Covers**: the blast radius. Reset is **client-only** — it is easy to
assume a route called "reset" clears server data, and a scenario written
on that assumption would report a false pass when sessions survived.

**Steps**

1. Before resetting, record the server-side state:

   ```bash
   . ~/.orchestron-e2e/e2e.env
   curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/sessions" \
     | python3 -c 'import json,sys;d=json.load(sys.stdin)["sessions"];print(len(d));[print(s["id"][:8],s["status"]) for s in d]'
   curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/projects" \
     | python3 -c 'import json,sys;print([p["name"] for p in json.load(sys.stdin)["projects"]])'
   curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/metrics?groupBy=session" \
     | python3 -c 'import json,sys;print(json.load(sys.stdin)["total"])'
   ```

2. Leave one session **running** in tmux and note its window name:
   `tmux ls | grep orchestron`.
3. Run `/reset` in the scratch profile and let it finish.
4. Re-run every probe from step 1, and `tmux ls` again.
5. Re-pair and open the dashboard.

**Expect**

- **Identical** session list, project list and metrics totals — same
  count, same ids, same statuses, same numbers. Not one record touched.
- The running tmux session is **still running**, same window name. A
  browser reset does not signal the API at all: check the API log and
  confirm the only request it saw was for `/reset`'s own assets.
- On the client side, gone: token, theme (`orchestron_theme`), group
  collapse state, dashboard filters, service worker, caches.
- After re-pairing, the dashboard shows **every** session again, and
  the running one is still running. Preferences come back at their
  defaults, not at their pre-reset values.
- **IndexedDB deletion is not scoped to Orchestron.** The code
  enumerates `indexedDB.databases()` and deletes **every** database on
  the origin, despite the comment saying "if any orchestron key". On a
  dedicated origin that is harmless and it is why the wipe is thorough
  — but note it, because it means the page is not safe to serve from an
  origin shared with anything else.

**Cleanup**: re-pair. Kill the step 2 session if the run is over.

---

### RESET-03 — `/api/reset`, the service-worker-proof one

**Covers**: the API-served twin, its anonymous access, and the redirect
at the end of it — which lands on a path the API does not serve.

**Steps**

1. Confirm it needs no token:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' "$ORCH/api/reset"          # no header
   curl -s "$ORCH/api/reset" | head -5
   ```

2. In the scratch profile, pair it, then open `$ORCH/api/reset` —
   note the **API** port, not the web port.
3. Read the log.
4. Let the 3 s redirect fire and read the resulting page.
5. Check whether the web origin's state was affected:

   ```js
   // in a tab on the WEB origin
   localStorage.getItem('orchestron_token')
   ```

**Expect**

- `200` with `Content-Type: text/html` and **no Authorization header**
  — `/api/reset` is in the auth whitelist alongside `/api/health`,
  `/api/readiness` and `/api/version`. That is deliberate: a Bearer
  token should not be required to un-wedge a browser, and the page
  reads nothing from the server.
- The log has the same four phases as `/reset`, with terser labels
  (`✓ Cleared storage`, `✓ Deleted IDB: <name>`).
- **It clears the API origin, not the web origin.** Storage, caches and
  service workers are per-origin, so running it on `:8091` leaves the
  web origin's token in place — step 5 still returns the token. This is
  the scenario's real point: `/api/reset` un-wedges a worker registered
  on the API origin, and is **not** a substitute for `/reset` when the
  web origin is the broken one. Reach for it when `/reset` itself will
  not load.
- **The final redirect lands on `401 Unauthorized`, not on the pairing
  screen — and not on a 404 either.** The page sets
  `window.location.href = '/pair'`, resolved against the **API**
  origin. The API serves no `/pair` route, but the auth plugin's
  `preHandler` runs first on every URL outside the whitelist, so the
  browser ends on `{"error":"Unauthorized"}` from `http://<api
  host>:<api port>/pair` — and it has just cleared the token it would
  have needed. Assert the **401**; guessing 404 is the natural mistake
  and it is wrong. The wipe itself completed; only the last hop is
  broken, and it is one absolute URL away from correct. Record it as a
  real defect; do not fix it in a sweep.

**📷 Screenshot**: `reset-03-api.png` — the log, plus the page the
redirect lands on.

**Cleanup**: re-pair the profile on the web origin.

---

## Notes for scenario authors

- **Run this file last, or in a throwaway profile.** It is the only
  file that destroys client state, and `RESET-01` takes your token with
  it.
- **`/reset` is not in the nav and not linked from anywhere.** Like
  `/session-diag` ([`diagnostics.md`](diagnostics.md) `DIAG-05`) it is
  typed by hand or pasted from a support message. Do not add a scenario
  that looks for a button.
- **Do not assert "reset fixes a broken service worker" end to end.**
  Manufacturing a genuinely poisoned worker is not reliably scriptable.
  Assert what is observable — registrations before and after — and
  leave the diagnosis to the person who reached for the page.
- **Server-side reset does not exist.** To clear *server* state, use
  `./scripts/e2e-env.sh down` (wipes the isolated data dir) or
  `reset` (down + up). Nothing in the UI does it, and nothing in this
  file should imply otherwise.
- **Cost: zero.** No spawns, no turns. The only expense is re-pairing
  and re-setting your preferences afterwards.
