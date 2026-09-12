# E2E Phase 2 — resweep after batch 21 (NF39 + NF40)

**Base sha**: `8619f155ee3fb77ea0d24ca6b4a6f7a1f314a666` (`8619f15`, `main`)
**End sha**: ``8619f155ee3fb77ea0d24ca6b4a6f7a1f314a666` — **no drift**`
**Env**: E2E instance only, API `:8091` / web `:3011`. Deployed `:8090` / `:3010` never contacted
except by `test-self` phase 3, which asserts it is *undisturbed*.
**Model**: Opus 5 (sweep driver). Fixtures pinned to `claude-haiku-4-5` except SPAWN-01, whose
assertion is "inherits nothing" and so cannot be pinned.
**Evidence**: `scratchpad/e2e-runs/2026-09-12-batch21/` (not committed).

---

## Headline

**17 / 17 smoke scenarios pass. Every batch-3..20 regression holds. NF39 and NF40 both verified.**

The two fixes under test are sweep-harness fixes, and this run happened to deliver the cleanest
possible evidence for the first of them:

* **NF39 — verified, with both halves of the finding observed live in one run.** HEADLESS-01's
  `finalResponse` *did* quote the planted word this time and LIFE-06's did *not*. So the old
  `finalResponse`-scoring probe would have reported **PASS on HEADLESS-01 (by luck) and FAIL on
  LIFE-06 (against a correct product)** — the exact flap NF39 describes, demonstrated in a single
  sweep rather than argued from two.
* **NF40 — verified.** `nf30.mjs` now measures the file it is handed: the same probe, same dialog,
  gives **PASS** on a freshly-minted fixture and **FAIL** on a stale one, and the fixture path and
  age are printed. The documented Kill re-mint recipe works with **no `cp env-kill.json env.json`**.

One new finding, **NF41** (LOW, sweep harness): the NF40 rule is checked in but only `nf30.mjs`
adopts it. Three sibling probes still hand-roll `argv`, and one of them — `detail01.mjs` — turned a
wrong argument into a **false FAIL indistinguishable from a known bug** during this run.

---

## Environment and the two gates

`build` → `up` → `reset` → `fixtures`.

**NF31 ran and correctly declined to restart** — the negative case, which matters as much as the
repair. `build` ran before `up`, so the unit booted *after* the bundle it serves:

```
  ok   web ready (http://127.0.0.1:3011/api/health)
  ok   web is serving the bundle on disk (built 2026-09-12 20:14:44, up since 2026-09-12 20:15:15)
```

That is NF31 working as designed: it compares `BUILD_ID` mtime against `ExecMainStartTimestamp`,
found the unit newer, and restarted nothing. No stale-bundle repair was needed or performed this
sweep, so unlike post-batch-20 there is **no mid-sweep web restart to declare**.

**Footer sha gate, three readings** — the check a timestamp cannot fake:

| moment | footer sha | verdict |
|---|---|---|
| before scenario 1 | `8619f155` | == BASE_SHA |
| mid-sweep (after the focused verifies) | `8619f155` | == BASE_SHA |
| after the last scenario | ``8619f155`` | == BASE_SHA |

> Deployed `:3010` still reads `ae6ffac` and that is **not drift**: batch 21 touched docs, `scripts/`
> and one root `package.json` line, with no `apps/api` or `apps/web` source, so the deployed bundle
> was deliberately not rebuilt. The E2E instance builds from HEAD and reads `8619f15`.

**Cost baseline** is genuine, taken before the first scenario:
`{"buckets":[],"total":{"sessions":0,"tokens":0,"cost_usd":0}}`.

