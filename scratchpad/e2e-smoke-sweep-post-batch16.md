# E2E Phase 2 — resweep after batch 16 (NF29)

**BASE_SHA** `33d6f3ac7ea0d89f466394c8e373732b51685fa9` (`33d6f3a`) — read 05:47, before the first scenario
**END_SHA**  `33d6f3ac7ea0d89f466394c8e373732b51685fa9` (`33d6f3a`) — read 06:41, after the last measurement
**Drift verdict** **NO DRIFT.** Both §10 reads returned the same sha, `git diff --name-only BASE HEAD`
is empty, and the working tree was clean at both ends. Nothing in this report describes code that has
since moved.

**Scenarios** 17 attempted / 17 in the smoke set — **17 PASS · 0 PARTIAL · 0 FAIL · 0 SKIP**
**NF29 focused verify** the three batch-15 failures (Spawn, Delete Record, Fork) all **PASS**, each
with the navigation proven to have landed. `cleared` went **1 → 0** on exactly those three.
**NF28 regression matrix** 13 dialog instances × 4 paths = **52 / 52** (batch-15: 49/52).
**NF25** 13 dialogs × 8 = **104/104**. **NF26** **163/163**. **NF27** the 6 surfaces batch-15
measured: **78/78** — hold confirmed.
**Cost** `$0.31170` total in `/api/metrics`; **$0.31073 actually spent by this sweep**, adopted-transcript
contamination `$0.00097` (**0.31 %**). SPAWN-01 alone is **61.8 %** — structural, see Cost.
**Run** 2026-09-12, isolated env (`scripts/e2e-env.sh`, api :8091 / web :3011), Chromium/Playwright
1680×1000, harness `claude` on the E2E config dir. Browser footer read `v 33d6f3ac`.
**Evidence** `scratchpad/e2e-runs/2026-09-12-batch16/`.

**One new finding: NF30 (LOW)** — pre-existing, not a batch-16 regression.

---

## Headline

**NF29 is fixed, and fixed for the reason the commit message gives.** The three dialogs whose
success navigates away now keep focus on the page, and the mechanism measurement that *filed* NF29
reverses cleanly: the two audit passes are no longer cancelled.

| batch-15 measurement | batch-16 measurement |
|---|---|
| Spawn / Delete Record / Fork submit → `activeElement = BODY` | → `<main tabindex="-1">`, on the **new** route |
| `cleared = 1` on those three, `0` on the controls | `cleared = 0` on **all five**, every pass fires |
| `<main>` fallback alive but "never got a turn" | fallback is what catches all three |
| 49 / 52 | **52 / 52** |

The second half of the fix — `dispose()` scheduling a return instead of cancelling one, for a dialog
torn down while still open — is exercised here for the first time and **passes on all three**.

---

## Environment note, read this before trusting any earlier resweep

The isolated web bundle was **stale**, as it has been for five sweeps running.
`apps/web/.next-e2e` was built `2026-09-11 22:35` — the batch-15 bundle. Batch-16 was committed
`2026-09-12 05:41`. A bundle built four hours before the source existed cannot contain the fix, so
running NF29 against it would have produced a guaranteed-false result whichever way it came out.

Worse, and new: **`e2e-env.sh up` does not restart an already-running web unit.** After rebuilding,
`up` reported `ok web ready` while `orchestron-web-e2e.service` was still the process started
`2026-09-11 22:40`, serving batch-15 out of memory. Only an explicit
`systemctl --user restart orchestron-web-e2e.service` picked up the new bundle. See NF31.

What was done, and what was deliberately *not*:

- Rebuilt **only** `.next-e2e` (`e2e-env.sh build` leaves `apps/api/dist` alone when present, and
  writes web output to `.next-e2e`).
- The **deployed** instance was never rebuilt or restarted: `apps/web/.next/BUILD_ID` is still
  `mEcFHs0USVtOytc5UI6IK` at `05:45`, and `orchestron-{api,web}.service` still report their
  05:45/05:46 start times from the brief's own deploy.
