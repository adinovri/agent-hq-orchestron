# E2E Phase 2 — resweep after batch 20 (NF37 + NF38)

**Base sha**: `b5866e56a2be13c62acf48ae4b7561738c2fb136` (`b5866e5`, `main`)
**End sha**: `b5866e56a2be13c62acf48ae4b7561738c2fb136` — **no drift**
**Env**: E2E instance only, API `:8091` / web `:3011`. Deployed `:8090` / `:3010` never contacted
except by `test-self` phase 3, which asserts it is *undisturbed*.
**Model**: Opus 5 (sweep driver). Fixtures pinned to `claude-haiku-4-5` except SPAWN-01, whose
assertion is "inherits nothing" and so cannot be pinned.
**Evidence**: `scratchpad/e2e-runs/2026-09-12-batch20/` (178 files, 4.9 MB, not committed).

---

## Headline

**17 / 17 smoke scenarios pass. Every batch-3..19 regression holds. NF37 and NF38 both verified.**

Two new findings, both in the **sweep harness**, not the product — and both produced *wrong verdicts
inside this run* before being caught:

* **NF39** — the two-turn recall assertions read `finalResponse`, which the product documents as a
  structured-output **summary**. It produced two false FAILs here and a lucky PASS last sweep.
* **NF40** — `nf30.mjs` silently ignores an env-file argument, so the documented
  "re-run Kill on a fresh fixture" recipe measured a stale, sleeping fixture and failed 3/3.

The new §11 convention was exercised for the first time and **it works** — see the A/B below, which
caught something stronger than expected: the same commit, same build, measured twice minutes apart,
reported `/dashboard` `color-contrast` as **21** and then **23**. That is the convention's premise
demonstrated live, on one build, with no code change between readings.

---

## Environment and the two gates

`build` → `up` → `reset` → `fixtures`. **NF31 fired and repaired on the first `up`** — it is not a
dormant check:

```
warn orchestron-web-e2e.service has been up since 2026-09-12 14:24:57,
     but the bundle was rebuilt at 2026-09-12 17:46:03
warn next start reads the build at boot — this process is serving the PREVIOUS build
==> Restarting orchestron-web-e2e.service so it picks the new one up
  ok   web restarted onto the current bundle
```

**Footer sha gate, both ends** — the reading a timestamp cannot fake:

| moment | footer sha | verdict |
|---|---|---|
| before scenario 1 | `b5866e56` | == BASE_SHA |
| after last scenario | `b5866e56` | == BASE_SHA |

The parent build served on `:3012` read `d246c95f`, confirming the A/B compared two *different*
bundles against the *same* API.

**Probe re-pointing (the repeated-vacuous-PASS trap).** All 57 probes were copied and every
`e2e-runs/...` path rewritten to this run's directory — `grep -rn batch19 probes/` returns nothing.
Output mtimes were checked against wall-clock before scoring: every artefact was written during this
run (`17:45`–`18:4x`), none read from a previous sweep.

---

## Scenario results — 17 / 17

