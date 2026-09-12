# E2E Phase 2 — resweep after batch 17 (NF30 + NF31)

**BASE_SHA** `2c9cb077978d5074f5f15e0bd34dc05c6da5d4ca` (`2c9cb07`) — read 08:38, before the first scenario
**END_SHA**  `2c9cb077978d5074f5f15e0bd34dc05c6da5d4ca` (`2c9cb07`) — read 09:41, after the last measurement
**Drift verdict** **NO DRIFT.** Both §10 reads returned the same sha, a mid-sweep read at 09:12 also
matched, `git diff --name-only BASE END` is empty, and the tracked tree was clean at both ends
(only `scratchpad/` untracked). Nothing in this report describes code that has since moved.

**Scenarios** 17 attempted / 17 in the smoke set — **17 PASS · 0 PARTIAL · 0 FAIL · 0 SKIP**
**NF30 focused verify** **13 / 13** on an injected 500 and **13 / 13** on a real API refusal. All
seven newly-fixed dialogs announce through `[data-slot="dialog-error"]` with `role="alert"` and
`aria-live="assertive"`, and the six that already did still do. Visual check: the 7 are correctly
aligned — **no double-padding, no edge-to-edge**.
**NF31 focused verify** **all five sub-checks pass.** `e2e-env.test.sh` **20/20**; the real stale
case warns → restarts → re-verifies (`ExecMainStartTimestamp` 05:56:13 → 08:40:44); `status`
reports `FAIL … STALE` read-only and restarts nothing; `test-self` **23/23** with the new check
present and passing in phase 2; sourcing the script is inert.
**Regression** NF25 **104/104**, NF26 **163/163**, NF27 **78/78** on the six batch-15/16 surfaces
(core contract green on all 13), NF28 **52/52**, NF29 **3/3** + negative control 5/5 RED.
Every number equals its batch-16 value. Nothing that was passing has stopped.
**Cost** `$0.72661623` total in `/api/metrics`, of which **`$0.390692` (53.8 %) is a probe artifact
of my own making** (see Cost — it is not scenario cost, and it is the headline number of this run's
mistakes). Scenario spend **`$0.334889`**; adopted-transcript contamination `$0.001035` (**0.14 %**).
**Run** 2026-09-12 08:38–09:41 WIB, isolated env (`scripts/e2e-env.sh`, api :8091 / web :3011),
Chromium/Playwright 1680×1000, harness `claude` on the E2E config dir.
Browser footer read **`v 2c9cb077`**, confirmed in the DOM before the first scenario and again
incidentally inside the NF28 probe output.
**Unit suites at this sha** apps/web **254 / 254** (18 files) — matching the commit's claimed
234 → 254.
**Evidence** `scratchpad/e2e-runs/2026-09-12-batch17/`.

**Three new findings, all LOW, all pre-existing: NF32, NF33, NF34.**

---

## Headline

**Both batch-17 fixes do what the commit says, and the NF31 fix proved itself on this very run
before it could do any damage.**

The first `up` of the sweep hit the real stale case — the unit had been up since 05:56 serving the
batch-16 bundle, and the bundle had just been rebuilt at 08:40. It warned, restarted, and
re-verified, unprompted:

```
  warn orchestron-web-e2e.service has been up since 2026-09-12 05:56:13,
       but the bundle was rebuilt at 2026-09-12 08:40:07
  warn next start reads the build at boot — this process is serving the PREVIOUS build
==> Restarting orchestron-web-e2e.service so it picks the new one up
  ok   web restarted onto the current bundle (built 08:40:07, up since 08:40:44)
```

That is the sixth sweep in a row where this mattered and the first where the tooling caught it
instead of a human. The browser footer then read `v 2c9cb077`, so every measurement below is
against the right commit — independently confirmed, not inferred from `up`'s own output.

NF30 is the cleaner of the two results. All thirteen dialogs now announce, the seven that were
converted keep their layout, and **axe agrees**: on every dialog measured in its error state the
`dialog-error` element is the *only* live region in the document, nothing in its ancestry carries
`aria-hidden` or `inert`, and all five ARIA rules pass with zero violations touching it.