- Confirmed in-browser rather than inferred: the page footer under test reads **`v 33d6f3ac`**.

`e2e-env.sh reset` was then run, because `fixtures` had recreated the five projects with new ids
and left all 47 sessions from the previous sweep pointing at deleted project ids. That also gave a
genuine `$0` cost baseline (`00-cost-baseline.json`).

---

## Scenario results

| Id | Result | Notes |
|---|---|---|
| SPAWN-01 | pass | navigated to `/session/<uuid>`; `useTmux=true`; model+effort absent (nothing to inherit) |
| SPAWN-05 | pass | `useTmux=false`, `tmuxName=headless-cdd92bbf`, model pinned `claude-haiku-4-5` |
| LIFE-01 | pass | kill → `killed`; reopen same id, **same** `claudeSessionUuid`, tmux window back as `orchestron-4c057a0f-d6cb9c` |
| LIFE-06 | pass | slept at 60 s → tmux released; transcript readable while `sleeping`; send woke it to `running`, no manual reopen, context retained |
| HEADLESS-01 | pass | turn 1 → `idle` (not `needs_input`, NF17 guard holds); no `claude -p` for its own conversation between turns; turn 2 recalled **47** on the same `claudeSessionUuid` |
| HEADLESS-04 | pass | structured inquiry, 2 labelled fields, Send present and disabled while empty |
| META-01 | pass | model persisted `undefined → claude-opus-5`; Save enabled only once dirty |
| SCHED-01 | pass | `cron=0 3 * * *`, model pinned haiku |
| SCHED-09 | pass | exactly one *Run now*; navigated to the spawned session; ran on the pinned model |
| DASH-01 | pass | 13/13 cards strictly descending by `lastActivityAt` |
| DETAIL-01 | pass | collapsed by default (0 `h3`); four groups in order IDENTITY/LOCATION/COMMANDS/TIMING |
| PROJ-01 | pass | registered through the dialog form |
| METRICS-01 | pass | SESSIONS/TOKENS/COST tiles render; per-project breakdown names a fixture |
| SET-05 | pass | anonymous `GET /api/readiness` → 200 `{"status":"ready","uptime":2197,"checks":{…}}` |
| CLI-01 | pass | spawn (`id` ≠ `sessionUuid`, `useTmux=false`), **no tmux window**, send `promptChars=32`, archive → `succeeded` |
| CLI-02 | pass | all six verbs `ok:true`; failure through a pipe → `{ok:false,error}`; **89 020 byte** payload parses and survives a reader walking away |
| CLI-06 | pass | inquiry answered by field, prompt answered by index **and** by text, ambiguity refused, no-pending refused |

No failures. Two probe-level caveats that are **not** product results, recorded so the next runner
does not chase them:

- `smoke-ui.mjs`'s inline DETAIL-01 locator looks for a button matching `/detail/i` and finds
  nothing, reporting `groups: []`. The authoritative `detail01.mjs` clicks the `"<when> · <dur>"`
  toggle and returns the four groups correctly. DETAIL-01 is scored from `detail01.mjs`.
- `nf28.mjs`'s `dialogSel` had to be threaded through my new NF30 probe: querying
  `[data-slot="dialog-content"]` against a **hand-rolled** dialog reports "dialog closed on a failed
  mutation", which reads exactly like a severe NF27 regression and is purely a selector bug. It was
  caught and corrected before filing; the corrected run is what NF30 reports.

---

## NF29 focused verify — the point of this run

Contract: **after a dialog closes, `document.activeElement` is never `<body>` and never `null`,
including when closing it was the prelude to navigating away.**

### The three that failed in batch-15

Measured after the mutation succeeded, after the route settled, and ≥ 400 ms after the close so the
250 ms second pass had run. `navigated` is `page.url()` before vs after — without it a green result
would not prove the navigate path was exercised at all.