| Id | Result | Notes |
|---|---|---|
| SPAWN-01 | pass | navigated to `/session/7b5627f7…`; `useTmux=true`; model+effort **absent** — nothing inherited |
| SPAWN-05 | pass | `useTmux=false`, `tmuxName=headless-8fc1156b`, model pinned `claude-haiku-4-5` |
| LIFE-01 | pass | kill → `killed`; reopen → **same** record id `ee23f15b…` and **same** `claudeSessionUuid` `4c2957ec…`, back to `spawning` |
| LIFE-06 | pass | slept on the 60 s timeout; transcript readable while `sleeping` (200, 453 B); `POST /input` woke it with no manual reopen; same uuid; **turn-2 answer** `apricot` at `seq 8`, after the turn-2 user entry (`seq 7`) and past the pre-send baseline (`seq 1`) |
| HEADLESS-01 | pass | turn 1 → `idle` (NF17 guard); **0** live harness processes between turns; same uuid; `lastActivityAt` advanced; turn-2 answer `ready` at `seq 8` |
| HEADLESS-04 | pass | `needs_input`; `pendingInquiry` carries a message + **2 typed fields** |
| META-01 | pass | model persisted `undefined → claude-opus-5`; Save enabled only once dirty |
| SCHED-01 | pass | `cron=0 3 * * *`, model pinned haiku |
| SCHED-09 | pass | exactly one *Run now* (`count=1`); navigated to the spawned session; ran on the pinned model |
| DASH-01 | pass | 5/5 cards strictly descending by `lastActivityAt` |
| DETAIL-01 | pass | collapsed by default (0 `h3`); four groups in order IDENTITY/LOCATION/COMMANDS/TIMING |
| PROJ-01 | pass | registered through the dialog form → `187bf7ec…` |
| METRICS-01 | pass | SESSIONS/TOKENS/COST tiles render (15 svg); per-project breakdown names a fixture |
| SET-05 | pass | anonymous `GET /api/readiness` → 200; **negative controls**: 200 with a junk bearer, `/api/health/detail` **401** anonymous / **200** authed, `/api/sessions` **401** anonymous |
| CLI-01 | pass | spawn (`id` ≠ `sessionUuid`, `useTmux=false`), **no tmux window**, send `ok:true`, archive → `succeeded` (re-read from the API, not the command's echo) |
| CLI-02 | pass | five verbs `ok:true`; failure through a pipe → `{ok:false,status:404}`; 21 430-byte payload parses whole, **0 bytes** on stderr |
| CLI-06 | pass | modal answered **by index** and **by text**; ambiguity refused; no-pending refused; inquiry **partial refused** and **both-fields accepted** |

### Scoring notes, none of them a product result

* **DETAIL-01 is scored from `detail01.mjs`.** The inline `/detail/i` locator in `smoke-ui.mjs` still
  matches nothing and reports `groups: []` — **sixth** consecutive sweep. `detail01.mjs` clicks the
  `"22s ago · 22s"` toggle and returns the four groups. This is now a standing tax on every sweep and
  is worth one line of fix in the carried-forward probe.
* **CLI-06 needed both controls to mean anything.** `cli-smoke.sh` answers one of the inquiry's two
  required fields and is correctly refused:
  `unanswered field(s): region — the agent said it cannot continue without them`. The positive
  control was then run explicitly: answering **both** returned `ok:true, answered:"inquiry"` with
  `prompt: "Which environment?: staging\nWhich region?: us-east-1"`. A refusal alone would not have
  distinguished "guards partial answers" from "cannot answer at all".
* **The two recall assertions were rewritten mid-sweep** and the reason is NF39 below. Both scenarios
  were **passing at the product level the whole time** — the transcripts show the right answers — but
  the probe was reading the wrong field.

---

## NF37 focused verify — the three commands announce themselves

Fix under test: `apps/web/lib/accessible-names.ts` (`commandRegionLabel`, `commandCopyLabel`).
Source confirms **three** `CopyableCommand` call sites (`apps/web/app/settings/page.tsx:188,197,220`)
and **none** passes a `label` override, so all three exercise the derived default.

### (a) Region names, two independent engines, live on `/settings`

Computed with axe's own `accessibleTextVirtual` **and** an independent manual ARIA walk
(`aria-labelledby` → `aria-label` → `label[for]` → ancestor `<label>` → `title`), the NF35 method:

| # | accessible name (both engines agree) | contains "restart"? |
|---|---|---|
| 1 | `Command: systemctl --user restart orchestron-api.service orchestron-web.service` | yes — and correctly so, it *is* a restart |
| 2 | `Command: launchctl kickstart -k gui/$(id -u)/com.orchestron.api && launchctl kickstart -k gui/$(id -u)/com.orchestron.web` | no |
| 3 | `Command: orchestron token rotate` | **no** |

**Three names, three distinct values, `axeName === manualName` on all three.** The third — the
rotation command that invalidates every paired device — no longer says "Restart command". That is
the whole of NF37, and it is closed.

### (b) Copy buttons, including the state change

| # | name before | name after click | `title` |
|---|---|---|---|
| 1 | `Copy systemctl --user restart orchestron-api.service orchestron-web.service` | unchanged | `Copy` |
| 2 | `Copy launchctl kickstart -k gui/$(id -u)/com.orchestron.api && …` | unchanged | `Copy` |
| 3 | `Copy orchestron token rotate` | **`Copied orchestron token rotate`** | `Copied` |

Three distinct names, each naming its own command. Clicking #3 changes **only** #3's name, the
`title` attribute survives for the visual tooltip, and the name reverts after the 1500 ms timer.
The clipboard was read back and holds `orchestron token rotate` — so the button that *says* it
copies the rotation command actually does.

### (c) The names were not bought with another violation

`/settings`, page scope, `wcag2a + wcag2aa`:

| rule | nodes |
|---|---|
| `button-name` | **0** |
| `aria-allowed-attr` | **0** |
| `aria-prohibited-attr` | **0** |
| `label` | 0 |
| `scrollable-region-focusable` | 0 |
| `color-contrast` | 9 (standing) |

### (d) NF36 still holds — tested on a block that *actually* overflows

At 1680 px the **first** command block fits (`scrollWidth 606 == clientWidth 606`), so testing it
would have been vacuous — exactly what the brief called out. Overflow was asserted first, then the
keyboard driven on block **#2** (`scrollWidth 832 > clientWidth 606`):

* `tabIndex=0`, `role=group` — present on all three `<pre>`
* focus reached it and `document.activeElement` matched
* focus-visible ring painted: `box-shadow … oklch(0.623 0.214 259.815) 0 0 0 2px`
* `ArrowRight` ×3 scrolled `scrollLeft 0 → 120`

The independent `nf36-verify.mjs` run confirms `scrollable-region-focusable = 0` and
`aria-prohibited-attr = 0` on `/settings` and on a session detail page.

### (e) The tool-result `<pre>` counts what it renders

With `mint-longresult.mjs` (an adopted hand-written transcript, no model call):

| source | value |
|---|---|
| `<pre>` `aria-label` | `Tool result, 4,000 characters` |
| toggle button text | `↳ result (4,000 chars)` |
| `textContent.length` actually rendered | `4000` |

All three agree, and the block is `role=group`, `tabIndex=0`, scrolls by keyboard (`0 → 488`).
The fixture minted 11 169 chars; the API truncates to 4 000 for display and **the label describes
what is rendered**, which is the correct referent.

### (f) Test counts

* `apps/web` — **322 / 322**, 21 files (up from 298; `lib/accessible-names.test.ts` contributes 24).
* `apps/tui` — FAIL, `Cannot find package 'ink'`. **Pre-existing**, identical at `main`, not counted.

---

## NF38 focused verify — the convention, and using it

### (a) The old rule is gone

`### A count that grew is a question, not a finding` (§11, L503). The previous wording survives only
as an explicitly repudiated quotation:

> This section used to end "a count that grew is a finding even when every individual node looks
> familiar", anchored to a remembered number (10 nodes at `29081b5`). **Do not do that.**

No prescriptive form of the old rule remains, and `10 nodes` / `29081b5` appear nowhere except inside
that retraction.

### (b) The recipe names every part it needs

| required element | present |
|---|---|
| build the parent in a throwaway worktree | `git worktree add /tmp/ab-parent <parent-sha>` |
| serve on a spare port | `PORT=3012 npm start -w apps/web`, "a spare port, not 3011" |
| the **same** API | `NEXT_PUBLIC_API_URL=http://127.0.0.1:8091`, plus "Both builds must talk to the **same API on 8091**, or the data is not held constant" |
| `E2E_WEB_BASE` | documented, and `harness.mjs` honours it (default `:3011`) |
| diff per route **and** per dialog | "Then diff per route *and* per dialog:" (L539) |
| three verdicts | *Identical* → not a regression; *Parent lower* → real finding; *Parent higher* → the batch fixed something it did not claim |

It also carries the trap that cost time before: build from the worktree **root**, not `-w apps/web`,
because `packages/shared` must compile first.

### (c) The scanner table's third row is honest

| scanner | rule it stands in for | scope |
|---|---|---|
| `lib/form-labels.ts` | `label`, `select-name` | every `<select>`, `input[type=file]`, `input[type=date]` |
| `lib/scroll-regions.ts` | `scrollable-region-focusable`, `aria-prohibited-attr` | every `<pre>` that can produce a scrollbar |
| `lib/accessible-names.ts` | **none — see below** | every element whose whole content is one caller-supplied expression |

The prose explains *why* "none" rather than hiding it: every axe name rule asks whether a name
**exists**, none can ask whether it is **true**. That is precisely the gap NF37 fell through.

### (d) The convention, used

Both builds against the same API `:8091`, same viewport, identical `axe.run`:

| route | `b5866e5` (HEAD) | `d246c95` (parent) | verdict |
|---|---|---|---|
| `/dashboard` | 23 | 23 | identical — data, not code |
| `/metrics` | 9 | 9 | identical |
| `/projects` | 6 | 6 | identical |
| `/schedules` | 6 | 6 | identical |
| `/settings` | 9 | 9 | identical |
| session detail | 9 | 9 | identical |

Cards rendered were equal too (21 on `/dashboard`, 20 on `/metrics`) — the data really was held
constant. **Dialog scope, all 13 dialogs, both builds**: `color-contrast` 13 with the identical
per-dialog breakdown (`DeleteRecordDialog` 4, `ProjectDialog` 2, `ProjectDialog_Edit` 2,
`DeleteProjectDialog` 2, `Spawn`/`Schedule`/`Adopt` 1 each), `select-name` 0, `label` 0, 22 selects
named. **Identical per route and per dialog → not a regression.** Nothing filed.

#### The convention proved itself harder than the A/B did

`/dashboard` `color-contrast` was measured **twice on the same commit and the same running bundle**,
about fifteen minutes apart:

| reading | `/dashboard` nodes | cards rendered |
|---|---|---|
| `page-axe.mjs`, earlier | **21** | fewer |
| `ab-contrast.mjs`, later | **23** | 21 |

No code changed between them — only how many session cards the fixtures happened to render. Under
the **old** rule this sweep would have filed a `21 → 23` regression against itself. That is the
clearest possible evidence that NF38's rewrite was correct, and it arrived without being sought.

---

## PAGE-scope axe — the §11 matrix

`wcag2a + wcag2aa`, `axe.run(document)`, once per route. Dialog-scope counts are reported **separately
and never added** — Base UI puts `role="dialog"` on the same element as `data-slot="dialog-content"`,
so page scope already contains every dialog node. The quoted totals are page scope.

| rule | impact | `/dashboard` | `/metrics` | `/projects` | `/schedules` | `/settings` | session detail |
|---|---|---|---|---|---|---|---|
| `color-contrast` | serious | 23 | 9 | 6 | 6 | 9 | 9 |
| `label` | critical | **0** | **0** | **0** | **0** | **0** | **0** |
| `select-name` | critical | **0** | **0** | **0** | **0** | **0** | **0** |
| `button-name` | critical | **0** | **0** | **0** | **0** | **0** | **0** |
| `scrollable-region-focusable` | serious | **0** | **0** | **0** | **0** | **0** | **0** |
| `aria-prohibited-attr` | serious | **0** | **0** | **0** | **0** | **0** | **0** |
| `aria-allowed-attr` | serious | **0** | **0** | **0** | **0** | **0** | **0** |

**Every critical and serious rule except `color-contrast` is zero on every route**, and
`color-contrast` is identical to the parent build on every route.

`/dashboard`'s `color-contrast` is quoted from the A/B run (`ab-contrast.json`), the reading taken
against the parent under identical data. The earlier standalone run (`page-axe.json`) recorded
**21** on the same build — the discrepancy is the subject of the section above and is a property of
the fixture population, not of the commit. Every other cell is identical in both runs.

---

## Regression hold — batches 3..19

| finding | expected | measured | verdict |
|---|---|---|---|
| NF25 dialog dismiss | 104 | **104 / 104** | HOLD |
| NF26 close guard | 163 | **162 / 163** in batch; Kill **15/15 ×3** fresh | HOLD (documented flake) |
| NF27 stays-open (six standing surfaces) | 78 | **78 / 78** | HOLD |
| NF27 stays-open (all 13) | 140 / 154 | **140 / 154** | HOLD |
| NF28 focus return | 52 | **52 / 52** | HOLD |
| NF29 navigate survive | 3 | **3 / 3** | HOLD |
| NF30 dialog error — injected 500 | 13 | **12 / 13** in batch; Kill **1/1 ×3** fresh | HOLD (same flake) |
| NF30 dialog error — real refusal | 13 | **7** retarget + **6** body-corrupted = **13 / 13** | HOLD |
| NF31 `e2e-env.sh` | 20 + 23 | **20 / 20** + **23 / 23** | HOLD |
| NF32 error-box inset | 13 / 13 | **8 + 5** (m1) ∪ **10 + 3** (m2) = **13 / 13** | HOLD |
| NF33 `select-name` + `label` | 0 + 0 across 25 selects | **0** + **0**, 22 dialog + 3 page = **25** | HOLD |
| NF34 Import prefixed + parsed | — | `HTTP 404: Project not found: …` (parsed) vs Spawn's raw `{"error":…}` | HOLD |
| NF35 date inputs named | 4 | **4 / 4**, `axeName === manualName` on all four | HOLD |
| NF36 `<pre>` focusable | 2 | **2 / 2**, keyboard scroll `0 → 488` and `0 → 120` | HOLD |
| `apps/web` vitest | 322 | **322 / 322** (21 files) | HOLD |

**NF26's single miss and NF30's are the same documented mechanism**, confirmed rather than assumed:
the Kill fixture outlives the 60 s `idleTimeoutMs` during a 13-dialog sweep, and a sleeping session
has no Kill button (`waiting for locator('button[title^="Kill session"]')`). Minted immediately
before each attempt, Kill returns **15/15 three times out of three** (NF26) and **1/1 three times out
of three** (NF30). Kill's NF32 geometry reads `gutter=16/16 ml=0px` — the batch-18 fix, still in
place against the 32 px it showed at batch-17.

**NF32 needs both methods and gets 13/13 from their union**, unchanged in shape: method 1 (error box
vs previous sibling) resolves 8 and reports 5 `CHK` where the sibling is full-bleed; method 2 (vs the
dialog's own body text and footer button) resolves exactly those 5 and reports 3 `CHK` that method 1
already cleared. The two `CHK` sets are disjoint and their union is all 13.

**NF34's asymmetry is not re-filed** — a deliberate deferral recorded at batch-18.

**`apps/tui` is not counted.** Pre-existing `ink` failure, identical at `main`.

---

## New findings

### NF39 — the recall assertions read `finalResponse`, which is documented to be a summary (LOW, sweep harness)

**What.** `headless-life.mjs` scores HEADLESS-01 and LIFE-06's "the second turn remembers the first"
by regex-matching the planted word against the session record's `finalResponse`. But with structured
output on — the default — `finalResponse` is **not** the model's words. `session-manager.ts:1267`
assigns `patched.finalResponse = doc.summary`, and `docs/e2e-tests/headless-flow.md` (HEADLESS-06)
states it outright: `finalResponse` holds prose "**not** a one-line summary of it" *only when the
flag is off*. The probe asserts against a field the docs define as a summary.

**Impact.** The assertion is non-deterministic — it passes only when the model's self-summary happens
to quote the word. This sweep it did not, twice, and both scenarios reported FAIL while the product
was behaving correctly:

| scenario | `finalResponse` (summary) | actual answer in transcript |
|---|---|---|
| HEADLESS-01 | `"Responded with the requested word."` | `seq 8` → `ready` |
| LIFE-06 | `"Responded to user request as instructed."` | `seq 8` → `apricot` |

The post-batch-19 PASS on this assertion was luck, not evidence. A probe that flaps between PASS and
FAIL for reasons unrelated to the code under test is worse than no probe: it trains the reader to
discount the result.

**Repro.** Spawn a headless session with `Reply with the single word: ready.`; send a second turn via
`POST /api/sessions/:id/input` asking it to recall the word; read `finalResponse`. Compare against
`GET /api/sessions/:id/transcript`.

**Suggested fix.** Assert on the transcript's assistant entry that answers the latest user turn, not
on `finalResponse` — which is what this sweep's probe now does. Two guards are required, and both
were learned the hard way here:

1. *Not* "the last assistant entry" — between headless turns Claude Code injects the resume pair
   (`Continue from where you left off.` / `No response requested.`, `seq 5/6`), and a naive probe
   settles on the nudge reply and scores it as the answer.
2. *Not* "any assistant entry past turn 1" — polling before the turn-2 **user** entry is even
   persisted makes **turn 1's** answer look like the answer, and the assertion passes **vacuously**
   on the word turn 1 planted. This actually happened mid-sweep: a run reported
   `answerSeq=1 afterUserSeq=0 text="apricot"` as a PASS.

The assertion that survives both: capture `maxSeq` **before** sending, then require an assistant
entry strictly after the latest user entry, itself strictly after that baseline. Final readings:
`answerSeq=8 afterUserSeq=7 baseSeq=1 text="ready"` and `… text="apricot"`.

**Evidence.** `headless-life.txt`, `headless01-get.json`, `life06-only.json`, `probes/headless-life.mjs`.

---

### NF40 — `nf30.mjs` silently ignores the env-file argument, defeating the documented Kill recipe (LOW, sweep harness)

**What.** Every other matrix probe takes the fixture file as `argv[3]`
(`nf26.mjs`: `const env = JSON.parse(fs.readFileSync(process.argv[3]))`). `nf30.mjs` instead
hardcodes `const env = JSON.parse(fs.readFileSync('./env.json'))` and uses `argv[2]` only to select
the dialog. So `node nf30.mjs KillConfirmDialog ./env-kill.json` — the exact shape `run-matrix.sh`
uses for the other matrices, and the shape the documented Kill workaround implies — **accepts the
argument and ignores it**, measuring whatever stale fixture `env.json` still names.

**Impact.** The standing remedy for the known Kill flake is "re-mint the fixture, then re-run".
Following it against `nf30.mjs` re-mints into `env-kill.json` and then measures the *old* session,
which by then is asleep and has no Kill button. It fails identically to the flake it was supposed to
rule out, so the operator sees `0/1` three times running and has no signal distinguishing "fixture
stale" from "NF30 regressed". In this sweep that cost three full 30 s-timeout runs and very nearly
produced a false regression report against NF30.

**Repro.**
```bash
node mint-kill-env.mjs                       # writes ./env-kill.json only
node nf30.mjs KillConfirmDialog ./env-kill.json
# → FAIL, waiting for locator('button[title^="Kill session"]')
cp env-kill.json env.json && node nf30.mjs KillConfirmDialog
# → PASS  role=alert live=assertive gutter=16/16 ml=0px
```

**Suggested fix.** Give `nf30.mjs` the same signature as its siblings — `argv[2]` dialog,
`argv[3]` env file defaulting to `./env.json`. A probe that accepts an argument it does not read is
worse than one that rejects it: rejecting it would have failed loudly in one second.

**Evidence.** `probes/nf30.mjs:21,26` vs `probes/nf26.mjs:5-6`; `nf30-matrix.json`.

---

### Standing, not re-filed

`smoke-ui.mjs`'s DETAIL-01 locator (`/detail/i` over button text) has matched nothing for **six
consecutive sweeps** and reports `groups: []`; `detail01.mjs` carries the scenario. It is a known
carried-forward probe bug rather than a new finding, but six sweeps of a permanent FAIL line in the
default driver is now costing more attention than the one-line fix would.

---

## Cost

Read from `/api/metrics` **before** any cleanup, against a genuine `$0` / 0-session baseline taken
before the first scenario.

**Total: $0.41364 — 44 sessions, 1 285 520 tokens.**

| by model | sessions | cost | share |
|---|---|---|---|
| `claude-opus-5` | 1 | **$0.19188** | **46.4 %** |
| `claude-haiku-4-5-20251001` | 16 | $0.22145 | 53.5 % |
| `claude-haiku-4-5` | 27 | $0.00031 | 0.1 % |

| by project | sessions | cost |
|---|---|---|
| `e2e-claude` | 1 | $0.19188 |
| `e2e-headless` | 38 | $0.15920 |
| `e2e-haiku` | 5 | $0.06257 |

**One session is 46.4 % of the sweep, and it is the one that cannot be pinned.** SPAWN-01 asserts
that a fresh spawn inherits *no* model and *no* effort, so pinning a cheap model in its dialog would
delete the assertion. It lands on the `e2e-claude` project default (Opus 5). The figure has moved
61.8 % → 37.8 % → 46.4 % across batches 16/19/20 purely with how much the untouched session decides
to say; it is structural, not drift. Everything pinnable is pinned: 27 adopted fixtures cost
$0.00031 in total.

Per-record `costUsd` sums to only $0.2906 across the 12 records that carry one — tmux-backed sessions
(SPAWN-01, SCHED-09) report `costUsd: null` while still being counted by `/api/metrics`. The metrics
endpoint is the SSOT and is what is quoted above.

---

## §10 drift statement

| check | value |
|---|---|
| BASE_SHA | `b5866e56a2be13c62acf48ae4b7561738c2fb136` |
| END_SHA | `b5866e56a2be13c62acf48ae4b7561738c2fb136` |
| drift | **none** |
| tracked tree at start | clean (`git status --porcelain -uno` empty) |
| tracked tree at end | clean |
| footer sha before scenario 1 | `b5866e56` |
| footer sha after last scenario | `b5866e56` |

**Nothing outside the E2E instance was touched.** The deployed instance was never rebuilt, restarted
or contacted by any probe; `test-self` phase 3 independently asserts it: *deployed API still
answering*, *still on its own data dir*, *rejects the E2E bearer*, *data dir untouched by E2E
writes*, *web build not clobbered*. No Mac deploy. No production code changed — the only edits in
this sweep are probes under `scratchpad/`.

**Two deliberate mid-sweep actions, declared per §10:**

1. `up` restarted `orchestron-web-e2e.service` once, automatically, to repair the stale bundle (NF31
   doing its job — quoted above).
2. `scripts/e2e-env.sh test-self` was run **last**, after `/api/metrics` had been read. Its phase 3
   is destructive and wipes `/api/metrics`; running it mid-sweep is what corrupted the post-batch-19
   cost reading. Its phase 5 ends in `down`, so the E2E environment is **left stopped** — `up` +
   `fixtures` brings it back.

The A/B parent build (`d246c95`) was served on `:3012` from a throwaway worktree, read the same
`:8091` API read-only, and was stopped and the worktree removed before this report was written
(`git worktree list` shows no `ab-parent`).

---

## Evidence

`scratchpad/e2e-runs/2026-09-12-batch20/` — 178 files, 4.9 MB, not committed.

| file | what it shows |
|---|---|
| `00-base-sha.txt`, `00-up.txt` | base sha; NF31 detecting and repairing the stale bundle |
| `00-footer-sha.json` + `.png` | opening footer gate `b5866e56` |
| `00-cost-baseline.json`, `metrics-final.json` | `$0` / 0 sessions → `$0.41364` / 44 sessions |
| `smoke-ui.json`, `detail01-groups.json` | PROJ/SPAWN/DASH/METRICS; DETAIL-01 four groups |
| `headless-life.txt`, `headless01-get.json`, `life06-only.json` | the four agent scenarios, with `answerSeq`/`baseSeq` evidence |
| `cli-smoke.txt`, `cli06-*.json`, `cli06-answer-both.json` | CLI-01/02/06 incl. both inquiry controls |
| `set05.txt` | SET-05 readiness + three negative controls |
| `nf37-verify-1680.json` | three region names ×2 engines, overflow-asserted NF36 keyboard test |
| `nf37-copy.json` | copy-button names, `Copied` transition, clipboard read-back |
| `nf37-toolresult.json` | label `4,000` == button `4,000` == rendered `4000` |
| `page-axe.json`, `ab-contrast.json` | the §11 matrix and the HEAD-vs-parent A/B |
| `nf30-matrix.json`, `nf28-*.json`, `cost-breakdown.txt` | regression matrices and the cost split |
| `probes/` (65 files) | every probe, re-pointed to this run; `headless-life.mjs` carries the NF39 fix |