| | batch-16 | batch-17 |
|---|---|---|
| dialogs announcing a failed mutation | 6 / 13 | **13 / 13** |
| `role="alert"` + `aria-live="assertive"` | 6 | **13** |
| real API refusal also announced | 6 | **13** |
| error box aligned with its own content | 12 / 13 | **12 / 13** (the odd one out is NF32, unchanged) |
| `up` detects a stale served bundle | no | **yes, and fails if it cannot fix it** |

---

## Environment

`build` → `up` → `reset` → `fixtures`, then a `$0` cost baseline (`00-cost-baseline.json`) before
the first scenario. The deployed instance was never rebuilt, restarted or contacted; it had been
restarted at 08:36 by the batch-17 deploy itself, before this sweep began.

`reset` rather than `fixtures` alone, because `fixtures` recreates the projects with new ids and
orphans every prior session record — the trap recorded after batch-16.

---

## Scenario results

| Id | Result | Notes |
|---|---|---|
| SPAWN-01 | pass | navigated to `/session/4fd117df…`; `useTmux=true`; model+effort **absent** — nothing inherited |
| SPAWN-05 | pass | `useTmux=false`, `tmuxName=headless-ad14261f`, model pinned `claude-haiku-4-5` |
| LIFE-01 | pass | kill → `killed`, tmux window gone; reopen → **same** record id, **same** `claudeSessionUuid` `26bcc542…`, tmux window back |
| LIFE-06 | pass | slept at ~65 s → tmux released; transcript readable while `sleeping` (200, 2642 B); send woke it to `idle` with **no manual reopen**, same uuid, and it recalled the planted `47` |
| HEADLESS-01 | pass | turn 1 → `idle` (not `needs_input`, NF17 guard holds); **0** live harness processes for its conversation between turns; turn 2 recalled `47` on the same `claudeSessionUuid` |
| HEADLESS-04 | pass | `needs_input`, inquiry with 2 fields (one `choice` with 4 options, one `text`); card headed "AGENT NEEDS INPUT", Send present and **disabled while empty** |
| META-01 | pass | model persisted `undefined → claude-opus-5`; Save enabled only once dirty |
| SCHED-01 | pass | `cron=0 3 * * *`, model pinned haiku |
| SCHED-09 | pass | exactly one *Run now*; navigated to the spawned session; ran on the pinned model |
| DASH-01 | pass | 14/14 cards strictly descending by `lastActivityAt` |
| DETAIL-01 | pass | collapsed by default (0 `h3`); four groups in order IDENTITY/LOCATION/COMMANDS/TIMING |
| PROJ-01 | pass | registered through the dialog form |
| METRICS-01 | pass | SESSIONS/TOKENS/COST tiles render (15 svg); per-project breakdown names a fixture |
| SET-05 | pass | anonymous `GET /api/readiness` → 200 `{"status":"ready","uptime":1054,…}`; **negative control**: same endpoint 200 with a junk bearer, `/api/health/detail` **401** anonymous — so the 200 is not blanket-open |
| CLI-01 | pass | spawn (`id` ≠ `sessionUuid`, `useTmux=false`), **no tmux window**, send `promptChars=40`, archive → `succeeded` (status re-read from the API) |
| CLI-02 | pass | six verbs `ok:true`; failure through a pipe → `{ok:false,error,status:404}`; **76 986-byte** payload parses whole and survives a reader walking away (exit 0, **0 bytes** on stderr) |
| CLI-06 | pass | inquiry answered by field; prompt answered **by index** and **by text**; ambiguity refused; no-pending refused. Both written files prove the answers reached the harness, not just the record |

Two scoring notes, neither a product result:

- **DETAIL-01** is scored from `detail01.mjs`, not `smoke-ui.mjs`. The inline `/detail/i` locator in
  `smoke-ui.mjs` still matches nothing and reports `groups: []` — the carried-forward probe bug.
  `detail01.mjs` clicks the `"1m ago · 1m 41s"` toggle and returns the four groups.