| Dialog | urlBefore → urlAfter | navigated | mid-mutation | after 0 ms pass | **settled** | verdict |
|---|---|---|---|---|---|---|
| Spawn | `/dashboard` → `/session/0000…0000` | **true** | `BODY` | `MAIN` `tabindex=-1` | **`MAIN`** `tabindex=-1` | **PASS** |
| Delete Record | `/session/e6796cc0…` → `/dashboard` | **true** | `BODY` | `MAIN` `tabindex=-1` | **`MAIN`** `tabindex=-1`, text `"Dashboard0 active · 7 total…"` | **PASS** |
| Fork | `/session/e6796cc0…` → `/session/0000…000a` | **true** | `BODY` | `MAIN` `tabindex=-1` | **`MAIN`** `tabindex=-1`, text `"Session not found…"` | **PASS** |

Every one shows the full documented story: focus drops to `BODY` mid-mutation (the confirm button
disabling itself), the route lands, and the audit pass puts focus on the `<main>` of the **new**
route — `settled.text` is new-route content in each case, so the pass resolved against the live
document rather than anything captured from the page that is gone.

`landedOn` is `<main> fallback` for all three rather than "the same trigger", which is correct and
not a weakness: Delete removes the row its trigger lived in, Spawn and Fork navigate to a different
session. There is no trigger left to return to.

📷 `nf29-02-focus-on-main-after-navigate.png` — focus ring on `<main>` at `/dashboard` after a
successful Delete Record submit. `nf29-01-dialog-open.png` is the same run before submitting.

### The mechanism measurement that filed NF29, reproduced

`window.setTimeout` / `window.clearTimeout` instrumented, counting the 0 ms and 250 ms audit passes.

| Dialog | passes fired | **passes cleared** | focus | batch-15 cleared |
|---|---|---|---|---|
| Delete Record | 6 | **0** | `MAIN` | 1 |
| Spawn | 4 | **0** | `MAIN` | 1 |
| Fork | 6 | **0** | `MAIN` | 1 |
| Reopen *(control)* | 5 | **0** | `BUTTON` | 0 |
| Schedule *(control)* | 2 | **0** | `BUTTON` | 0 |

`cleared` is now 0 everywhere and every scheduled pass fires. This is the cleanest available
evidence, because it is the same measurement that established the finding.

### The half batch-15 never exercised — unmount while still open

`dispose()` must *schedule* a return for a dialog torn down while on screen, not cancel one.

The navigation has to be genuinely client-side, and getting this wrong produces a false FAIL: my
first attempt reached the dialog's page with `page.goto()` twice, so `goBack()` was a **full document
reload**, the old page's lifecycle never ran, and all three reported `BODY`. Re-done by arriving via
a real `<Link>` click (pushState) and leaving via Back (popstate), with a `window.__spa` marker
planted before the dialog opened to *prove* no reload happened:

| Dialog | dialog open before nav | clientSideNav | url after | **settled** | verdict |
|---|---|---|---|---|---|
| Delete Record | 1 | **true** | `/dashboard` | `MAIN` `tabindex=-1` | **PASS** |
| Fork | 1 | **true** | `/dashboard` | `MAIN` `tabindex=-1` | **PASS** |
| Spawn | 1 | **true** | `/projects` | `MAIN` `tabindex=-1` | **PASS** |

**Known limit, stated rather than hidden:** on a *full page reload* with a dialog open, focus does
land on `<body>`. That is inherent — a new document has no lifecycle to run — and is outside the
contract the hook can hold. It is recorded because my first probe hit it and it looks like a failure.

### Negative control — is the matrix green because the product works?

A 52/52 is only worth reading if the probe can report red. The audit passes were defeated from
outside the bundle (no app-code change): every 0 ms/250 ms timer created and immediately cancelled —
precisely batch-15's state — armed only around the submit so page load was unaffected.

| Dialog | focus with passes defeated | control |
|---|---|---|
| Spawn | `BODY` | RED as expected |
| Delete Record | `BODY` | RED as expected |
| Fork | `BODY` | RED as expected |
| Reopen | `BODY` | RED as expected |
| Schedule | `BODY` | RED as expected |

