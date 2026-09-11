# Pairing — E2E Test Plan

`/pair?token=<token>` — how a phone, tablet or second browser gets the
bearer token. The page is a **token sink**, not a handshake: it reads
the token out of the query string, writes it to `localStorage` and
`sessionStorage`, and redirects to the dashboard.

Three things it deliberately does not do, and no scenario should expect:

- **No pair code.** There is no code to read out and type in. The token
  travels in the URL, usually via a QR code from the CLI.
- **No exchange.** The page never calls the API. Nothing is verified,
  consumed or registered server-side.
- **No expiry.** The token is the long-lived `remoteToken`. Pairing
  links do not time out; a stale QR photo pairs fine months later.

Spec: [USAGE.md § Pairing & mobile](../USAGE.md#8-pairing--mobile)

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- **A second browser profile or an incognito window**, so a failed
  pairing does not cost you the working session in your main window.
- The token to hand: `./scripts/e2e-env.sh token`.

> **Handle the token like a credential.** It grants full access. Do not
> put it in a screenshot, a report or a commit. Where a scenario says
> "read the stored value", assert its **shape** (64 hex characters) and
> that it **matches `$TOKEN`** — never print it.

---

## Scenarios

### PAIR-01 — A pairing link stores the token and lands on the dashboard `[smoke]`

**Covers**: the whole pairing path. If this regresses, no phone can
reach the instance, and every other mobile scenario in the plan is
blocked.

**Steps**

1. In a clean browser profile with no stored token, open
   `$ORCH_WEB/pair?token=$TOKEN`.
2. Watch the page for the first two seconds.
3. Note where you end up.
4. In DevTools read both storages:

   ```js
   localStorage.getItem('orchestron_token')?.length
   sessionStorage.getItem('orchestron_token')?.length
   ```

5. Open `$ORCH_WEB/dashboard` in a new tab of the same profile.

**Expect**

- A spinner and the word `Pairing…` first, then a `✓` and
  `Token stored. Redirecting to Dashboard…`.
- The redirect to `/dashboard` fires after roughly **1.2 s** — long
  enough to read the confirmation. It is a `router.push`, so **Back
  returns to `/pair`**, which immediately re-pairs and pushes forward
  again. Note that loop; it is the expected behaviour of this design,
  not a bug to file.
- **Both** storages hold the token under the key
  `orchestron_token`, and both match `$TOKEN`.
- The dashboard in step 5 loads sessions rather than erroring — the
  token is picked up by `fetchJson` from `localStorage` on any tab of
  that origin.
- The whole flow completes with **zero calls to the API from the pair
  page itself**. Check the network tab: requests start only once the
  dashboard loads.

**📷 Screenshot**: `pair-01-done.png` — the `✓` state. Crop or blur the
URL bar; it contains the token.

**Cleanup**: keep the paired profile — later scenarios need it.

---

### PAIR-02 — No token in the URL

**Covers**: the only error state the page has, and the instruction it
gives.

**Steps**

1. Open `$ORCH_WEB/pair` with no query string.
2. Read all three lines of the state.
3. Read the command it names, then try it:

   ```bash
   orchestron qr      # what the page tells you to run
   orchestron --help  # confirm it is a registered command
   ```

4. Confirm nothing was written:

   ```js
   localStorage.getItem('orchestron_token')   // in a clean profile
   ```

**Expect**

- A `✗`, then `No token found in URL.` in red, then a hint in grey
  naming a CLI command.
- No redirect. The page stays put — unlike the success path, there is
  no timer.
- Storage is untouched: a clean profile still reads `null`, and an
  already-paired profile **keeps its existing token**. Visiting `/pair`
  bare must never clear a working pairing.
- **The named command is `orchestron qr`, and it exists.** The CLI
  registers `qr`, `token`, `project`, `session`, `schedule`, `serve`,
  `tui` and `doctor` — `qr` is the one that prints the pairing QR.
  *Until batch-7 the page said `orchestron pair`, which was never a
  registered command (B6-F4). If this text reads `pair` again, that is
  a regression, not a doc drift.*
- `orchestron qr` must actually find the token. It reads
  `ORCHESTRON_REMOTE_TOKEN`, then `--token`, then the `remoteToken` key
  of `config.json` (legacy `token` as a fallback). A provisioned
  instance with no env var set must still print a pair URL — that path
  was broken alongside the copy (B6-F1).
- An **empty** token (`/pair?token=`) takes the same branch as no token
  at all — `searchParams.get` returns `''`, which is falsy. Confirm the
  `✗` state, not a stored empty string.

**📷 Screenshot**: `pair-02-no-token.png` — all three lines.

**Cleanup**: none.

---

### PAIR-03 — A wrong token pairs anyway, and fails later

**Covers**: the consequence of there being no verification step. This is
the scenario most likely to be written wrong, because the intuitive
assertion ("an invalid token is rejected") is the opposite of what
happens.

**Steps**

1. In a clean profile, open `$ORCH_WEB/pair?token=deadbeef` —
   syntactically nothing like a real token.
2. Read the state and where you land.
3. Read what the dashboard shows.
4. Check storage.
5. Now rotate the real token out from under a **paired** profile and
   reload its dashboard:

   ```bash
   # read the live value first so you can put it back
   python3 -c "import json,os;p=os.path.expanduser('~/.orchestron-e2e/config.json');print(json.load(open(p))['remoteToken'])"
   ```

**Expect**

- **The page accepts `deadbeef`**: `✓`, `Token stored.`, and the
  redirect to `/dashboard`. There is no validation of any kind — not
  length, not charset, not a server check.
- The dashboard then fails to load data. The API answers **401** to
  every authed request and the page shows its load-error state — so the
  user's first sign of a bad pairing is a broken dashboard, not a
  pairing error.
- `localStorage` holds the literal string `deadbeef`. A bad pairing is
  **sticky**: it survives reloads, and recovering means `/pair` with a
  good token or `/reset` (see [`reset.md`](reset.md)).
- In step 5, a token that was valid at pairing time and is no longer
  behaves identically — 401s on the dashboard, no prompt to re-pair.
  "Expired" and "never valid" are the same state here.

> **Where this could bite.** The token lands in the URL, so it reaches
> browser history, the `Referer` header on any outbound link, and any
> reverse-proxy access log in front of the web port. The CLI prints a
> `SECURITY WARNING` about screen-sharing the QR for exactly this
> reason. The API has a better primitive — `POST /api/sse-ticket`, a
> 60 s single-use ticket — but it is unused by web code and does not
> apply to pairing. Out of scope for a sweep; recorded so it is not
> rediscovered as new.

**Cleanup**: re-pair the scratch profile with the real token, or close
it. Restore `remoteToken` if step 5 changed it, and restart the API.

---

### PAIR-04 — The install prompt

**Covers**: the PWA install card, the one piece of this page that is not
about tokens. It is driven by the browser's `beforeinstallprompt`, so it
is conditional on the browser and cannot be forced.

**Steps**

1. In a Chromium-based browser, with the instance **not** already
   installed, open a valid pairing link.
2. Watch for a card below the `✓`.
3. If it appears, click **Install** and complete the browser's dialog.
4. Re-run the pairing link and confirm the card's state.
5. Repeat step 1 in Firefox or Safari.

**Expect**

- Where the browser fires `beforeinstallprompt`: a card reading
  **Install as app**, with **Install** and **Skip**.
- **Skip** dismisses the card for that page view only.
- **Install** opens the browser's own install dialog; accepting hides
  the card.
- The card does **not** block the redirect — the dashboard push still
  fires at ~1.2 s, so the card is only readable if you are quick or the
  redirect is paused. Report this if the card is effectively
  unreachable in practice; it is a plausible real defect rather than a
  test artefact.
- In browsers that do not implement the event (Firefox, Safari), **no
  card appears and nothing breaks**. Record `skip` with the browser
  name — an absent card there is correct, not a failure.

**Cleanup**: uninstall the PWA if step 3 installed it.

---

## Notes for scenario authors

- **`orchestron qr` is the producer, `/pair` is the consumer.** The CLI
  builds `http://<resolved host>:<port>/pair?token=<token>` and renders
  it as a terminal QR. Its default port is **3010** — the deployed web
  port — so in the isolated environment (**3011**) pass `-p 3011` or the
  QR points at the wrong instance.
- **`orchestron qr` may not find a token even when one is configured.**
  It reads `config.json` key **`token`**, while the API reads
  **`remoteToken`**. On a normally provisioned instance the CLI
  therefore falls back to `ORCHESTRON_REMOTE_TOKEN` or exits with "no
  token found". Pass `--token "$TOKEN"` in scenarios rather than
  relying on config discovery. Same root cause as the
  [`settings.md`](settings.md) `SET-02` note on `token rotate` — one
  key mismatch, two symptoms.
- **Every scenario here is free.** Nothing spawns, nothing runs a turn,
  nothing calls the API from the page. Cost is zero; run the file
  whenever auth or storage is touched.
- **Use a scratch profile.** `PAIR-03` deliberately stores a broken
  token. Doing that in your working browser costs you a `/reset` and
  your theme, collapse state and filters with it.
