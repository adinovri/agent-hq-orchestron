# Diagnostics pane — E2E Test Plan

`/session-diag/<uuid>` — the deliberately dumb transcript dump. No
dedupe, no reconnect, no normaliser, no phantom filtering: an
`EventSource` on `/api/sessions/:uuid/stream`, one `<div>` per event,
in arrival order.

It exists to answer *"is the transcript wrong, or is the renderer
wrong?"* — so its value is entirely in being unlike the real pane. A
scenario that asks it to look polished is testing the wrong page.

Spec: none. This route is not in [`../USAGE.md`](../USAGE.md) and not in
the nav — it is a developer tool reached by typing the URL. That is
itself asserted below (`DIAG-05`).

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- **A session with a transcript.** Any session that has completed at
  least one turn. `e2e-haiku` + the fast prompt is enough.
- **A browser with the token in `localStorage`.** The pane reads
  `orchestron_token` from `localStorage`, falling back to
  `sessionStorage`. Visiting `/pair?token=…` once puts it there; see
  [`pairing.md`](pairing.md) `PAIR-01`.

> **Read this before writing assertions here.** The diag pane is the
> **only** SSE consumer left in the web app. The real transcript pane
> (`TranscriptPanePoll`) polls at 2 s — SSE was abandoned for it. So a
> diag-pane failure proves nothing about the real pane, and a diag-pane
> success does not exonerate polling. Keep the two apart in reports.

---

## Scenarios

### DIAG-01 — The pane opens the stream and renders raw events `[smoke]`

**Covers**: the whole diagnostic path in one shot — route param → token
read → `EventSource` → `transcript` listener → append → render. If this
regresses, every other diagnosis in this file is unreachable.

**Steps**

1. Pick a session with at least one completed turn:

   ```bash
   . ~/.orchestron-e2e/e2e.env
   curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/sessions" \
     | python3 -c 'import json,sys;[print(s["id"],s["status"]) for s in json.load(sys.stdin)["sessions"]]'
   ```

2. Open `$ORCH_WEB/session-diag/<uuid>`.
3. Read the amber banner at the top.
4. Read the grey status strip under it.
5. Send a turn into that session from a second tab
   (`$ORCH_WEB/session/<uuid>`) and watch the diag tab.

**Expect**

- **Amber banner**, full width, reading
  `DIAG mode · minimal transcript dump · session <uuid>` — the **full**
  uuid, not truncated to 8.
- **Status strip** reads `MINIMAL DIAG · status=open · lines=<n>`.
  `status` passes through `init` before settling on `open`; catching
  `init` needs a fast eye and is not required.
- `lines=<n>` is **non-zero** for a session with a transcript, and the
  count in the strip equals the number of rendered rows.
- Each row is one event, formatted `HH:MM:SS <type>: <text>` — a
  wall-clock time sliced out of the ISO timestamp, the raw event
  `type`, and at most **200 characters** of extracted content.
- Content blocks render as markers, not as structure:
  `[tool:<name>]`, `[result:<first 60 chars>]`, `[thinking]`, joined by
  ` | ` when one message carries several.
- During step 5 new rows **append at the bottom** and the view
  autoscrolls to them.
- `status` never reaches `error`.

**📷 Screenshot**: `diag-01-pane.png` — banner, status strip and at
least five event rows in one frame.

**Cleanup**: none. The page holds no server state.

---

### DIAG-02 — A uuid that does not exist

**Covers**: what the pane does with a bad route param. There is no
guard in the page: it takes the param on trust and opens a stream for
it. This scenario pins the *actual* behaviour so nobody "fixes" the
renderer when the truth is that the route never validates.

**Steps**