All five go red. The green matrix is a measurement, not a blind spot.

### A correction to the brief

The brief says the three failures were "exactly the dialogs whose `onSuccess` navigates". That is
not what the data shows. **Adopt and Import also navigate** — both measured `navigated: true` here,
landing on `<main>` — and both were already green in batch-15 with `cleared = 0`. So navigation
alone does not predict the batch-15 failure; the ordering between the close, the push and the
unmount does. The distinction matters for anyone using "does it navigate?" as the test for whether a
new dialog is at risk — it is not sufficient.

---

## Regression hold — batch 3..15

### NF25 — dismiss guard mid-mutation — **104 / 104**, 13 dialogs × 8

Escape / backdrop / in-panel, pre-submit and mid-mutation, plus hold-not-latch. All 13 dialog
instances at 8/8, including backdrop and `×`. No regression.

### NF26 — `×` guarded **and** the refusal visible — **163 / 163**

15 checks on each of the 9 dialogs that have an `×`, 7 on the 4 that do not
(Reopen, Metadata Edit, Fork, Respawn). No regression. Kill needed a freshly adopted session each
time — see Traps.

### NF27 — a failed mutation does not close the dialog, and says why — **78 / 78 on the 6 surfaces batch-15 measured**

Delete Record, Reopen, Metadata Edit, Fork, Respawn and Kill: 13/13 each, against both an injected
500 **and** a real API refusal (retargeted to a phantom id, so the refusal is the product's own —
e.g. `HTTP 404: Session not found: 00000000-…-0000000000ff` rendered in a `role="alert"`). Hold
confirmed; that is exactly batch-15's 6 × 13 = 78.

The other **7** dialogs were never in NF27's measured scope and are new coverage this run. On all 7
the **core contract holds** — the dialog stays open and the error is visible — but the error is not
a `DialogError`. That is NF30 below, and it is pre-existing.

### NF28 — the full 13 × 4 matrix — **52 / 52** (batch-15: 49/52)

The direct regression surface for this change. Nothing that was passing broke.

| Dialog | submit | navigated | escape | cancel | 500 no-op | landed (submit) |
|---|---|---|---|---|---|---|
| Spawn | PASS | true | PASS | PASS | PASS | `<main>` |
| Schedule | PASS | false | PASS | PASS | PASS | same trigger |
| Adopt | PASS | **true** | PASS | PASS | PASS | `<main>` |
| Import | PASS | **true** | PASS | PASS | PASS | `<main>` |
| Delete Record | PASS | true | PASS | PASS | PASS | `<main>` |
| Reopen | PASS | false | PASS | PASS | PASS | same trigger |
| Metadata Edit | PASS | false | PASS | PASS | PASS | same trigger |
| Fork | PASS | true | PASS | PASS | PASS | `<main>` |
| Respawn | PASS | false | PASS | PASS | PASS | same trigger |
| Project Register | PASS | false | PASS | PASS | PASS | same trigger |
| Project Edit | PASS | false | PASS | PASS | PASS | same trigger |
| Delete Project | PASS | false | PASS | PASS | PASS | same trigger |
| Kill | PASS | false | PASS | PASS | PASS | same trigger |

The `500 no-op` column is the important negative: with the mutation failing the dialog stays open
and the audit must **not** fire. It did not fire anywhere — focus stayed on `BODY` *inside the open
dialog*, which is correct, because the contract is about what happens after a **close**.

---

## New findings

### NF30 — a failed mutation is announced only visually in 7 of 13 dialogs (LOW, **pre-existing**)

**Not a batch-16 regression.** Batch-16 touched three files, all focus-return; and these 7 dialogs
were outside the 6 surfaces NF27 has ever measured, so this is newly-covered ground rather than
newly-broken ground.

**Affected** — Spawn, Schedule, Adopt, Import, Project Register, Project Edit, Delete Project.
**Not affected** — Delete Record, Reopen, Metadata Edit, Fork, Respawn, Kill (all use `DialogError`).