- **SCHED-09** refused its first run with `count=2` because an earlier NF30 retarget of mine had
  created a second schedule. **The guard behaving that way is correct** — it exists so a probe never
  clicks an ambiguous *Run now*. The stray schedule was deleted (it was also unpinned, `model:null`)
  and SCHED-09 re-run clean at 3/3.

---

## NF30 focused verify — the point of this run

Contract: **a failed mutation leaves the dialog open and announces why** — a `[data-slot="dialog-error"]`
carrying `role="alert"` and `aria-live="assertive"`, visible, with non-empty text.

### The matrix, 13 dialogs × 2 failure modes

`injected 500` is `route.fulfill` with `{"error":"nf30 injected failure"}`. `real refusal` is the
product's own words — see the method column; five of them could not be produced by a URL retarget
and were made by corrupting the request's own body instead, so the message is authentically about
the operation being attempted.

| Dialog | group | 500 | real refusal | how the real refusal was provoked |
|---|---|---|---|---|
| Spawn | newly-fixed | **PASS** | **PASS** | `body.projectId` → phantom → `Project not found: …` |
| Schedule | newly-fixed | **PASS** | **PASS** | `body.projectId` → phantom |
| Adopt | newly-fixed | **PASS** | **PASS** | `body.harnessSessionId` → a uuid with no transcript → `Claude transcript not found at …` |
| Import | newly-fixed | **PASS** | **PASS** | multipart `projectId` field rewritten → phantom |
| Project Register | newly-fixed | **PASS** | **PASS** | **no interception at all** — form filled with a path that does not exist → `422 Project path "…" does not exist or is not writable` |
| Project Edit | newly-fixed | **PASS** | **PASS** | PATCH retargeted at a phantom project |
| Delete Project | newly-fixed | **PASS** | **PASS** | DELETE retargeted at a phantom project |
| Delete Record | already used `DialogError` | **PASS** | **PASS** | retarget → phantom session |
| Reopen | already | **PASS** | **PASS** | retarget → phantom session |
| Metadata Edit | already | **PASS** | **PASS** | retarget → phantom session |
| Fork | already | **PASS** | **PASS** | retarget → phantom session |
| Respawn | already | **PASS** | **PASS** | retarget → phantom session |
| Kill | already | **PASS** | **PASS** | retarget → phantom → `HTTP 404: Session not found: 00000000-…-0000000000ff` |

**13 / 13 and 13 / 13.** Every row asserts all six of: dialog stayed open (NF27), element present,
`role="alert"`, `aria-live="assertive"`, visible with non-empty text, and no `aria-hidden`/`inert`
anywhere in its ancestry.

`Project Register`'s real refusal is the strongest single piece of evidence here, because **nothing
was intercepted**: the form was filled with a bad path, the real request went to the real API, and
the real 422 came back and was announced.

Evidence: `nf30-matrix.json`, `nf30-kill-and-real.json`, `nf30-adopt-real.json`.

### axe — is the live region defeated by something else on the page?

A DOM query proves the attributes are present. axe is the check that they still *work* in context.
Run with `wcag2a, wcag2aa, wcag21a, wcag21aa` on every dialog in its error state, plus the five
ARIA rules that could invalidate a live region, with node-level detail captured on three.

**Verdict on the live region: clean on all 13.**

- `aria-allowed-role`, `aria-allowed-attr`, `aria-valid-attr-value`, `aria-hidden-focus`,
  `aria-required-attr` — **all pass, zero violations, zero incomplete**, on every dialog.
- **No violation of any rule touches the `dialog-error` node** (`alertFlagged: false` everywhere).
- The `dialog-error` element is the **only** live region in the document on each dialog measured —
  one node, `role=alert`, `aria-live=assertive`, `visible: true`. Nothing competes with it.
- Its full ancestor chain up to `BODY` carries **no `aria-hidden` and no `inert`**, on both the
  hand-rolled (`role="dialog"`) and Base UI (`dialog-portal` → `dialog-content`) trees.