1. Open `$ORCH_WEB/session-diag/00000000-0000-0000-0000-000000000000`.
2. Read the banner and the status strip.
3. Confirm what the API says about that uuid:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' \
     -H "Authorization: Bearer $TOKEN" \
     "$ORCH/api/sessions/00000000-0000-0000-0000-000000000000/stream"
   ```

**Expect**

- The banner still renders, echoing the bogus uuid verbatim — **the
  page does not 404 and shows no error state of its own.**
- The status strip settles on `status=error · lines=0`.
- No retry: the pane has no reconnect logic, so `error` is terminal
  until a reload. Watch for 30 s and confirm the strip does not flap
  back to `open`.
- Nothing crashes — no blank page, no React error overlay.

> If a future change adds a "session not found" state to this page,
> this scenario is the one to update. Do not delete it: the absence of
> validation is load-bearing for `DIAG-03`.

**Cleanup**: none.

---

### DIAG-03 — Missing or stale token

**Covers**: the auth path, which is the diag pane's most likely real
failure and the one most easily misread as "the stream is broken".

**Steps**

1. In DevTools on the diag tab, run
   `localStorage.removeItem('orchestron_token'); sessionStorage.removeItem('orchestron_token')`.
2. Reload the diag URL.
3. Read the status strip.
4. Inspect the request the page made (Network tab → the `stream`
   request) and note its query string.
5. Restore the token by visiting `$ORCH_WEB/pair?token=$TOKEN`, then
   reload the diag URL.

**Expect**

- With no token, the pane requests `/api/sessions/<uuid>/stream` with
  **no** `?token=` at all, the API answers `401`, and the strip settles
  on `status=error · lines=0` — indistinguishable, on screen, from
  `DIAG-02`. That ambiguity is the finding this scenario records: the
  pane reports one `error` state for "no such session" and "not
  authorised" alike.
- With the token restored, the strip returns to `status=open` and rows
  appear.
- **The token travels in the URL query string**, not a header:
  `?token=<the long-lived remote token>`. Assert the shape, not the
  value, and do not paste the value into a report or a screenshot.

> `apps/api/src/plugins/auth.ts` offers a better mode —
> `POST /api/sse-ticket` mints a 60 s single-use `?ticket=` precisely so
> the long-lived token stays out of URLs, history and `Referer`. **No
> web code calls it.** The diag pane is the only SSE consumer and it
> uses the backward-compat token mode. Recorded here as a known gap on
> a developer-only route, not as a scenario failure.

**Cleanup**: leave the token in place for the next scenario.

---

### DIAG-04 — The 500-line cap and arrival-order rendering

**Covers**: the two properties that make this pane a diagnostic rather
than a viewer — it drops nothing on the way in, and it keeps only the
last 500 rows.

**Steps**

1. Open the diag pane on a session and note `lines=<n>`.
2. Send the **slow prompt** (`Count slowly from 1 to 40…`) into that
   session so a single turn emits many events.
3. Watch the strip climb while the turn runs.
4. Compare the rows against the raw rollout for the same turn:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/sessions/<uuid>" \
     | python3 -c 'import json,sys;print(json.load(sys.stdin)["jsonlPath"])'
   # then: wc -l <that path>
   ```

**Expect**

- `lines` only ever **increases** during a run; it never resets, and no
  row is replaced in place.
- Rows appear in **arrival order** with no grouping, no pairing and no
  collapsing. In particular the resume machinery the real pane hides —
  the injected pair, and the `"No response requested."` assistant row —
  is **visible here as ordinary rows**. That is correct: this pane is
  where you go to see them.
- `lines` never exceeds **500**. To see the cap, drive a session past
  500 events and confirm the strip sticks at `lines=500` while rows
  keep arriving — the **oldest** rows fall off the top.
- The pane does **not** dedupe: an assistant message that Claude Code
  splits into a thinking row and a text row shows as **two** rows with
  the same clock time. This is the NF9 shape that `/api/metrics`
  deduplicates; seeing both here is the expected contrast, not a bug.

**📷 Screenshot**: `diag-04-split-rows.png` — two adjacent rows with
the same `HH:MM:SS`, one `[thinking]`, one text.

**Cleanup**: none.

---

### DIAG-05 — The route is unlinked, and stays that way

**Covers**: that this is a typed-URL developer tool. Someone adding a
nav entry or a header button to it should have to change this scenario
first.

**Steps**

1. Open `$ORCH_WEB/dashboard` and read every nav link.
2. Open a session detail page and read every button and menu item in
   the header.
3. Search the rendered DOM for `session-diag`.

**Expect**

- The nav row carries exactly six links: **Dashboard, Projects,
  Schedules, Metrics, Graph, Settings**. No *Diagnostics*.
- No control anywhere in the session UI navigates to `/session-diag/…`.
- `document.body.innerHTML.includes('session-diag')` is `false` on both
  pages.
- The page still renders the global chrome — nav bar, theme, toasts —
  because it is inside the root layout like any other route. It is
  unlinked, not unstyled.

**Cleanup**: none.

---

## Notes for scenario authors

- **`h-full` needs the layout's `min-h-0`.** The pane is
  `flex flex-col h-full` inside `main.flex-1.min-h-0`. If a layout
  change drops `min-h-0`, this page degrades to zero height and looks
  "blank" while the stream is fine. Check the strip's presence before
  blaming SSE.
- **Do not add polish scenarios.** No timestamps beyond `HH:MM:SS`, no
  syntax highlighting, no virtualisation, no reconnect. Each of those
  would make the pane less useful for the job it exists for. If one is
  added anyway, it belongs in `session-details.md`, on the real pane.
- **Two traps for an automated runner.** First, `waitUntil:
  'networkidle'` **never fires** on this page — the `EventSource` is an
  open request for as long as the tab lives, so the navigation times
  out after 30 s. Use `domcontentloaded` and then wait. Second, do not
  read the strip out of `document.body.textContent`: it concatenates
  with no separator, so `lines=18` followed by a row beginning
  `02:13:44` reads back as `lines=1802`. Scope the selector to the
  strip element, and count rows with their own selector.
- **Cost.** Every scenario here rides on a session another file already
  created. Nothing in this file needs to spawn anything; `DIAG-04` is
  the only one that spends a turn, and one slow prompt on `e2e-haiku`
  covers it.
