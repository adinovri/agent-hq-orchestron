# E2E Phase 2 — resweep after batch 18 (NF32 + NF33 + NF34)

**BASE_SHA** `29081b51a81366c31b72942c92f08fbfee11a5d4` (`29081b5`) — read 11:03, before the first scenario
**END_SHA**  `29081b51a81366c31b72942c92f08fbfee11a5d4` (`29081b5`) — read 12:09, after the last measurement
**Drift verdict** **NO DRIFT.** Both §10 reads returned the same sha, `git diff --name-only BASE END` is
empty, and the tracked tree was clean at both ends (only `scratchpad/` untracked). Nothing in this
report describes code that has since moved. No post-sweep sanity re-run was required.

**Scenarios** 17 attempted / 17 in the smoke set — **17 PASS · 0 PARTIAL · 0 FAIL · 0 SKIP**
**NF32 focused verify** **13 / 13 dialogs aligned.** Kill is **16 == 16** (was 32 vs 16), `margin-left`
`16px → 0px`, symmetric left and right. The seven batch-17 conversions did not regress.
**NF33 focused verify** **`select-name` 0 nodes** (batch-17: **22**, not the 19 the brief quotes — see
below) and **`label` 0 nodes** (batch-17: 1, Import's file input). All **18 of the 19** selects that
render in this environment expose a correct accessible name; the 19th is verified by source only.
`color-contrast` is **unchanged at 10 nodes**, not grown.
**NF34 focused verify** Import renders `HTTP 500: boom from nf34` and
`HTTP 404: Project not found: 00000000-…-0000000000ff` — **prefixed and parsed**. Spawn still renders
the raw envelope. **That asymmetry is expected and is not a finding** (stated again in §NF34 so the
next sweep does not re-file it).
**Regression** NF25 **104/104**, NF26 **163/163**, NF27 **78/78** on the six standing surfaces,
NF28 **52/52**, NF29 **3/3**, NF30 **13/13** injected-500 and **13/13** real refusal, NF31
`e2e-env.test.sh` **20/20** + `test-self` **23/23**. Every number equals its batch-17 value.
NF27 across all 13 **improved 138 → 140/154**, and the +2 is Import — independent confirmation of
NF34 through a different probe.
**Unit suites at this sha** apps/web **280 / 280** across **19 files**, matching the commit's claimed
254 → 280. `apps/tui` fails on a missing `ink` — pre-existing, identical on main, not chased.
**Cost** **`$0.36480684`** total, 31 sessions, 935 588 tokens. **No retarget artifact this run** —
batch-17's $0.39 mistake did not recur. SPAWN-01 alone is `$0.187350` (**51.4 %**) and is
structurally unpinnable. **`$0.04033` (11.1 %) was re-run waste from probe bugs of mine** (below).
**Run** 2026-09-12 11:03–12:09 WIB, isolated env (`scripts/e2e-env.sh`, api :8091 / web :3011),
Chromium/Playwright 1680×1000, harness `claude` on the E2E config dir.
Browser footer read **`v 29081b51`** before the first scenario, and again incidentally inside the
NF28 probe output — independently confirmed, not inferred from `up`'s own reporting.
**Evidence** `scratchpad/e2e-runs/2026-09-12-batch18/`.

**Two new findings, both LOW, both pre-existing: NF35, NF36.**

---

## Headline

**All three batch-18 fixes do what the commit says, and NF33 turns out to have been under-counted
rather than over-claimed.**

Batch-17 filed `select-name` as "10 dialogs, 19 nodes". Its own per-dialog matrix actually sums to
**22** nodes, and the batch-18 PR's claim — that the defect was app-wide across **all nineteen**
`<select>` sites, not just the dialog ones — is the correct reading. Either way the count is now
zero, and the three non-dialog selects the original finding scoped out are named too.

| | batch-17 | batch-18 |
|---|---|---|
| error box aligned with its own content | 12 / 13 | **13 / 13** |
| Kill's error inset | 32 px vs 16 px sibling | **16 px == 16 px** |
| axe `select-name` nodes | 22 (reported as 19) | **0** |
| axe `label` nodes | 1 (Import's file input) | **0** |
| axe `color-contrast` nodes | 10 | **10 — unchanged, not grown** |
| Import's error message | bare JSON envelope | **`HTTP nnn: <parsed message>`** |
| NF27 across all 13 surfaces | 138 / 154 | **140 / 154** |

The one thing worth flagging for the next sweep is not in the batch-18 scope at all: running axe at
**page** scope rather than inside a dialog surfaces four unlabelled `input[type="date"]` controls
(critical) that no previous sweep could have seen, because every previous axe run was scoped to
`[role="dialog"]`. That is NF35.

---

## Environment

`build` → `reset` → `fixtures`, then a **genuine `$0`** cost baseline (`00-cost-baseline.json`)
before the first scenario. `reset` rather than `fixtures` alone, because `fixtures` recreates the
projects with new ids and orphans every prior session record.

The deployed instance was never rebuilt, restarted or contacted. `test-self` phase 3 asserts this
positively at the end of the run: the deployed API still answers on its own address, still reports
its own data dir, still rejects the E2E bearer, and its data dir and web build are untouched.

**NF31 had nothing to repair this run.** `up` reported `web is serving the bundle on disk
(built 11:04:03, up since 11:04:40)` — the bundle was rebuilt before the units came up, so the
stale case never arose. It is still exercised deliberately in the regression section.

---

## Scenario results

| Id | Result | Notes |
|---|---|---|
| SPAWN-01 | pass | navigated to `/session/b9d3c1f7…`; `useTmux=true`; model+effort **absent** — nothing inherited |
| SPAWN-05 | pass | `useTmux=false`, `tmuxName=headless-1da05b08`, model pinned `claude-haiku-4-5` |
| LIFE-01 | pass | kill → `killed`; reopen → **same** record id `cd43b7d4…`, **same** `claudeSessionUuid` `baad148d…`, back to `spawning` |
| LIFE-06 | pass | slept on the 60 s timeout; transcript readable while `sleeping` (200, 453 B); `POST /input` woke it to `running` in **111 ms** with **no manual reopen**, settled `idle` at 7.8 s, same uuid, recalled the planted word |
| HEADLESS-01 | pass | turn 1 → `idle` (NF17 guard holds); **0** live harness processes for its conversation between turns; turn 2 on the same `claudeSessionUuid`, `lastActivityAt` advanced, turn-2 `finalResponse` names *quokka* |
| HEADLESS-04 | pass | `needs_input`; `pendingInquiry` carries a message + **2 typed fields** (`environment`, `region`, both `choice`) |
| META-01 | pass | model persisted `undefined → claude-opus-5`; Save enabled only once dirty |
| SCHED-01 | pass | `cron=0 3 * * *`, model pinned haiku |
| SCHED-09 | pass | exactly one *Run now* (`count=1`); navigated to the spawned session; ran on the pinned model |
| DASH-01 | pass | 8/8 cards strictly descending by `lastActivityAt` |
| DETAIL-01 | pass | collapsed by default (0 `h3`); four groups in order IDENTITY/LOCATION/COMMANDS/TIMING |
| PROJ-01 | pass | registered through the dialog form → `a39c66e0…` |
| METRICS-01 | pass | SESSIONS/TOKENS/COST tiles render (15 svg); per-project breakdown names a fixture |
| SET-05 | pass | anonymous `GET /api/readiness` → 200 `{"status":"ready","uptime":852,…}`; **negative controls**: 200 with a junk bearer, and `/api/health/detail` **401** anonymous / **200** with the token — so the 200 is not blanket-open |
| CLI-01 | pass | spawn (`id` ≠ `sessionUuid`, `useTmux=false`), **no tmux window**, send `ok:true`, archive → `succeeded` (status re-read from the API, not the command's echo) |
| CLI-02 | pass | five verbs `ok:true`; failure through a pipe → `{ok:false,status:404}`; 23 130-byte payload parses whole and survives a reader walking away (**0 bytes** on stderr) |
| CLI-06 | pass | inquiry answered by field; modal answered **by index** and **by text**; ambiguity refused; no-pending refused; partial inquiry refused. Both written files prove the answers reached the harness |

### Scoring notes, none of them a product result

- **DETAIL-01** is scored from `detail01.mjs`, not `smoke-ui.mjs`. The inline `/detail/i` locator in
  `smoke-ui.mjs` still matches nothing and reports `groups: []` — the carried-forward probe bug,
  fourth sweep running. `detail01.mjs` clicks the `"25s ago · 25s"` toggle and returns the four groups.
- **LIFE-06 and HEADLESS-01 both failed on their first attempt because my probe posted to
  `/api/sessions/:id/send`, which does not exist** (the route is `/input`). The 404 was silent, so
  HEADLESS-01's "turn 2" assertions passed against *turn 1* data — vacuously. Both were re-run
  against the real endpoint with the turn-2 assertion re-written to read the turn-2 `finalResponse`
  rather than the whole transcript. The results above are from the corrected runs. Cost of the
  mistake: roughly `$0.03`.
- **`tokenUsage` is per-turn, not cumulative** (331 → 242 across HEADLESS-01's two turns), so
  "tokens grew" is not a valid test that a second turn ran. `lastActivityAt` is.
- **CLI-06's first partial answer was refused correctly** — the inquiry has two required fields and I
  supplied one. Kept as a negative control (`cli06-partial-refused.json`).

---

## NF32 focused verify — Kill's error box inset

Contract: the error box lines up with the dialog's own content, neither double-padded nor
edge-to-edge. Measured on an injected 500, two ways, because method 1's reference is not usable on
every dialog.

**Method 1 — error box inset vs its immediate previous sibling's inset.** Resolves 8 of 13:

| dialog | error | sibling | `margin-left` | verdict |
|---|---|---|---|---|
| Spawn / Schedule / Adopt / Import | 17 px | 17 px (DIV) | `0px` | aligned |
| Project Register / Project Edit | 16 px | 16 px (BUTTON) | `0px` | aligned |
| Delete Project | 16 px | 16 px (DIV) | `0px` | aligned |
| **Kill** | **16 px** | **16 px (P)** | **`0px`** | **aligned — NF32 fixed** |

The other five (Delete Record, Reopen, Metadata Edit, Fork, Respawn) report a sibling inset of
**1 px** — their sibling is a full-bleed section wrapper, so the reference is its border, not a
content edge. Method 1 cannot score them.

**Method 2 — vs the nearest real text block above.** Resolves exactly those five at **17 == 17**,
and confirms Kill at **16 == 16** a second time. It reports three false positives (Spawn 17 vs 26,
Schedule 17 vs 41, Delete Project 16 vs 25) where the nearest text block is a *nested* element — a
`<p>` inside a bordered hint box, a `<label>` inside a grid cell, an `<li>` with list indent — so
its inset is not the content's left edge. Method 1 resolves all three as aligned.

**Which method resolved which dialog**

| resolved by | dialogs |
|---|---|
| method 1 | Spawn, Schedule, Adopt, Import, Project Register, Project Edit, Delete Project, **Kill** |
| method 2 | Delete Record, Reopen, Metadata Edit, Fork, Respawn |
| both agree | **Kill** (16 == 16 under each) |

**Kill, before and after:**

| | batch-17 | batch-18 |
|---|---|---|
| `errorInset` | 32 px | **16 px** |
| `errorInsetRight` | 32 px | **16 px** |
| sibling inset | 16 px | 16 px |
| `margin-left` | `16px` | **`0px`** |
| symmetric | — | **true** |
| verdict | `misaligned: error 32px vs sibling 16px` | **`aligned`** |

`parentSlot` is still `dialog-content` with `padding-left: 16px` — Kill's `DialogError` remains a
direct child of the padded panel, exactly as the finding described; the `mx-0 mb-0` override is what
removes the second gutter, and it lands through `tailwind-merge`.

**No regression in the seven batch-17 conversions** — all seven still report `margin-left: 0px` and
an inset equal to their sibling's, unchanged from batch-17.

📷 `nf30-align-KillConfirmDialog.png` — the error box shares its left edge with *"This will terminate
the session."* above it and its right edge with the Kill button. `nf30-align-*.png` covers the other
twelve.

Evidence: `nf30-align.json` (method 1), `nf30-align2.json` (method 2), `nf30-box-*.png`.

---

## NF33 focused verify — accessible names on form controls

Run as the brief specifies —
`axe.run(<scope>, {runOnly:{type:'tag',values:['wcag2a','wcag2aa']}})` — on every dialog in the same
injected-500 error state batch-17 measured, over **both** the hand-rolled `role="dialog"` tree and
the Base UI `dialog-portal → dialog-content` tree.

> **A counting caveat on my own first pass.** Three dialogs (Project Register, Project Edit, Delete
> Project) are Base UI, and Base UI puts `role="dialog"` on the *same element* that carries
> `data-slot="dialog-content"`. Summing both scopes double-counts them, which made `color-contrast`
> look like it had grown 10 → 13. De-duplicated to each dialog's own scope, it has not. The
> `select-name` and `label` results are unaffected — zero is zero in either scope.

### The matrix

| dialog | `select-name` b17 → b18 | `label` b17 → b18 | `color-contrast` b17 → b18 |
|---|---|---|---|
| Spawn | 3 → **0** | 0 → 0 | 1 → 1 |
| Schedule | 3 → **0** | 0 → 0 | 1 → 1 |
| Adopt | 1 → **0** | 0 → 0 | 1 → 1 |
| Import | 1 → **0** | **1 → 0** | 0 → 0 |
| Project Register | 3 → **0** | 0 → 0 | 1 → 1 |
| Project Edit | 3 → **0** | 0 → 0 | 1 → 1 |
| Delete Project | 0 → 0 | 0 → 0 | 1 → 1 |
| Delete Record | 0 → 0 | 0 → 0 | 4 → 4 |
| Reopen | 2 → **0** | 0 → 0 | 0 → 0 |
| Metadata Edit | 2 → **0** | 0 → 0 | 0 → 0 |
| Fork | 2 → **0** | 0 → 0 | 0 → 0 |
| Respawn | 2 → **0** | 0 → 0 | 0 → 0 |
| Kill | *not measured in b17* → **0** | — → 0 | — → **0** |
| **total** | **22 → 0** | **1 → 0** | **10 → 10** |

**`select-name`: 0 nodes across all thirteen dialogs. `label`: 0.** Import's file input is now named
**"Bundle file"** via `label[for]`.

**The batch-17 baseline was 22, not 19.** The brief and batch-17's headline both say 19; batch-17's
own per-dialog enumeration (3+3+3+3+1+1+2+2+2+2) sums to 22, and its `nf30-matrix.json` agrees. The
batch-18 PR's framing — the defect was app-wide, across all nineteen `<select>` *sites* — is the
accurate one. Reported here so the discrepancy is not silently carried forward again.

**`color-contrast` (serious) is unchanged, not grown** — the same 10 nodes on the same 7 dialogs:
Spawn's drag hint, Delete Record's four `text-emerald-600/70 italic` spans, and one each on Schedule,
Adopt, Project Register, Project Edit, Delete Project. Deliberately not fixed (picking replacement
colours is a palette decision, not a defect fix). Confirmed still-open, not regrown.

### Computed accessible name for every select

Names are the computed accname, not a "named: true" boolean, so a wrong-but-present name would be
visible here.

**In dialogs (16 of the 19 sites):**

| dialog | names, and where each comes from |
|---|---|
| Spawn | `"Project"`, `"Model"`, `"Effort"` — all `label[for]` |
| Schedule | `"Project"`, `"Model"`, `"Effort"` — all `label[for]` |
| Adopt | `"Project"` — `label[for]` |
| Import | `"Destination project"` — `label[for]`; file input `"Bundle file"` — `label[for]` |
| Project Register / Edit | `"Agent Type *"`, `"Default Model"`, `"Default Effort"` — all `label[for]` |
| Reopen / Metadata Edit / Fork / Respawn | `"Model"`, `"Effort"` — all `label[for]` |

**Outside dialogs — the three the original finding scoped out:**

| control | computed name | via | options |
|---|---|---|---|
| dashboard FilterBar project dropdown | **"Filter by project"** | `aria-label` | 8, first `All projects` |
| `/projects` group filter | **"Filter by group"** | `aria-label` | 2, first `All groups` |
| ThemeSwitcher (`/settings`) | **"Theme"** | `aria-label` | 3, first `Orchestron (default dark)` |

axe `select-name` is **0** on `/dashboard`, `/projects`, `/settings`, `/schedules` and `/metrics`.

**18 of 19 observed live; the 19th verified by source only.** Spawn's *Template (optional)* select
renders behind `{templates.length > 0 && …}` and no prompt templates exist in the E2E environment, so
it never mounted. In source it carries `id={`${uid}-template`}` with a matching
`htmlFor={`${uid}-template`}` label — correct by inspection, unmeasured in the browser. Calling that
a pass would be a guess, so it is recorded as what it is.

Evidence: `nf33-axe-dialogs.json`, `nf33-nondialog.json`.

---

## NF34 focused verify — Import's error format

| dialog | failure | rendered text | prefixed | parsed |
|---|---|---|---|---|
| **Import** | injected 500 | `HTTP 500: boom from nf34` | ✅ | ✅ |
| **Import** | real 404 | `HTTP 404: Project not found: 00000000-0000-4000-8000-0000000000ff` | ✅ | ✅ |
| Spawn | injected 500 | `HTTP 500: {"statusCode":500,"error":"Internal Server Error","message":"boom from nf34"}` | ✅ | ❌ raw |
| Spawn | real 404 | `HTTP 404: {"error":"Project not found: 00000000-0000-4000-8000-0000000000ff"}` | ✅ | ❌ raw |

All four stayed open with `role="alert"` and `aria-live="assertive"`.

**The asymmetry is expected and is NOT a finding.** Import now goes through
`throwIfNotOk` / `describeApiError`; the other twelve dialogs still paste the raw response body, and
that is batch-17's explicit, documented deferral (`mutationErrorMessage` exists for it, but changing
the text changes what live scenarios assert). **Do not re-file it next sweep.** It is visible again
in the NF27 matrix below, where six dialogs are short exactly the two message-*formatting* checks.

**How the real refusal was produced, and how it was not.** The Import POST was refused by rewriting
the **multipart `projectId` field** to a phantom uuid and letting the real request reach the real
endpoint. **No URL was retargeted.** Batch-17 burned `$0.39` (53.8 % of its total) retargeting a
fetch at the genuine spawn endpoint, which succeeded and spawned an unpinned Opus session — a
retarget only refuses if the new URL *cannot* succeed. The five unsafe `retarget` entries were
deleted from `probes/setup-env.mjs` at the start of this run, with the reason recorded in the file.

One bookkeeping caveat, stated so the evidence is not over-read: Spawn's `bodyCorrupted` flag reads
`false` in `nf34-import.json`. Its route glob `**/api/sessions` also matches the dashboard's polling
**GET**, which has no body and overwrote the flag last. The proof the POST was corrupted is the 404
naming the phantom uuid in the message. **No session was spawned and no schedule was created** —
verified independently against the API mid-run: 6 sessions (5 sleeping, 1 killed), 0 `spawning` or
`running`, 0 on any Opus model, 0 schedules.

Evidence: `nf34-import.json`, `nf34-ImportSessionDialog-*.png`, `nf34-SpawnDialog-*.png`.

---

## Regression hold — batches 3..17

Every count is stated against its batch-17 value so a drop would be visible.

| matrix | batch-17 | batch-18 | verdict |
|---|---|---|---|
| NF25 dialog dismiss | 104/104 | **104/104** | hold |
| NF26 close-button guard | 163/163 | **163/163** | hold (see note) |
| NF27 stays-open, six standing surfaces | 78/78 | **78/78** | hold |
| NF27 across all 13 | 138/154 | **140/154** | **+2, Import — NF34 confirmed** |
| NF28 focus return | 52/52 | **52/52** | hold |
| NF29 navigate-survive | 3/3 | **3/3** | hold |
| NF30 announcement, injected 500 | 13/13 | **13/13** | hold |
| NF30 announcement, real refusal | 13/13 | **13/13** | hold |
| NF31 `e2e-env.test.sh` | 20/20 | **20/20** | hold |
| NF31 `test-self` | 23/23 | **23/23** | hold |
| apps/web unit suite | 254/254 (18 files) | **280/280 (19 files)** | as claimed |

### NF25 — 104 / 104

13 dialogs × 8 vectors (Escape / backdrop / in-panel, pre-submit and mid-mutation, plus
hold-not-latch). Every dialog 8/8. Evidence `nf25-<Dialog>.json`.

### NF26 — 163 / 163, with one flake worth naming

The 13-dialog sweep first returned **162/163**, the single miss being Kill's pre-submit
*"× ACTUALLY CLOSES the dialog"*. **It did not reproduce: Kill ran 15/15 on three consecutive
fresh-fixture re-runs.** The cause is the documented Kill fixture trap — `idleTimeoutMs` is 60 s
here and the nf26 probe's several phases can outlast it, so the session sleeps mid-probe and the
dialog is no longer operating on an active session. Note that **every guard assertion passed even in
the flaky run** (disabled attribute, 0.5 opacity, `cursor:not-allowed`, blocked wrapper, tooltip
text, click refused) — the contract NF26 is actually about was green throughout. Recorded as a
fixture flake, not a product regression, and not as a silent 163. Evidence `nf26-<Dialog>.json`.

### NF27 — 78 / 78 on the six standing surfaces, and a real improvement elsewhere

Delete Record, Reopen, Metadata Edit, Fork, Respawn, Kill: **13/13 each = 78**. Exactly batch-17.

Across all 13 the run is **140/154**, up from batch-17's 138. The +2 is **Import, now 10/10**:

| check | batch-17 | batch-18 |
|---|---|---|
| `F500: carries "HTTP 500: <message>"` | FAIL — `{"statusCode":500,…}` | **PASS — `HTTP 500: tmux: no server running on /tmp/tmux-1000/default`** |
| `F500: not a raw JSON envelope` | FAIL | **PASS** |

The remaining 14 shortfalls are all the same two message-formatting checks on the six dialogs that
still paste the raw body (Spawn, Schedule, Adopt, Project Register ×2 extra on Edit/Delete Project) —
the deliberate deferral, not a regression. The NF27 **core contract — stays open, error present,
`role="alert"`, visible, `×` and Cancel live again — passes on all 13.**

### NF28 — 52 / 52

13 dialogs × 4 paths (submit / escape / cancel / 500 no-op). All PASS. The same five dialogs
navigate on submit as in batch-17 (Spawn, Adopt, Import, Delete Record, Fork → `<main>` fallback);
the other eight return to the same trigger. The `500 no-op` column still holds the important
negative: with the mutation failing the focus audit must **not** fire, and it did not anywhere.
Evidence `nf28-<Dialog>.json`.

### NF29 — 3 / 3

Unmount-while-open, arrived at by a real `<Link>` click:

| dialog | clientSideNav | url after | settled |
|---|---|---|---|
| Delete Record | **true** | `/dashboard` | `<main>` `tabindex=-1` |
| Fork | **true** | `/dashboard` | `<main>` `tabindex=-1` |
| Spawn | **true** | `/projects` | `<main>` `tabindex=-1` |

`clientSideNav: true` proves pushState/popstate rather than a reload.

### NF30 — 13 / 13 and 13 / 13

Every dialog announces a failed mutation through `[data-slot="dialog-error"]` with `role="alert"`,
`aria-live="assertive"`, visible, non-empty, dialog still open. Real refusals were produced by
**body corruption or a phantom-target retarget that cannot succeed** — never by retargeting at a
live endpoint. Kill was measured on a session minted seconds earlier.

Evidence: `nf30-matrix.json`, `nf30-kill-and-real.json`.

### NF31 — 20/20 + 23/23

`scripts/e2e-env.test.sh` **20/20** hermetic (all four `ensure_web_serving_current_bundle` paths,
`bundle_is_stale`'s six cases, both epoch readers, including *"fails when the restart does not
help"* and *"tolerates an unreadable start time without restarting on a guess"*).

`scripts/e2e-env.sh test-self` **23/23**, with the NF31 check present and passing in phase 2 as
`ok web serves the bundle currently on disk`, and phase 3 confirming the deployed instance was
undisturbed throughout.

The real stale case did not arise this run — the bundle was built before the units started — so
unlike batch-17 there was nothing for `up` to self-heal. That is an absence of the trigger, not
evidence the repair still works; the repair paths are covered by the 20/20 hermetic suite.

---

## New findings

Both are **LOW** and both are **pre-existing**. Neither is a batch-18 regression: I verified each
against `9237117` (the commit batch-18 was based on) and the relevant source is byte-identical.

### NF35 — four `input[type="date"]` controls have no accessible name (LOW, pre-existing)

**The same defect class NF33 fixed, in the one control kind its scanner deliberately scoped out.**

Running axe at **page** scope — rather than inside `[role="dialog"]`, which is all any previous
sweep did — reports **`label` (impact: critical)** on four date inputs:

| page | nodes | source |
|---|---|---|
| `/dashboard` | 2 | `components/FilterBar.tsx:110,117` (the date-range pair) |
| `/metrics` | 2 | `components/DateRangePicker.tsx:38,45` |

None has `aria-label`, `label[for]`, a wrapping label, or a `title`. A placeholder would not help
even if present: browsers ignore `placeholder` on `input[type="date"]`, so axe's
`non-empty-placeholder` escape — the reason batch-18 correctly left text inputs alone — does not
apply to this control kind.

**Why batch-18's scanner does not catch it, and why that was reasonable.**
`findUnnamedFormControls` covers "exactly the two control kinds axe flagged", i.e. `<select>` and the
file input. axe had not flagged date inputs — because axe had only ever been run inside a dialog,
and there are no date inputs in any dialog. The scoping rule was sound; the input to it was
incomplete.

**Failure scenario:** an operator on a screen reader tabs into the dashboard filter bar and hears
"date picker, blank" twice with nothing to distinguish the start of the range from the end, and no
indication the pair is a range at all.

**Repro:** open `/dashboard`, run
`axe.run(document, {runOnly:{type:'tag',values:['wcag2a','wcag2aa']}})`; read the `label` violation.
**Suggested fix:** `aria-label="From date"` / `"To date"` on both pairs, and extend
`findUnnamedFormControls` to `input[type="date"]` — the one control kind where the placeholder
escape is unavailable by construction.
**Evidence:** `nf35-page-axe.json`, `nf33-nondialog.json`.

### NF36 — `/settings` has a scrollable region with no keyboard access (LOW, pre-existing)

axe reports **`scrollable-region-focusable` (impact: serious)** on one node at `/settings`: the
`<pre class="… overflow-x-auto whitespace-pre">` holding the restart command
(`launchctl kickstart -k gui/$(id -u)/com.orchestron.api && …`). It scrolls horizontally but is not
focusable, so a keyboard-only operator cannot reach the end of the command.

Identical at `9237117` and at `29081b5` — `apps/web/app/settings/page.tsx:44` is unchanged by
batch-18.

**Failure scenario:** a keyboard-only operator on the settings page can see the first half of the
restart command and has no way to scroll to the rest.
**Repro:** open `/settings`, run axe at page scope, or Tab through the page and observe the `<pre>`
is skipped while its content overflows.
**Suggested fix:** `tabIndex={0}` on the `<pre>` (plus an accessible name), the standard remedy for
this rule.
**Evidence:** `nf35-page-axe.json`.

---

## Cost

`GET /api/metrics`, read **before** any cleanup. Baseline was a genuine `$0` after `reset`.

| | |
|---|---|
| Total in `/api/metrics` | **`$0.36480684`** — 31 sessions, 935 588 tokens |
| **Retarget artifact (batch-17's mistake)** | **`$0` — did not recur** |
| SPAWN-01 (structurally unpinnable) | `$0.187350` (**51.4 %**) |
| **Re-run waste from my own probe bugs** | **`$0.040333` (11.1 %)** |
| Everything else | `$0.137124` |

| session | cost | what | wasted |
|---|---|---|---|
| `b9d3c1f7` | **`$0.187350`** | **SPAWN-01** — cannot be pinned; its whole assertion is that `e2e-claude` inherits *nothing*, so setting a model destroys the scenario | |
| `c8681c3f` | `$0.024143` | SPAWN-05, reused for DETAIL-01 | |
| `b787011c` | `$0.019058` | CLI-01 | |
| `e98860df` | `$0.018143` | CLI-06, inquiry half | |
| `b6e67707` | `$0.014896` | CLI-06 modal, answered by index | |
| `76bf0ad6` | `$0.014892` | CLI-06 modal, answered by text | |
| `75a49ce8` | `$0.014404` | HEADLESS-04, first attempt — wrong record key | **yes** |
| `a24d323b` | `$0.012960` | HEADLESS-04, corrected | |
| `85ce74f9` | `$0.012335` | HEADLESS-01, corrected | |
| `95c2d33b` | `$0.010553` | LIFE-06, first attempt — `/send` 404 | **yes** |
| `c34afec3` | `$0.010481` | SCHED-09 *Run now* | |
| `e040826a` | `$0.010026` | LIFE-06, corrected | |
| `bdb02399` | `$0.007714` | HEADLESS-01, first attempt — `/send` 404 | **yes** |
| `b50e9742` | `$0.007662` | LIFE-06, second attempt — still `/send` | **yes** |

(Sessions under `$0.0005` — the adopted fixtures and LIFE-01's tmux session — are omitted; the rows
above account for `$0.364616` of the `$0.364807` total.)

**The avoidable part, stated plainly.** **`$0.04033`** — **11.1 % of the run** — bought nothing. Four
sessions were spent twice: three because my probe posted to `/api/sessions/:id/send`, a route that
does not exist, which 404'd silently while the assertions passed against stale turn-1 data; and one
because I read the inquiry off the wrong record key. Everything else was scenario cost.

**Batch-17's `$0.39` retarget artifact did not recur.** The five unsafe `retarget` entries were
removed before the first probe ran, and no session or schedule was created by any refusal probe —
verified mid-run against the API, not assumed.

---

## Traps

**New this run:**

- **`POST /api/sessions/:uuid/input`, not `/send`.** A wrong path 404s quietly, and a probe that
  then re-reads the record sees turn 1 and reports turn 2 as passing. Assert on something only the
  new turn can produce — `lastActivityAt` advancing, or the turn-2 `finalResponse` — never on the
  whole transcript, which contains turn 1's prompt regardless.
- **`tokenUsage` is per-turn, not cumulative.** 331 → 242 across two turns. "Tokens grew" is not a
  test that a second turn ran.
- **The CLI's `--json` envelope is FLAT** — `{ok, id, sessionUuid, …}`. There is no `data` wrapper.
  Ten assertions read empty and looked exactly like a broken CLI.
- **Don't build a JSON accessor out of `eval` in a shell heredoc.** `eval('d['id']')` collides its
  own quotes; every lookup returned empty with `2>/dev/null` hiding the `SyntaxError`. Walk the path
  instead.
- **Base UI puts `role="dialog"` on the same element as `data-slot="dialog-content"`.** Running axe
  over both scopes and summing double-counts three dialogs — enough to make an unchanged
  `color-contrast` set look like it had grown.
- **A `<select>` behind a render guard is not measurable.** Spawn's template select needs a prompt
  template to exist; without one it never mounts.
- **Page-scope axe finds what dialog-scope axe cannot.** Both new findings here were invisible to
  every prior sweep purely because the scope was `[role="dialog"]`.

**Carried and hit again:**

- `smoke-ui.mjs`'s DETAIL-01 locator matches nothing; score from `detail01.mjs`.
- Kill needs a session minted immediately before the probe — `idleTimeoutMs` is 60 s and a
  multi-phase probe can outlast it (this is what produced the NF26 162/163 flake).
- Adopt consumes a uuid per run; refill with `mint-pool.mjs` / `mint-hl.mjs`.
- `apps/cli/bin/orchestron` loads `dist/`, so the CLI was rebuilt before CLI-01/02/06 — a stale
  `dist` is a false pass.
- **A URL retarget is not a refusal.** Corrupt the request body instead.
- `--choice Yes` is not an ambiguity test; `es` is (refused with *"matches 1, 2"*).
- **Write, not Bash**, is what reliably raises a permission modal.

---

## §10 drift statement

```
BASE_SHA  29081b51a81366c31b72942c92f08fbfee11a5d4   (read 11:03)
END_SHA   29081b51a81366c31b72942c92f08fbfee11a5d4   (read 12:09)
git diff --name-only BASE END  →  (empty)
git status --porcelain          →  (only scratchpad/, both ends)
```

**NO DRIFT.** `main` did not move during the sweep and the tracked tree was clean at both ends.
Every result above describes `29081b5` and nothing else. The deployed instance was not restarted by
this sweep, and `test-self` phase 3 confirms it was left undisturbed.

The bundle under test was confirmed independently of `up`'s own reporting: the browser footer read
**`v 29081b51`** before the first scenario (`00-footer-sha.json`, `00-footer-sha.png`) and the same
string was captured incidentally inside the NF28 probe output.

---

## Evidence

`scratchpad/e2e-runs/2026-09-12-batch18/` — 171 files.

| file | what it holds |
|---|---|
| `00-base-sha.txt`, `00-footer-sha.json/.png` | BASE_SHA, and the sha the **browser** rendered |
| `00-cost-baseline.json`, `metrics-final.json`, `metrics-by-session.json` | `$0` baseline, final cost, per-session attribution |
| `nf30-align.json`, `nf30-align2.json` | **NF32** — methods 1 and 2, all 13 dialogs |
| `nf30-align-KillConfirmDialog.png` | **NF32** — Kill aligned (the batch-17 screenshot showed the indent) |
| `nf33-axe-dialogs.json` | **NF33** — axe per dialog, both trees, plus computed select names |
| `nf33-nondialog.json` | **NF33** — the three non-dialog selects and page-scope axe |
| `nf34-import.json`, `nf34-*.png` | **NF34** — Import vs Spawn, injected 500 and real 404 |
| `nf35-page-axe.json` | **NF35 + NF36** — node-level page-scope axe |
| `nf25-*.json` / `nf26-*.json` / `nf27-*.json` / `nf28-*.json` | regression matrices |
| `nf29-unmount-while-open.json` | NF29, with `clientSideNav` |
| `nf30-matrix.json`, `nf30-kill-and-real.json` | NF30 announcement, both failure modes |
| `nf31-shell-test.txt`, `nf31-test-self.txt` | 20/20 and 23/23 |
| `smoke-ui.json`, `smoke-ui2.json`, `detail01-groups.json`, `headless01-04.json`, `life06-wake.json`, `life01-reopen.json`, `set05.txt`, `cli01-*`, `cli02-*`, `cli06-*` | the 17 scenarios |
| `npm-test-web.txt` | apps/web 280/280 |
| `probes/*.mjs`, `probes/*.sh` | the probes, with `env.json` (ids are from this run and will be stale) |

**Probe caveats for reuse:** `probes/setup-env.mjs` no longer contains the five unsafe `retarget`
entries — they are replaced by a comment explaining what they cost. `probes/harness.mjs` `RUN` points
at this run's directory. `probes/cli-smoke.sh` and `probes/cli06-modal.sh` assume `apps/cli/dist` is
current.