axe *did* find unrelated pre-existing violations on the surrounding dialogs — `select-name`
(critical) and `color-contrast` (serious). Neither is on the error element; both are filed as
**NF33** below. This is exactly what the brief wanted axe for: it distinguishes "the attributes are
there" from "the announcement works", and it also caught two real defects the DOM query would not.

Evidence: `nf30-axe-detail.json`, and the `axe` block in each `nf30-matrix.json` entry.

### The visual half — did the 7 regress?

The seven used to draw their own red box with their own padding and now use the shared one with
`mx-0 mb-0`. Measured two ways, because the first reference was not trustworthy on every dialog.

**Method 1 — the error box's inset vs its immediate previous sibling's inset:**

| group | result |
|---|---|
| all 7 newly-fixed | error inset == sibling inset, **exactly**, on every one (17/17 or 16/16 px) |
| Kill | error **32 px** vs sibling **16 px** — NF32 |
| the other 5 | reference unusable (their sibling is a full-bleed section at 1 px) |

**Method 2 — vs the nearest real text block above:** resolves those 5 at 17 px == 17 px, and
confirms Kill at 32 vs 16. It reports three false positives (Spawn, Schedule, Delete Project) where
the nearest text block is a *nested* element — a `<p>` inside a bordered hint box, a `<label>` inside
a grid cell, an `<li>` with list indent — so its inset is not the content's left edge. Method 1
resolves all three as aligned, and the screenshots confirm it.

**Conclusion: no visual regression in the seven.** `mx-0 mb-0` does what it is meant to — the
override lands through `tailwind-merge`, the outer gutter is gone, and the box lines up with the
padded body it now sits inside. `nf30-align-DeleteProjectDialog.png` shows the error box sharing an
exact left and right edge with the "What happens:" panel above it.

The one misaligned dialog is **Kill**, which batch-17 did not touch — NF32.

Evidence: `nf30-align.json`, `nf30-align2.json`, `nf30-shot-*.png`, `nf30-box-*.png`,
`nf30-align-*.png`, `nf30-real-*.png`.

---

## NF31 focused verify

| # | check | result |
|---|---|---|
| 1 | `bash scripts/e2e-env.test.sh` | **20 / 20** — all four `ensure_web_serving_current_bundle` paths, `bundle_is_stale`'s six cases, both epoch readers |
| 2 | the **real** stale case | the sweep's first `up` hit it unprompted: warned, restarted, came back ready, reported current. `ExecMainStartTimestamp` **05:56:13 → 08:40:44** |
| 2b | a **manufactured** stale case | `touch .next-e2e/BUILD_ID` → `up` warned, restarted, re-verified. **08:41:00 → 08:41:47** |
| 3 | `status` on fresh vs stale | fresh: `ok web unit is serving the bundle on disk (up since …)`. stale: `FAIL web unit is serving a STALE bundle — up since 08:41:00, bundle built 08:41:36`. **`ExecMainStartTimestamp` identical before and after → it restarted nothing** |
| 4 | `scripts/e2e-env.sh test-self` | **23 / 23**. The new check appears in phase 2 as `ok web serves the bundle currently on disk` and passes |
| 5 | sourcing is inert | `bash -c '. scripts/e2e-env.sh; echo sourced-ok'` → `sourced-ok`, nothing else. Both units still `active` with unchanged start timestamps, `BUILD_ID` mtime unchanged, data dir intact |

The failure path is also right in kind, not just in effect: `status` diagnoses and refuses to act,
`up` acts, and a still-stale bundle after the restart **fails** `up` rather than warning — which is
the correct severity, because everything measured afterwards would be attributed to the wrong commit.

Evidence: `nf31-shell-test.txt`, `nf31-up-selfheal.txt`, `nf31-up-manufactured-stale.txt`,
`nf31-status-stale-vs-fresh.txt`, `nf31-test-self.txt`.

---

## Regression hold — batches 3..16

Every count is stated against its batch-16 value so a drop would be visible.

### NF25 — dismiss guard mid-mutation — **104 / 104** (batch-16: 104/104)

13 dialogs × 8: Escape / backdrop / in-panel, pre-submit and mid-mutation, plus hold-not-latch.
No regression. Evidence `nf25-<Dialog>.json`.