**Probe re-pointing.** All 62 probes were carried forward (70 files in the directory once this run's fixtures and the NF39/NF41 probes are counted) from the batch-20 directory and every
`e2e-runs/...` path rewritten to this run — `grep -rn 'batch20\|batch19' probes/` returns nothing.
`headless-life.mjs` and `nf30.mjs` both import the checked-in helpers by relative path, verified by
grep rather than assumed.

---

## Scenario results — 17 / 17

| Id | Result | Notes |
|---|---|---|
| SPAWN-01 | pass | navigated to `/session/81ec1adb…`; `useTmux=true`; model+effort **absent** — nothing inherited |
| SPAWN-05 | pass | `useTmux=false`, `tmuxName=headless-64943d5a`, model pinned `claude-haiku-4-5` |
| LIFE-01 | pass | kill → `killed`; reopen → **same** record id `81844960…` and **same** `claudeSessionUuid` `7089a546…`, back to `spawning` |
| LIFE-06 | pass | slept on the 60 s timeout; transcript readable while `sleeping` (200, 453 B); `POST /input` woke it with no manual reopen; same uuid; **turn-2 answer** `apricot` at `seq 8`, after the turn-2 user entry (`seq 7`) and past the pre-send baseline (`seq 1`) |
| HEADLESS-01 | pass | turn 1 → `idle` (NF17 guard); same uuid `8b189011…`; `lastActivityAt` advanced; turn-2 answer `ready` at `seq 8`; `POST /input` returned **200**, asserted |
| HEADLESS-04 | pass | `needs_input`; `pendingInquiry` carries a message + **2 typed fields** (`text`, `text`) |
| META-01 | pass | model persisted `undefined → claude-opus-5`; Save enabled only once dirty |
| SCHED-01 | pass | `cron=0 3 * * *`, model pinned haiku |
| SCHED-09 | pass | exactly one *Run now* (`count=1`); navigated to `/session/cc2466ef…`; ran on the pinned model |
| DASH-01 | pass | 9/9 cards strictly descending by `lastActivityAt` |
| DETAIL-01 | pass | collapsed by default (0 `h3`); four groups in order IDENTITY/LOCATION/COMMANDS/TIMING — **scored from `detail01.mjs`**, see below |
| PROJ-01 | pass | registered through the dialog form → `066ff355…` |
| METRICS-01 | pass | SESSIONS/TOKENS/COST tiles render (15 svg); per-project breakdown names a fixture |
| SET-05 | pass | anonymous `GET /api/readiness` → **200** `{"status":"ready",…}`; **negative controls**: 200 with a junk bearer, `/api/health/detail` **401** anonymous / **200** authed, `/api/sessions` **401** anonymous |
| CLI-01 | pass | spawn (`id` ≠ `sessionUuid`, `useTmux=false`), **no tmux window**, send `ok:true`, archive → `succeeded` (re-read from the API, not the command's echo) |
| CLI-02 | pass | five verbs `ok:true`; failure through a pipe → `{ok:false,status:404}`; 12 781-byte payload parses whole, **0 bytes** on stderr |
| CLI-06 | pass | modal answered **by index** and **by text**; ambiguity refused; no-pending refused; inquiry **partial refused** and **both-fields accepted** |

### Scoring notes, none of them a product result

* **DETAIL-01 is scored from `detail01.mjs`**, per the brief. `smoke-ui.mjs`'s inline `/detail/i`
  locator still matches nothing and reports `groups: []` — **seventh** consecutive sweep. Known
  carried-forward probe bug, deliberately deferred to batch 22, **not re-filed**. `detail01.mjs`
  clicks the `"1m ago · 1m 17s"` toggle and returns the four groups in order.
* **CLI-06 needed both controls to mean anything.** `cli-smoke.sh` answers one of the inquiry's two
  required fields and is correctly refused:
  `unanswered field(s): region — the agent said it cannot continue without them`. The positive
  control was then run explicitly — answering **both** returned `ok:true, answered:"inquiry"` with
  `prompt: "Which environment are you deploying to?: staging\nWhich region are you deploying to?: us-east-1"`.
  A refusal alone would not distinguish "guards partial answers" from "cannot answer at all". The
  single `FAIL` line in `cli-smoke.txt` is this probe's one-field call, not a product result.
* **Both recall assertions ran through the checked-in helper**, not a hand-rolled copy — the point
  of NF39 and the subject of the next section.

---

## NF39 focused verify — recall is asserted on the transcript, never on `finalResponse`

Fix under test: `scripts/e2e-probe/recall.mjs` (`findRecallAnswer`, `assertRecall`, `maxSeq`),
documented in `headless-flow.md` HEADLESS-01 § *How to assert*, worked example
`scripts/e2e-probe/recall-probe.mjs`.

### (a) Unit half — `npm run test:probe`

```
ℹ tests 21   ℹ pass 21   ℹ fail 0   ℹ duration_ms 363.805282
```

**21 / 21**, `node --test`, no network. The suite includes the drift tripwire that reads
`apps/web/lib/transcript-entry.ts` off disk and fails if either nudge sentence changed — it passed,
so the two copies of `Continue from where you left off.` / `No response requested.` are still in
sync.

### (b) Live half — both assertions through the shared helper

`headless-life.mjs` imports `assertRecall` / `maxSeq` from `../../../../scripts/e2e-probe/recall.mjs`
(verified by grep, not assumed) and carries no local copy of the rule.

| | HEADLESS-01 | LIFE-06 |
|---|---|---|
| session | `8fda9e7b-4143-4330-8e7e-d5e611124f4d` | `0798f5a6-8b61-464c-b9e0-3ff4217f19b8` |
| **answerSeq** | **8** | **8** |
| **afterUserSeq** | **7** | **7** |
| **baseSeq** (read BEFORE the send) | **1** | **1** |
| **skipped** | `[{"seq":5,"role":"nudge"},{"seq":6,"role":"reply"}]` | `[{"seq":5,"role":"nudge"},{"seq":6,"role":"reply"}]` |
| **transcript text (scored)** | `"ready"` | `"apricot"` |
| **`finalResponse` (deliberately NOT scored)** | `"Answered with the word \"ready\" as originally requested in the first message."` | `"Answered the user's question with the fruit name they requested in the first message."` |
| does the summary quote the planted word? | **YES** | **NO** |
| what the OLD probe would have reported | **PASS — by luck** | **FAIL — against a correct product** |
| verdict | **PASS** | **PASS** |

**This is the finding demonstrated, not argued.** Post-batch-20 needed two sweeps to show the flap:
a lucky PASS at batch 19 and two FAILs at batch 20. This run produced **both outcomes at once, on
the same build, minutes apart** — HEADLESS-01's self-summary happened to quote `ready`, LIFE-06's
described its own tool call (`"…the fruit name they requested…"`) without naming `apricot`. A probe
whose verdict depends on which of those the model writes is exactly the probe NF39 removed.

Guard 1 is visible in the `skipped` column of both rows: `seq 5/6` is the resume pair Claude Code
injects between headless turns. Without the skip, "the newest assistant entry" mid-flight is
`seq 6` → `"No response requested."`.

The full transcript, for the record:

```
0:user      Reply with the single word: apricot. Do nothing else.
1:assistant apricot                            <- turn 1's answer
5:user      Continue from where you left off.  <- resume pair, SKIPPED
6:assistant No response requested.             <- resume pair, SKIPPED
7:user      In my very first message I asked…  <- the turn being scored
8:assistant apricot                            <- scored
```

### (c) Negative control — the guards observed failing

A guard nobody has watched fail is not evidence. All three shapes were driven against **this run's
real transcript**:

**1. Baseline read AFTER the send (or otherwise stale) — the helper refuses.**

```
baseSeq=8 → answerSeq=-1 afterUserSeq=-1 text="" reason=no user entry past seq 8   → ok:false
```

Both scenarios. It declines to score rather than reaching for the nearest plausible entry.

**2. `baselineSeq` omitted entirely — the helper throws.**

```
TypeError: findRecallAnswer: baselineSeq must be a number read BEFORE the turn was sent
```

It has no default, as the README promises.

**3. The vacuous shape, reproduced on real data.** A *completed* transcript cannot show this — the
newest user entry is already turn 2's, so even a `-1` baseline lands on the right answer. The trap
only bites mid-flight, so the real transcript was replayed truncated to the moment a too-early poll
would have seen it (everything before `seq 7`):

```
mid-flight view: ["0:user","1:assistant:apricot","5:user:Continue…","6:assistant:No response requested."]

(1) NO BASELINE (-1) → PASS | answerSeq=1 afterUserSeq=0 baseSeq=-1 text="apricot"
    ^ a PASS here IS the bug — it scored TURN 1'S OWN ANSWER.

(2) BASELINE=1        → REFUSED | answerSeq=-1 afterUserSeq=-1 reason=no user entry past seq 1
    ^ the guard declines until the real turn lands.
```

Line (1) reproduces the exact signature the finding names — `answerSeq=1 afterUserSeq=0
text="apricot"` — and line (2) is the guard stopping it. Both guards are load-bearing and both were
watched doing their job.

**NF39: VERIFIED.**

---

## NF40 focused verify — the env-file argument is read, or rejected

Fix under test: `scripts/e2e-probe/env-file.mjs` (`resolveEnvFile`, `loadEnvFile`,
`describeEnvFile`). `nf30.mjs` imports it and no longer hardcodes `./env.json`.

### (a) Unit half

Inside the same `npm run test:probe` 21/21 above. `env-file.test.mjs` is deliberately **not**
mocked — NF40's defect is invisible to a mocked `fs`, because the probe read a real file, just the
wrong one.

### (b) Live half — two fixtures, two different sessions, two different answers

Three fixtures, each naming a **different** session:

| fixture | sessionActive | status at run time |
|---|---|---|
| `./env.json` | `1d1b9ece-6a08-4d72-a10b-2fc53ab820dd` | **sleeping** |
| `./env-killA.json` | `a4944986-952a-41d4-bb3c-a04330de90f6` | idle |
| `./env-killB.json` | `25b1d2d7-f3ea-4a4a-9bb0-8b57bd36e347` | idle |

Same probe, same dialog, three invocations:

```
$ node nf30.mjs KillConfirmDialog ./env-killA.json
fixture: …/probes/env-killA.json (minted 9s ago)
PASS  KillConfirmDialog  role=alert live=assertive open=true real=true axeViol=0 gutter=16/16 ml=0px

$ node nf30.mjs KillConfirmDialog ./env-killB.json
fixture: …/probes/env-killB.json (minted 18s ago)
PASS  KillConfirmDialog  role=alert live=assertive open=true real=true axeViol=0 gutter=16/16 ml=0px

$ node nf30.mjs KillConfirmDialog ./env.json
fixture: …/probes/env.json (minted 379s ago)
FAIL  KillConfirmDialog  role=undefined live=undefined open=undefined real=null   [35s]
```

**The results differ, and they differ with the file.** Two fresh fixtures both PASS; the stale one
FAILs — because a sleeping session has no Kill button, which is precisely the condition NF40's
victim hit. Under the old bug all three invocations would have read `./env.json` and all three would
have returned the **same** FAIL: the "three 30 s timeout runs" signature in the finding.

`describeEnvFile` supplies the signal whose absence made this cost three runs instead of one — the
absolute path **and the age**: `minted 9s ago` vs `minted 379s ago` is the difference between "the
fixture is fine" and "the fixture is six minutes stale" without opening anything.

### (b2) A bad path fails in about a second, naming the path

| invocation | result | elapsed |
|---|---|---|
| `nf30.mjs KillConfirmDialog ./env-does-not-exist.json` | `Error: resolveEnvFile: no fixture at ./env-does-not-exist.json — mint it first, or pass the one you minted` | **1 028 ms** |
| `nf30.mjs KillConfirmDialog ./env-killA.json extra-arg` | `Error: resolveEnvFile: 3 argument(s) but this probe reads 1 positional(s) plus an optional env file — unread: ["extra-arg"]` | **983 ms** |
| `nf30.mjs KillConfirmDialog` from a directory with no `env.json` | `Error: resolveEnvFile: no fixture at ./env.json (no env-file argument given, fell back to ./env.json) — mint it first…` | ~1 s |

One second, against the **35 s** a stale fixture takes to time out. The fallback case says outright
that it *fell back* rather than being handed a file, which is the distinction that was missing.

### (c) The Kill re-mint recipe, with no `cp` workaround

The batch-20 sweep had to run `cp env-kill.json env.json` before every Kill probe. Verbatim recipe,
no `cp`:

```
$ node mint-kill-env.mjs 1
minted 1 sessionActive= 7890966b-2d91-4cf3-ae6d-50f156ed4a1a

$ node nf30.mjs KillConfirmDialog ./env-kill.json
fixture: …/probes/env-kill.json (minted 1s ago)
PASS  KillConfirmDialog  role=alert live=assertive open=true real=true axeViol=0 gutter=16/16 ml=0px

$ md5sum -c envbefore.md5
env.json: OK                       <- untouched
$ python3 -c "…"
env.json sessionActive = 1d1b9ece-…    <- still the STALE sleeping one
```

`env.json` is byte-identical afterwards and still names the sleeping session — so the PASS was read
from `env-kill.json` and could not have come from `env.json`, which we independently showed FAILs.

**NF40: VERIFIED.**

---

## Accessibility — both scopes, per §11

`wcag2a + wcag2aa`. **The two scopes are reported separately and never added**: Base UI puts
`role="dialog"` on the same element as `data-slot="dialog-content"`, so a page-scope run already
contains every dialog node. Quoted totals are page scope.

### PAGE scope — `axe.run(document)`, once per route

| rule | impact | `/dashboard` | `/metrics` | `/projects` | `/schedules` | `/settings` | session detail |
|---|---|---|---|---|---|---|---|
| `color-contrast` | serious | 23 | 9 | 6 | 6 | 9 | 9 |
| `label` | critical | **0** | **0** | **0** | **0** | **0** | **0** |
| `select-name` | critical | **0** | **0** | **0** | **0** | **0** | **0** |
| `button-name` | critical | **0** | **0** | **0** | **0** | **0** | **0** |
| `scrollable-region-focusable` | serious | **0** | **0** | **0** | **0** | **0** | **0** |
| `aria-prohibited-attr` | serious | **0** | **0** | **0** | **0** | **0** | **0** |
| `aria-allowed-attr` | serious | **0** | **0** | **0** | **0** | **0** | **0** |
| `aria-valid-attr-value` | critical | **0** | **0** | **0** | **0** | **0** | **0** |

`color-contrast` is the **only** rule that fires anywhere, at any scope, on any route.

### DIALOG scope — `axe.run([role=dialog])`, once per dialog, 13 dialogs

`select-name = 0`, `label = 0`, `aria-prohibited-attr = 0`, `aria-allowed-attr = 0`,
`button-name = 0` across all 13. The only rule reported is `color-contrast`, distributed
`{SpawnDialog:1, ScheduleDialog:1, AdoptSessionDialog:1, ProjectDialog:2, ProjectDialog_Edit:2,
DeleteProjectDialog:2, DeleteRecordDialog:4}` — the standing, deliberately-unfixed population.

### Did any count grow? — the NF38 question

**No.** Every page-scope cell is identical to the post-batch-20 reading, and every non-contrast
critical/serious rule is zero at both scopes. **The NF38 A/B was therefore not triggered and no
parent worktree was built** — the convention says to hold the data constant and compare against a
live parent build *when a count grows*, and nothing grew.

Two honesty notes on that, because the point of NF38 is not to launder a number:

* An **equal** count is not by itself proof of no regression; it is the absence of the signal that
  would prompt the question. The reading that actually carries weight is the block of zeros above —
  `label`, `select-name`, `button-name`, `scrollable-region-focusable`, `aria-prohibited-attr`,
  `aria-allowed-attr` — which is what surfaced NF33, NF35 and NF36.
* `/dashboard = 23` is **not** being carried forward as a baseline. It is a function of how many
  session cards this run's fixtures happened to render; post-batch-20 measured 21 and 23 on the
  *same commit and bundle* fifteen minutes apart. The next sweep should expect a different number
  and treat only a *grow* as a question — for which the remedy is the A/B, not this table.

Batch 21 touched no `apps/web` source, so a contrast delta attributable to code was not a
plausible outcome here in any case.

---

## Regression hold — batches 3..20

| finding | expected | measured | verdict |
|---|---|---|---|
| NF25 dialog dismiss | 104 | **104 / 104** | HOLD |
| NF26 close guard | 163 | **163 / 163** (Kill **15/15** in-matrix, no re-run needed) | HOLD |
| NF27 stays-open (six standing surfaces) | 78 | **78 / 78** | HOLD |
| NF27 stays-open (all 13) | 140 / 154 | **140 / 154** | HOLD |
| NF28 focus return | 52 | **52 / 52** | HOLD |
| NF29 navigate survive | 3 | **3 / 3** (+ negative control defeats the probe 5/5) | HOLD |
| NF30 dialog error — injected 500 | 13 | **13 / 13** (Kill **1/1** in-matrix) | HOLD |
| NF30 dialog error — real refusal | 13 | **13 / 13** (`real=true` on 8, `axeViol=0` where applicable) | HOLD |
| NF31 `e2e-env.sh` | 20 + 23 | **20 / 20** + **23 / 23** | HOLD |
| NF32 error-box inset | 13 / 13 | **8 + 5** (m1) ∪ **10 + 3** (m2) = **13 / 13** | HOLD |
| NF33 `select-name` + `label` | 0 + 0 across 25 selects | **0** + **0**, 22 dialog + 3 page = **25** | HOLD |
| NF34 Import prefixed + parsed | — | `HTTP 404: Project not found: …` (parsed) vs Spawn's raw `{"error":…}` | HOLD |
| NF35 date inputs named | 4 | **4 / 4**, `axeName === manualName` on all four | HOLD |
| NF36 `<pre>` focusable | 2 | **2 / 2**, keyboard scroll `0 → 488` and `0 → 120` | HOLD |
| NF37 three command names distinct | 3 | **3 / 3**, two engines agree; copy reads back; name rules **0** | HOLD |
| `apps/web` vitest | 322 | **322 / 322** (21 files) | HOLD |

### Two rows that improved, and why it is attribution and not luck

**NF26 went 162/163 → 163/163 and NF30 went 12/13 → 13/13.** Both of batch-20's single misses were
the *same* documented Kill flake: the fixture outlives the 60 s `idleTimeoutMs` during a 13-dialog
sweep and a sleeping session has no Kill button. Batch 20 had to re-mint and re-run Kill separately
three times to clear each.

This sweep needed none of that, and the reason is **NF40**. `run-matrix.sh` has always re-minted
into `env-kill.json` and passed it as the positional argument; `nf30.mjs` was the probe that ignored
it. Now that the argument is read, the in-matrix Kill entry measures the fixture minted seconds
earlier and returns 1/1 on the first attempt. So NF30's `12/13 → 13/13` is the NF40 fix showing up
in the regression table rather than in its own verify — a benefit the batch did not claim.

NF26's improvement is weaker evidence and is reported as such: `nf26.mjs` already honoured the
argument, so its batch-20 miss was a genuine timing flake rather than the NF40 defect. It simply did
not recur.

### NF32's two methods, unchanged in shape

Method 1 (error box vs its previous sibling) resolves **8** and reports 5 `CHK` where the sibling is
full-bleed: DeleteRecord, SessionAction, SessionMetadataEdit, Fork, Respawn. Method 2 (vs the
dialog's own body text and footer button) resolves **10** and reports 3 `CHK`: Spawn, Schedule,
DeleteProject. **The two `CHK` sets are disjoint, each method resolves exactly the other's, and their
union is all 13.** Neither method alone is sufficient; that is a property of the two measurement
strategies, not of the code.

### Carried forward, not re-filed

* **NF34's asymmetry** — Import parses the error body, Spawn renders it raw. Deliberate deferral
  recorded at batch 18, re-observed here verbatim, still deferred.
* **The seven dialogs rendering `HTTP 500: {"error":…}`** — carried from batch 17, unchanged.
* **`smoke-ui.mjs`'s DETAIL-01 locator** — seventh consecutive sweep at `groups: []`; batch-22 item
  per the batch-21 PR notes. See NF41, which is adjacent but not the same defect.
* **`apps/tui` is not counted.** Pre-existing `ink` failure, identical at `main`.

---

## New findings

### NF41 — the NF40 rule is checked in, but only `nf30.mjs` adopts it (LOW, sweep harness)

**What.** Batch 21 moved the argument convention into `scripts/e2e-probe/env-file.mjs` and wired
`nf30.mjs` to it. That probe is now correct — §(b2) above shows it rejecting a bad path and an
unread argument in about a second. **Every sibling probe still hand-rolls `argv`**, and they fail in
the three ways the helper was written to prevent. All three were hit *during this sweep*:

| probe | invocation | what happened |
|---|---|---|
| `detail01.mjs` | `node detail01.mjs ./env.json` | **accepted it**, used the string as a session uuid, navigated to `/session/./env.json`, returned `{"groups":[],"sections":0}` |
| `smoke-ui.mjs` | `node smoke-ui.mjs` (no arg) | `TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string… Received undefined` — a raw `fs` stack, not a sentence |
| `nf37-verify.mjs` | `node nf37-verify.mjs ./env.json` | the env file landed in a **number** slot → `viewport.width: expected integer, got float NaN` → Playwright crash |

**Why it is worth a finding rather than a shrug.** The first row is NF40's defect class exactly, and
it **produced a wrong verdict in this run before being caught**:

```
$ node detail01.mjs ./env.json
{"session":"./env.json","h3Before":0,"toggleLabel":null,"groups":[],"sections":0,"firstBorder0":0}

$ node detail01.mjs 1d1b9ece-6a08-4d72-a10b-2fc53ab820dd
{"session":"1d1b9ece-…","h3Before":0,"toggleLabel":"13m ago · 13m 1s",
 "groups":["IDENTITY","LOCATION","COMMANDS","TIMING"],"sections":4,"firstBorder0":4}
```

`groups: []` is **the exact output of the known `smoke-ui.mjs` DETAIL-01 locator bug**. A sweep that
fed the wrong argument would read its own mistake as the standing probe defect, conclude DETAIL-01
is un-scoreable again, and move on — the seventh consecutive sweep being the thing that makes the
misread plausible. That is a false negative wearing a familiar costume, which is worse than a loud
failure.

Contrast the probe that *does* use the helper, on the identical mistake:

```
$ node nf30.mjs KillConfirmDialog ./nope.json
Error: resolveEnvFile: no fixture at ./nope.json — mint it first, or pass the one you minted
```

**A fourth, adjacent shape.** `nf36-verify.mjs` and `nf37-toolresult.mjs` read an artefact
(`nf36-longresult-session.txt`) that only `mint-longresult.mjs` produces, with no declared
prerequisite and no guard — they die on a raw `ENOENT` stack. Under a matrix runner that greps for
`PASS`/`FAIL`, that is indistinguishable from "NF36 regressed". Both were hit in this sweep's first
verify stream and cost a diagnosis round-trip.

**Suggested remedy** (batch 22, alongside the deferred DETAIL-01 locator, which is the same family):
give `scripts/e2e-probe/` a `session-arg.mjs` that validates a uuid-shaped positional the way
`env-file.mjs` validates a path, point `detail01.mjs` / `smoke-ui.mjs` / `nf37-verify.mjs` at the
existing helpers, and have the two long-result probes assert their prerequisite with a sentence
naming the minting script. The batch-21 PR notes already argue this case — "it wants the same
treatment (a checked-in locator helper)"; NF41 is the evidence that the argument generalises past
the one locator.

**Impact.** LOW. No product code is implicated. It costs sweep time and, once, nearly cost a wrong
scenario verdict.

### Not filed

* **`/dashboard` `color-contrast` = 23.** Identical to the previous reading and to every other
  route. Per NF38 this is data, not code, and is neither a finding nor a baseline.
* **The `cli-smoke.sh` CLI-06 one-field FAIL line.** The product refuses a partial inquiry answer
  correctly; the probe under-answers. Recorded as a scoring note, not a finding — though it is
  arguably the same "probe asserts the wrong thing" family as NF39/NF41 and would be cheap to fix
  by having the probe answer every required field.

---

## Cost

Read from `/api/metrics` **before** any cleanup, against the genuine `$0` / 0-session baseline taken
before the first scenario (`{"buckets":[],"total":{"sessions":0,"tokens":0,"cost_usd":0}}`).

**Total: $0.33612 — 30 sessions, 735 040 tokens.**

| by model | sessions | tokens | cost | share |
|---|---|---|---|---|
| `claude-opus-5` | 1 | 38 720 | **$0.19193** | **57.1 %** |
| `claude-haiku-4-5-20251001` | 9 | 696 194 | $0.14395 | 42.8 % |
| `claude-haiku-4-5` | 20 | 126 | $0.00024 | 0.1 % |

| by project | sessions | tokens | cost |
|---|---|---|---|
| `e2e-claude` (`afadd77d…`) | 1 | 38 720 | $0.19193 |
| `e2e-headless` (`eeb46b86…`) | 25 | 398 546 | $0.08696 |
| `e2e-haiku` (`1c538322…`) | 4 | 297 774 | $0.05723 |

**One session is 57.1 % of the sweep, and it is the one that cannot be pinned.** SPAWN-01 asserts
that a fresh spawn inherits *no* model and *no* effort, so pinning a cheap model in its dialog would
delete the assertion; it lands on `e2e-claude`'s project default (Opus 5). The figure has now read
61.8 % → 37.8 % → 46.4 % → 57.1 % across batches 16/19/20/21 purely with how much the untouched
session decides to say. **Structural, expected, not a finding.** Everything pinnable is pinned: 20
adopted fixtures cost $0.00024 in total.

Total is down from batch 20's $0.41364 on 44 sessions, which is a fixture-population difference
(this sweep ran `reset` before `fixtures`), not an efficiency result.

**Per-record `costUsd` is incomplete, as documented.** Only **6 of 31** records carry one, summing
to **$0.18241** — barely half the true total. 25 records report `null`, 5 of them tmux-backed.
`/api/metrics` is the SSOT and is what is quoted above.

---

## §10 drift statement

| check | value |
|---|---|
| BASE_SHA | `8619f155ee3fb77ea0d24ca6b4a6f7a1f314a666` |
| END_SHA | `8619f155ee3fb77ea0d24ca6b4a6f7a1f314a666` |
| **drift** | **none** |
| tracked tree at start | clean (`git status --porcelain -uno` empty) |
| tracked tree at end | clean |
| footer sha before scenario 1 | `8619f155` |
| footer sha mid-sweep | `8619f155` |
| footer sha after last scenario | `8619f155` |
| E2E `.next-e2e/BUILD_ID` mtime | `2026-09-12 20:14:44`, unchanged for the whole sweep |

**`main` did not move.** It was already at `8619f15` when the sweep began (the batch-21 FF-merge
landed at 20:11:14, before `BASE_SHA` was read at ~20:14) and is at `8619f15` at the end. No commits
were made to `main` by this sweep before the report commit itself.

### ⚠ Declared mid-sweep event — the DEPLOYED instance was rebuilt and restarted by someone else

**This is the §10 coordination rule firing, and it needs to be said loudly.**

The brief states that deployed `:3010` "was NOT rebuilt this batch … so its footer legitimately
still reads `ae6ffac`". **That was true when the brief was written and is no longer true.** At the
end of the sweep the deployed footer reads `Build 8619f155`:

| artefact | timestamp | note |
|---|---|---|
| `apps/web/.next/BUILD_ID` (deployed bundle) | **2026-09-12 20:33:59** | rebuilt ~20 min into this sweep |
| `orchestron-web.service` `ExecMainStartTimestamp` | **2026-09-12 20:34:27** | restarted |
| `orchestron-api.service` `ExecMainStartTimestamp` | **2026-09-12 20:34:27** | restarted |
| deployed `/dashboard` footer | `8619f155` | not `ae6ffac` |

So batch 21 *was* deployed, concurrently, while this sweep was running. I did not do it: this sweep
issued no `npm run build` outside `e2e-env.sh build` (which writes `.next-e2e`, mtime 20:14:44,
untouched), and no `systemctl restart` of any deployed unit.

**Blast radius: none on this run's results.** Assessed rather than assumed:

* Every probe in this sweep targets `127.0.0.1:8091` / `127.0.0.1:3011` — the E2E units, which are
  separate systemd units on a separate data dir with a separate bundle. `harness.mjs` pins `API` and
  the CLI reads `$ORCH` from `~/.orchestron-e2e/e2e.env`.
* The E2E web bundle's `BUILD_ID` mtime never moved from 20:14:44, and the E2E footer read
  `8619f155` before, during and after.
* The deployed and E2E instances were already on the **same commit** (`8619f15`), so even the shared
  tmux server saw no behavioural change.
* `e2e-env.sh test-self` phase 3, run last, independently asserts the deployed instance is answering,
  on its own data dir, rejecting the E2E bearer, its data dir untouched by E2E writes and its web
  build not clobbered — **5/5 ok**.

**Nothing needs re-running.** But the rule exists because this is invisible unless someone looks, and
the honest statement is: a concurrent actor restarted the deployed instance mid-sweep, it did not
affect the instance under test, and the brief's premise about the deployed footer is now stale.

### Other declared actions

1. **No mid-sweep web restart by `up`.** NF31 checked the pair and found the unit newer than the
   bundle, so nothing was restarted — the negative branch, recorded because the check firing and the
   check declining are both evidence it is live.
2. **`scripts/e2e-env.sh test-self` was run LAST**, after `/api/metrics` had been read. Its phase 3
   is destructive to `/api/metrics` and its phase 5 ends in `down`, so **the E2E environment is left
   stopped** (`orchestron-{api,web}-e2e` both `inactive`, data dir wiped, ports released, credentials
   survived). `up` + `fixtures` brings it back.
3. **No A/B parent worktree was built** — no axe count grew, so §11's comparison was not triggered.
   `git worktree list` shows no `ab-parent`.
4. **No production code changed.** The only edits in this sweep are probes under `scratchpad/`.
   No Mac deploy.

---

## Evidence

`scratchpad/e2e-runs/2026-09-12-batch21/` — not committed.

| file | what it shows |
|---|---|
| `00-base-sha.txt`, `00-build.txt`, `00-up.txt` | base sha; NF31 checking the bundle/unit pair and declining to restart |
| `00-footer-sha.json` + `.png` | the footer gate, `8619f155` |
| `00-cost-baseline.json`, `metrics-final.json`, `metrics-model.json`, `metrics-project.json` | `$0` / 0 sessions → `$0.33612` / 30 sessions, with both breakdowns |
| `nf39-test-probe.txt` | `npm run test:probe` 21/21 |
| `nf39-verify.json` / `.txt` | both recall assertions through the shared helper: seqs, skips, transcript text, the summary not scored, and the three negative controls |
| `nf39-vacuous.json` / `.txt` | the vacuous shape reproduced on real data (`answerSeq=1 afterUserSeq=0`) and the guard refusing it |
| `nf41-evidence.txt` | the four argv/prerequisite shapes, incl. `detail01.mjs`'s false `groups: []` |
| `headless-life.txt`, `headless01-get.json`, `life06-wake.json` | the four agent scenarios, 18/18 |
| `smoke-ui.txt`, `smoke-ui2.txt`, `detail01-groups.json` | PROJ/SPAWN/DASH/METRICS/META/SCHED; DETAIL-01's four groups |
| `cli-smoke.txt`, `cli06-modal.txt`, `cli06-answer-both.json` | CLI-01/02/06 incl. both inquiry controls |
| `set05.txt` | SET-05 readiness + three negative controls |
| `nf25-matrix.txt`, `nf26-matrix.txt`, `nf27-matrix.txt`, `nf30-matrix.txt` | 104/104 · 163/163 · 140/154 · 13/13 |
| `nf28.txt`, `nf29.txt` | focus-return 52/52; navigate-survive 3/3 + negative control |
| `nf32-m1.txt`, `nf32-m2.txt` | the two geometry methods and their disjoint `CHK` sets |
| `nf33-axe.txt`, `nf33-nondialog.txt` | dialog-scope a11y, 22 + 3 = 25 selects, 0 violations |
| `nf34-import.txt`, `nf35-verify.txt`, `nf36-verify.txt`, `nf37-verify-1680.json`, `nf37-copy.txt`, `nf37-toolresult.txt` | the batch-17..20 verifies |
| `page-axe.json` / `.txt` | the §11 page-scope matrix |
| `test-self.txt` | 23/23, incl. phase 3's five deployed-undisturbed assertions |
| `cost-breakdown.txt` | 6 of 31 records carry `costUsd`; why `/api/metrics` is the SSOT |
| `probes/` (70 files) | every probe, re-pointed to this run; `headless-life.mjs` and `nf30.mjs` import the checked-in helpers |