**What holds:** the dialog stays open on failure, and the reason is rendered and visible.

**What does not:** the reason is a bare `<p class="text-sm text-red-500">` (Base UI dialogs) or a
bare `<div>` (hand-rolled), with **no `role="alert"`, no `aria-live`, and no
`data-slot="dialog-error"`**. Measured on every one of the 7:

```
staysOpen=true  roleAlert=false  dialogErrorSlot=false  ariaLive=false  toasts=[]
red=[{"tag":"P","role":null,"slot":null,"text":"HTTP 500: {\"error\":\"nf30 injected failure\"}"}]
```

**Failure scenario:** an operator using a screen reader presses *Register* (or Spawn, or Adopt); the
request fails; the dialog stays open and nothing is announced. Because the dialog does not close,
the most natural reading is that the action is still in flight. The sighted equivalent of this bug
was NF27 and was rated MEDIUM; this is LOW only because the text is on screen for anyone who can see
it.

**Secondary, same code path:** these 7 render the raw response body into the message — the operator
sees `HTTP 500: {"error":"nf30 injected failure"}` rather than the parsed `error` string. The 6
`DialogError` dialogs read better (`HTTP 404: Session not found: …`) but also keep the `HTTP nnn:`
prefix.

**Repro:** open any of the 7, submit with the mutating request forced to 500, then query the dialog
for `[role="alert"]`, `[aria-live]`, `[data-slot="dialog-error"]` — all absent.
**Evidence:** `nf30-project-error-shape.json`, `nf27-{SpawnDialog,ScheduleDialog,AdoptSessionDialog,ImportSessionDialog,ProjectDialog,ProjectDialog_Edit,DeleteProjectDialog}.json`.

### NF31 — `e2e-env.sh up` reports a web bundle it is not serving (LOW, tooling, **pre-existing**)

**Failure scenario:** a runner does the documented `build` → `up` → `fixtures`, `up` prints
`ok web ready` and `ok web bundle built against http://127.0.0.1:8091`, and the sweep then measures
the **previous** commit's UI. Nothing in the run reports it, and the sweep's conclusions are
confidently wrong — which is exactly the class of problem §10 exists to prevent, one layer down.

**Measured:** `.next-e2e/BUILD_ID` rebuilt at `05:52:41`; after `e2e-env.sh up`,
`systemctl --user show orchestron-web-e2e.service -p ExecMainStartTimestamp` still read
`Fri 2026-09-11 22:40:17`. The check `up` performs inspects the built bundle on disk, not the
running process's start time, so a stale process passes it.

**Suggested fix:** have `up` restart the web unit when `.next-e2e/BUILD_ID` is newer than
`ExecMainStartTimestamp`, or have `build` mark the unit as needing a restart. Note this is the
**fifth consecutive sweep** in which `.next-e2e` staleness cost time.

---

## Cost

`GET /api/metrics`, read **before** any cleanup. The bucket key is `2026-09-11` because the API
buckets by UTC and the run was 05:47–06:41 WIB (UTC+7).

| | |
|---|---|
| Total in `/api/metrics` | **`$0.31169932`** — 59 sessions, 592 126 tokens |
| Adopted-transcript contamination | `$0.000972` (**0.31 %**) |
| **Actually spent by this sweep** | **`$0.310727`** |

Per-session, this sweep's own spend:

| session | cost | what |
|---|---|---|
| `e3eab9a2` | **`$0.191934`** | **SPAWN-01** — 61.8 % of the sweep |
| `5e834adf` | `$0.027633` | scheduled run / smoke |
| `773cb464` | `$0.019135` | CLI-06 tmux modal, reused for LIFE-01 + LIFE-06 |
| `21662d04` | `$0.017071` | HEADLESS-04 + CLI-06 inquiry |
| `71c68f3f` | `$0.016010` | CLI-01 |
| `42e01bf0` | `$0.013470` | HEADLESS-01 (two turns) |
| `43e9aa2b` | `$0.011097` | active-session fixture |
| `ad1c7a84` | `$0.007443` | CLI-06 text-choice modal |