### NF26 — `×` guarded **and** the refusal visible — **163 / 163** (batch-16: 163/163)

15 checks on each of the 9 dialogs that have an `×`, 7 on the 4 that do not (Reopen, Metadata Edit,
Fork, Respawn). No regression. Evidence `nf26-<Dialog>.json`.

### NF27 — a failed mutation does not close the dialog — **78 / 78 on the six batch-15/16 surfaces**

Delete Record, Reopen, Metadata Edit, Fork, Respawn, Kill: **13/13 each**. Exactly batch-16's
6 × 13 = 78. Hold confirmed.

Across all 13 surfaces the run is 138/154. **Every one of the 16 shortfalls is the message
*formatting*, and every one is a deliberate, documented deferral** — the commit says so in as many
words: *"Not changed: the raw response body in those messages (`HTTP 500: {"error": …}`), which is
message text live scenarios assert on."* The seven converted dialogs render the raw response body,
so `F500: carries "HTTP 500: <message>"` and `F500: not a raw JSON envelope` fail on each. The NF27
**core contract — stays open, error present, `role="alert"`, visible, `×` and Cancel live again —
passes on all 13.** Not a regression; tracked as NF34 for the one part of it that is not covered by
the commit's own note.

### NF28 — focus-return, the full 13 × 4 matrix — **52 / 52** (batch-16: 52/52)

| Dialog | submit | escape | cancel | 500 no-op | navigated | landed (submit) |
|---|---|---|---|---|---|---|
| Spawn | PASS | PASS | PASS | PASS | **true** | `<main>` fallback |
| Schedule | PASS | PASS | PASS | PASS | false | same trigger |
| Adopt | PASS | PASS | PASS | PASS | **true** | `<main>` fallback |
| Import | PASS | PASS | PASS | PASS | **true** | `<main>` fallback |
| Delete Record | PASS | PASS | PASS | PASS | **true** | `<main>` fallback |
| Reopen | PASS | PASS | PASS | PASS | false | same trigger |
| Metadata Edit | PASS | PASS | PASS | PASS | false | same trigger |
| Fork | PASS | PASS | PASS | PASS | **true** | `<main>` fallback |
| Respawn | PASS | PASS | PASS | PASS | false | same trigger |
| Project Register | PASS | PASS | PASS | PASS | false | same trigger |
| Project Edit | PASS | PASS | PASS | PASS | false | same trigger |
| Delete Project | PASS | PASS | PASS | PASS | false | same trigger |
| Kill | PASS | PASS | PASS | PASS | false | same trigger |

The same five dialogs navigate as in batch-16, and the `500 no-op` column still holds the important
negative: with the mutation failing, the audit must **not** fire, and it did not anywhere.

### NF29 — a focus return survives the navigation that caused it — **3 / 3**, plus controls

Unmount-while-open, arrived at by a real `<Link>` click and left by Back, with `clientSideNav`
proving pushState/popstate rather than a reload:

| Dialog | clientSideNav | url after | settled | verdict |
|---|---|---|---|---|
| Delete Record | **true** | `/dashboard` | `<main>` `tabindex=-1` | **PASS** |
| Fork | **true** | `/dashboard` | `<main>` `tabindex=-1` | **PASS** |
| Spawn | **true** | `/projects` | `<main>` `tabindex=-1` | **PASS** |

Mechanism measurement — the one that originally *filed* NF29 — reproduced:

| Dialog | passes fired | **passes cleared** | focus | batch-15 cleared |
|---|---|---|---|---|
| Delete Record | 7 | **0** | `MAIN` `tabindex=-1` | 1 |
| Spawn | 4 | **0** | `MAIN` `tabindex=-1` | 1 |
| Fork | 6 | **0** | `MAIN` `tabindex=-1` | 1 |
| Reopen *(control)* | 5 | **0** | `BUTTON` | 0 |
| Schedule *(control)* | 2 | **0** | `BUTTON` | 0 |

**Negative control — can the matrix report red?** With the 0 ms/250 ms audit passes defeated from
outside the bundle (no app-code change), all five dialogs go `BODY`:

| Spawn | Delete Record | Fork | Reopen | Schedule |
|---|---|---|---|---|
| RED | RED | RED | RED | RED |

So the green matrix above is a measurement, not a blind spot.

---

## New findings

All three are **LOW** and all three are **pre-existing**. None is a batch-17 regression: batch-17
touched ten dialog files, `ui/dialog-error.tsx`, `lib/dialog-error.ts` and `scripts/e2e-env.sh`, and
each finding below is either in a file it did not change or in behaviour its commit message
explicitly declines to change.

### NF32 — Kill's error box is double-padded (LOW, pre-existing)

**The only one of the 13 dialogs whose error box does not line up with its own content.**

`KillConfirmDialog` renders `<DialogError message={error} />` as a **direct child of
`DialogContent`**, which is `p-4`. `DialogError`'s default `mx-4` then adds another 16 px, so the
box sits **32 px** from the dialog edge while its sibling paragraph *"This will terminate the
session."* sits at **16 px** — a visible 16 px indent on both sides.

This is the mirror image of what batch-17 fixed. The seven converted dialogs pass `mx-0 mb-0`
precisely because they sit inside a padded body; Kill sits inside a padded `DialogContent` and does
not. It is the same class of mistake, in the one dialog the batch had no reason to open.

**Failure scenario:** an operator fails a Kill; the explanation appears indented relative to every
other element in the dialog, reading as a nested sub-panel rather than as a message about the action
they just took. Cosmetic only — the message is present, announced, and correct.

**Repro:** open Kill on an active session, force the DELETE to 500, and compare
`getBoundingClientRect().left` of `[data-slot="dialog-error"]` against the `<p>` above it: 32 vs 16.
**Suggested fix:** `className="mx-0"` on Kill's `DialogError`, or move it inside a body wrapper.
**Evidence:** `nf30-align.json` / `nf30-align2.json` (`KillConfirmDialog`),
`nf30-align-KillConfirmDialog.png` (visible indent), `nf30-box-KillConfirmDialog.png`.

### NF33 — dialog `<select>` elements have no accessible name (LOW, pre-existing)

Found by the axe pass the brief asked for, on the same screen-reader operator NF30 is about.

axe reports **`select-name` (impact: critical)** on six dialogs — Spawn (3 nodes), Schedule (3),
Project Register (3), Project Edit (3), Adopt (1), Import (1), Reopen (2), Metadata Edit (2),
Fork (2), Respawn (2). The `<select>` elements are labelled only by an adjacent `<label>` that is
not associated with them (no `for`/`id`, no `aria-label`, no wrapping), so a screen reader announces
them as an unnamed combobox.

Also, **`label` (critical)** on Import's file input, and **`color-contrast` (serious)** on
incidental text — Spawn's drag-and-drop hint (`text-zinc-400`), Delete Record's four
`text-emerald-600/70 italic` spans, Project Register's ghost button.

**None of these is on the `dialog-error` element** — NF30's fix is unaffected, and the live-region
rules pass everywhere.

**Failure scenario:** an operator on a screen reader opens Spawn, tabs into the project picker, and
hears "combobox, e2e-claude" with no indication of what is being chosen. NF30 made the *failure*
audible; this is the *form* still being partly mute.

**Repro:** open any of the six, run `axe.run('[role="dialog"]', {runOnly:{type:'tag',values:['wcag2a','wcag2aa']}})`.
**Evidence:** `nf30-axe-detail.json` (node-level `target` and `html` for each), `axe` block in
`nf30-matrix.json`.

### NF34 — Import omits the `HTTP nnn:` prefix the other six raw renderers keep (LOW, pre-existing)

The commit deliberately leaves the raw response body in the seven converted dialogs' messages, and
says so. What it does not mention is that those seven are **not consistent with each other**:

| dialog | injected 500 renders as |
|---|---|
| Spawn, Schedule, Adopt, Project Register, Project Edit, Delete Project | `HTTP 500: {"statusCode":500,"error":"Internal Server Error","message":"…"}` |
| **Import** | `{"statusCode":500,"error":"Internal Server Error","message":"…"}` — **no prefix** |