**SPAWN-01 dominates and cannot be pinned.** Its whole assertion is that a session spawned on
`e2e-claude` inherits *nothing* — no model, no effort — so pinning a cheap model would destroy the
scenario. At 61.8 % it is the headline number, and it is the cost of the coverage, not waste. Every
other agent-starting scenario was pinned to `claude-haiku-4-5`.

**Adopt contamination was held to 0.31 %** by using 504-byte transcripts, against batch-14's 26.5 %.
72 extra sessions were adopted deliberately to push `session list --json` past the 64 KB pipe buffer
for CLI-02 (14 237 → 89 020 bytes); they cost `$0.00097` in total. Without them CLI-02's
truncation check would have been vacuous — the payload never crossed the buffer it exists to test.

---

## Traps this run re-confirmed or added

Carried from memory and hit again, plus two new ones:

- **`.next-e2e` is stale, and restarting matters as much as rebuilding** — NF31. Fifth sweep running.
- **`idleTimeoutMs` is 60 s in the isolated env**, so an adopted fixture is `sleeping` within a
  minute and the Kill button — gated on `isActive`, which *includes* `idle` — disappears. Every
  Kill probe needs a session minted immediately before it. Two probe runs were lost to this.
- **Adopt is `$0`-ish and instant**, and `idle` counts as active, so a 504-byte transcript is the
  cheapest possible "live" session fixture.
- **`e2e-env.sh fixtures` recreates projects with new ids**, orphaning every existing session record.
  Run `reset` rather than `fixtures` alone when the previous sweep's data is still present.
- **`adoptUuid` and `adoptPool[0]` were the same uuid** in my first `env.json`; minting a Kill
  fixture from the pool silently invalidated the Adopt dialog's fixture, and NF25/Adopt failed with
  a 30 s timeout that looked like a product hang.
- **`find` is `bfs` on this host** and parses the leading `-` of `-tmp-orchestron-e2e-ws-*`
  directory names as flags. Use Python or `./`-prefix.
- **`DELETE /api/sessions/:id/record` with a `Content-Type: application/json` header and no body**
  returns `400 FST_ERR_CTP_EMPTY_JSON_BODY`. Send no content-type on bodiless DELETEs.
- **tmux names carry only the first 8 hex of the conversation uuid** (`orchestron-4c057a0f-d6cb9c`),
  so `tmux ls | grep <full-uuid>` always returns 0 and reads as "no window".
- **`page.goBack()` after two `page.goto()` calls is a full reload**, not a client-side nav — it will
  produce a false FAIL on any focus assertion. Arrive by clicking a `<Link>`.
- Batch-15's probe-scoping bug is fixed here: `DeleteProjectDialog` / `ProjectDialog_Edit` now target
  dedicated `zzz-probe-del` / `zzz-probe-edit` cards instead of `.last()` / `.first()`, so no
  fixture project can be deleted by a probe.

**The stuck tmux session** `orchestron-fb1f1d06` named in the brief was reaped by `e2e-env.sh down`
during the `reset` — `down` kills windows named in E2E session records, and it was one. It did not
interfere with any measurement.

**Mac host** `100.103.5.90` was not contacted; it is offline per the brief.

---

## §10 drift statement

```
BASE_SHA  33d6f3ac7ea0d89f466394c8e373732b51685fa9   (read 05:47)
END_SHA   33d6f3ac7ea0d89f466394c8e373732b51685fa9   (read 06:41)
git diff --name-only BASE END  →  (empty)
git status --porcelain          →  (empty, both ends)
```

**NO DRIFT.** `main` did not move during the sweep and the working tree was clean at both ends.
Every result above describes `33d6f3a` and nothing else. No post-sweep sanity re-run was required.

Unit suites at this sha: **apps/web 234 / 234 passed** (17 files), matching the commit's claimed
228 → 234.