Same on a real refusal: Spawn gives `HTTP 404: {"error":"Project not found: …"}`, Import gives
`{"error":"Project not found: …"}`. So Import's message loses the one piece of the string that tells
an operator it was an HTTP failure at all rather than a literal server reply.

Filed separately from the known raw-body deferral because it is an *inconsistency inside* that
deferral rather than the deferral itself — whoever picks up the raw-body cleanup should know the
seven do not currently share one code path.

**Failure scenario:** an Import fails; the operator sees a bare JSON blob with no status code and
cannot tell a 404 from a 500 without opening devtools.
**Repro:** open Import, force the POST to 500, read `[data-slot="dialog-error"]`.
**Evidence:** `nf27-ImportSessionDialog.json` vs `nf27-SpawnDialog.json`; `nf30-matrix.json`.

---

## Cost

`GET /api/metrics`, read **before** any cleanup. Baseline was a genuine `$0` after `reset`
(`00-cost-baseline.json`). The `2026-09-11` bucket holds `$0.000072` across 4 adopted records —
UTC bucketing of fixtures minted either side of 07:00 WIB, not leftover data.

| | |
|---|---|
| Total in `/api/metrics` | **`$0.72661623`** — 99 sessions, 937 715 tokens |
| **Probe artifact — my mistake, not scenario cost** | **`$0.390692`** (**53.8 %**), 1 session |
| Adopted-transcript contamination | `$0.001035` (**0.14 %**), 90 sessions |
| **Scenario spend** | **`$0.334889`** (46.1 %), 8 sessions |

### The probe artifact, stated plainly

`2e413c88` cost **`$0.390692`** — more than every scenario in the sweep combined — and **no scenario
asked for it**. I gave the NF30 probe a "real API refusal" retarget for `SpawnDialog` pointing at
`/api/sessions?__probe=1`, which is the *real* spawn endpoint. It did not refuse; it spawned. The
dialog's own fixture text (`b16 nf29 probe — never reaches the server`) became a live prompt, on
`e2e-claude-opus`, in tmux, **unpinned — `claude-opus-5`**, because the probe's
`pickFirstRealOption` had selected the first project in the dropdown.

The same mistake also created the stray schedule that made SCHED-09 refuse. Both were found by
reading the metrics rather than by any assertion failing, and both are now cleaned up (the session
killed, the schedule deleted). I replaced that retarget approach for all five affected dialogs with
body-corruption, which cannot reach a success path — that is the method recorded in the NF30 table
above, and the numbers there are from the corrected runs.

**Lesson for the next sweep, and for §10's spirit:** a "real refusal" produced by *retargeting a URL*
is only a refusal if the new URL cannot succeed. Corrupt the body instead, or use a form the product
will reject on its own.

### Scenario spend, per session

| session | cost | what |
|---|---|---|
| `4fd117df` | **`$0.192047`** | **SPAWN-01** — 57.3 % of scenario spend |
| `53626a80` | `$0.039799` | CLI-06 tmux modals, reused for LIFE-01 + LIFE-06 |
| `a51072c3` | `$0.024629` | SPAWN-05, reused for DETAIL-01 |
| `0cb0f52a` | `$0.019250` | first CLI-06 tmux attempt (`Bash date -u` — no modal, see Traps) |
| `80e0fcc2` | `$0.018541` | CLI-01 |
| `62e8c422` | `$0.017649` | HEADLESS-04, reused for CLI-06's inquiry half |
| `43734d28` | `$0.012495` | HEADLESS-01 (two turns) |
| `9d2b604a` | `$0.010479` | SCHED-09 *Run now* |

**SPAWN-01 dominates and cannot be pinned.** Its whole assertion is that a session spawned on
`e2e-claude` inherits *nothing* — no model, no effort — so pinning a cheap model would destroy the
scenario. Every other agent-starting scenario was pinned to `claude-haiku-4-5`, and the records
confirm it.

**Adopt contamination held to 0.14 %** (batch-16: 0.31 %), across 90 records at ~491 bytes each.
60 of those were adopted deliberately to push `session list --json` from 15 384 to **76 986 bytes**,
past the 64 KB pipe buffer CLI-02's truncation check exists to test — below that the check is
vacuous. They cost `$0.001035` in total.

---

## Traps this run re-confirmed or added

New this run:

- **A URL retarget is not a refusal.** Retargeting a mutating request at the real endpoint spawns a
  real session. Cost `$0.39` on an unpinned Opus model and corrupted two scenarios. Corrupt the
  **body** instead — or, best, make the form itself invalid and intercept nothing, as Project
  Register's real-refusal check does.
- **`--permission-mode bypassPermissions` is overridden here**, so permission modals *are*
  reachable — but `Bash(date -u)` still ran without one, while **`Write` reliably raises one**
  (`needs_input` in 9 s). Use Write, not Bash, to drive a session to a modal.
- **`--choice Yes` is not an ambiguity test.** "Yes" is an *exact* match for option 1, and
  exact-first is the documented rule, so it resolves rather than refusing. A real ambiguity needs a
  substring matching 2+ options and exactly matching none — `es` works.
- **"Remember the number N" makes an agent write a memory file**, raising an unwanted permission
  modal mid-scenario. Phrase context-retention probes so they cannot be read as an instruction to
  persist anything.
- **`nf28-kill.mjs` reads its adopt pool from `/tmp/hl.txt` minus `/tmp/adopted_hs.txt`**, not from
  `env.json`. Batch-16's files are exhausted; refill them or every Kill phase fails with
  "already adopted" and reads like a product bug.
- **`POST /api/projects` with a path that is not on disk returns 422**, so `ws-scratch` (which does
  not exist under `/tmp/orchestron-e2e`) silently yields `id: undefined`.
- **`pgrep -af claude | grep <uuid>`** matches the probe's *own* shell command line when the uuid is
  in it. Count matches on the uuid, and do not print the process list as evidence.

Carried and hit again:

- **`DELETE` with `Content-Type: application/json` and no body** → `400 FST_ERR_CTP_EMPTY_JSON_BODY`.
  Send no content-type on bodiless DELETEs. (Cost the first fixture run its terminal session.)
- **`idleTimeoutMs` is 60 s here**, so an adopted fixture sleeps within a minute and Kill's button
  disappears. Every Kill probe needs a session minted immediately before it.
- **Thread `spec.dialogSel` per dialog.** Querying `[data-slot="dialog-content"]` against a
  hand-rolled dialog reports "closed on a failed mutation" and mimics a severe NF27 regression.
- **`e2e-env.sh fixtures` recreates projects with new ids** — use `reset`.
- **`smoke-ui.mjs`'s DETAIL-01 locator matches nothing**; score from `detail01.mjs`.
- **Chrome does not render `title` on a disabled control** — relevant to NF26's tooltip checks.

**`.next-e2e` staleness is no longer a trap** — it is the thing NF31 now catches. Sixth sweep.

---

## §10 drift statement

```
BASE_SHA  2c9cb077978d5074f5f15e0bd34dc05c6da5d4ca   (read 08:38)
MID_SHA   2c9cb077978d5074f5f15e0bd34dc05c6da5d4ca   (read 09:12, before the regression matrices)
END_SHA   2c9cb077978d5074f5f15e0bd34dc05c6da5d4ca   (read 09:41)
git diff --name-only BASE END  →  (empty)
git status --porcelain          →  (only scratchpad/, both ends)
```

**NO DRIFT.** `main` did not move during the sweep and the tracked tree was clean at both ends.
Every result above describes `2c9cb07` and nothing else. No post-sweep sanity re-run was required.

The bundle under test was confirmed independently of `up`'s own reporting: the browser footer read
`v 2c9cb077` before the first scenario, and the NF28 probes captured the same string incidentally in
their `document.body` text. Five previous sweeps measured the wrong commit; this one did not, and
the tooling would now have failed `up` rather than let it happen silently.
