# E2E Phase 2 — resweep after batch 19 (NF35 + NF36)

```
BASE_SHA  629afd07303b951c8befe0be3f17370e8695b943   (read 14:00)
END_SHA   629afd07303b951c8befe0be3f17370e8695b943   (read 14:41)
```

| | |
|---|---|
| Commit under test | `629afd0` — *fix(web): name the date inputs, let the keyboard into the scrollers* |
| Parent | `8e3c38c` (post-batch-18 resweep report) |
| Scenarios | **17 / 17 PASS** |
| NF35 | **VERIFIED** — `label` 4 → **0**, all four date inputs named, no new violation |
| NF36 | **VERIFIED** — `scrollable-region-focusable` 1 → **0**, `aria-prohibited-attr` **0**, keyboard in and scrolling |
| Regressions held | NF25 104, NF26 163, NF27 78/78 + 140/154, NF28 52, NF29 3, NF30 13+13, NF31 20+23, NF32 13/13, NF33 0+0, NF34 prefixed+parsed |
| `apps/web` vitest | **298 / 298** (was 280) |
| New findings | **1** — NF37 (LOW): `aria-label="Restart command"` is hardcoded for all three `/settings` commands, one of which is not a restart |
| Non-findings resolved | `color-contrast` growth (10 → 23) proven **data-driven, not code**, by A/B against the parent build |
| Drift | **NONE** |
| Cost | **`$0.507737`** total — `$0.507502` scenarios + `$0.000235` regressions |

---

## Headline

Both batch-19 fixes hold, and both were verified against the state they claim to have replaced
rather than against their own source. The parent commit `8e3c38c` was built and served alongside
`629afd0` on the same API data, so the "before" numbers in this report are **measured, not quoted**:
page-scope axe on the parent reports exactly `label` ×2 on `/dashboard`, `label` ×2 on `/metrics`
and `scrollable-region-focusable` ×1 on `/settings` — the 4 and the 1 that NF35 and NF36 named. On
`629afd0` all three are zero.

That same A/B settled the one thing that looked like a finding. §11 says a `color-contrast` count
that *grew* is a finding, and `/dashboard` read **23** against the documented baseline of **10**.
It is not a regression: on a fixed build the count moves between **13** (zero session cards) and
**23** (fifteen), and the parent build reports the identical 23 on the identical data. The baseline
was never a code-only constant. §11's rule as written would have produced a false finding here, so
it is filed below as a documentation defect rather than quietly ignored.

One new finding, LOW and introduced by NF36's own fix: the `aria-label` it added is hardcoded in a
shared component used by three different commands, and the third is `orchestron token rotate`.

**Two process failures of mine are reported in full rather than smoothed over.** I ran
`e2e-env.sh test-self` mid-sweep; its phase 3 is destructive and wiped the data dir, destroying
`/api/metrics` before I had read it. The cost table below is therefore **reconstructed** from the
surviving harness rollouts. And three probe bugs — two of them the exact traps batch-18 documented —
fired again because the probes were copied forward without the fixes their own report described.

---

## Environment

`build` → `up` → `reset` → `fixtures`, then a genuine `$0` baseline before the first scenario.

**NF31 had nothing to repair, twice.** `up` reported `web is serving the bundle on disk (built
14:02:16, up since 14:02:47)` on the first bring-up and again after the mid-sweep restore. The
browser footer read **`629afd07`** before the first scenario and again after the last — the reading
that cannot be faked by a timestamp.

The deployed instance was never rebuilt, restarted or contacted. A second web build (the parent
commit) was served on **:3012** from a throwaway worktree for the A/B; it was torn down and the
worktree removed before this report was written. It never touched :3011, :3010 or :8090 — it read
the same E2E API at :8091 read-only.

---

## Scenario results

| Id | Result | Notes |
|---|---|---|
| SPAWN-01 | pass | navigated to `/session/4811f5a4…`; `useTmux=true`; model+effort **absent** — nothing inherited |
| SPAWN-05 | pass | `useTmux=false`, `tmuxName=headless-e9c77abc`, model pinned `claude-haiku-4-5` |
| LIFE-01 | pass | kill → `killed`; reopen → **same** record id `d123abfa…`, **same** `claudeSessionUuid` `d1273496…`, back to `spawning` |
| LIFE-06 | pass | slept on the 60 s timeout; transcript readable while `sleeping` (200, 453 B); `POST /input` woke it with **no manual reopen**; same uuid; `lastActivityAt` advanced; **turn-2 answer** names the planted word |
| HEADLESS-01 | pass | turn 1 → `idle` (NF17 guard); **0** live harness processes between turns; turn 2 on the same uuid; `lastActivityAt` advanced; turn-2 `finalResponse` recalls *quokka* from turn 1 |
| HEADLESS-04 | pass | `needs_input`; `pendingInquiry` carries a message + **2 typed fields** (`environment`, `region`) |
| META-01 | pass | model persisted `undefined → claude-opus-5`; Save enabled only once dirty |
| SCHED-01 | pass | `cron=0 3 * * *`, model pinned haiku |
| SCHED-09 | pass | exactly one *Run now* (`count=1`); navigated to the spawned session; ran on the pinned model |
| DASH-01 | pass | cards strictly descending by `lastActivityAt` |
| DETAIL-01 | pass | collapsed by default (0 `h3`); four groups in order IDENTITY/LOCATION/COMMANDS/TIMING |
| PROJ-01 | pass | registered through the dialog form → `547d05ea…` |
| METRICS-01 | pass | SESSIONS/TOKENS/COST tiles render (15 svg); per-project breakdown names a fixture |
| SET-05 | pass | anonymous `GET /api/readiness` → 200 `{"status":"ready",…}`; **negative controls**: 200 with a junk bearer, `/api/health/detail` **401** anonymous / **200** with the token |
| CLI-01 | pass | spawn (`id` ≠ `sessionUuid`, `useTmux=false`), **no tmux window**, send `ok:true`, archive → `succeeded` (re-read from the API, not the command's echo) |
| CLI-02 | pass | five verbs `ok:true`; failure through a pipe → `{ok:false,status:404}`; 14 043-byte payload parses whole, **0 bytes** on stderr |
| CLI-06 | pass | inquiry answered by field; modal answered **by index** and **by text**; ambiguity refused; no-pending refused; partial refused |

### Scoring notes, none of them a product result

- **DETAIL-01** is scored from `detail01.mjs`. The inline `/detail/i` locator in `smoke-ui.mjs`
  still matches nothing and reports `groups: []` — the carried-forward probe bug, **fifth** sweep
  running. `detail01.mjs` clicks the `"28s ago · 28s"` toggle and returns the four groups.
- **CLI-06's partial answer was refused correctly** and is kept as a negative control
  (`cli06-partial-refused.json`): the inquiry has two required fields and the probe supplied one.
  Answering both returned `ok:true, answered:"inquiry"`, and the agent's follow-up inquiry quotes
  *"staging in us-east-1"* — proof the answers reached the harness, not just the API.
- **HEADLESS-01 needed one re-run, and the reason is a product behaviour worth knowing.** My
  turn-2 prompt was *"What single word did you just reply with?"*. Between the two turns the
  rollout contains the documented resume pair — Claude Code injects `"Continue from where you left
  off."` and the model answers `"No response requested."` (`apps/web/lib/transcript-entry.ts`,
  `RESUME_NUDGE`). So the word it had "just replied with" was literally *"No"*, and the model
  answered `"No"` — defensibly. Re-asked as *"In my very first message I asked you to reply with
  one specific word"*, it answered *quokka*. The nudge pair is intentional and already
  de-emphasised in the UI (NF8); **the probe was wrong, not the product.**

---

## NF35 focused verify — accessible names on the date inputs

Page-scope axe, `wcag2a + wcag2aa`, on `/dashboard` and `/metrics`.

| rule | `/dashboard` | `/metrics` | parent `8e3c38c` |
|---|---|---|---|
| `label` (critical) | **0** | **0** | **2 + 2 = 4** |
| `select-name` | 0 | 0 | 0 |
| `aria-prohibited-attr` | **0** | **0** | 0 |
| `aria-allowed-attr` | **0** | **0** | 0 |
| `aria-valid-attr-value` | **0** | **0** | 0 |

The "before" column is measured on a live build of the parent commit against the same API data, not
quoted from the batch-18 report. It reproduces NF35's claim exactly: four nodes, two per page.

### Computed accessible name, read live

Reading `aria-label` off the source proves the attribute exists; it does not prove a browser
computes a name from it. Each name was computed **twice** — once by axe's own engine
(`axe.commons.text.accessibleTextVirtual`, the same code that judges the rule) and once by an
independent walk of the ARIA naming order — and the two agree on all four.

| page | control | axe name | manual name | agree |
|---|---|---|---|---|
| `/dashboard` | FilterBar from | `"From date"` | `"From date"` | ✔ |
| `/dashboard` | FilterBar to | `"To date"` | `"To date"` | ✔ |
| `/metrics` | DateRangePicker from | `"From date"` | `"From date"` | ✔ |
| `/metrics` | DateRangePicker to | `"To date"` | `"To date"` | ✔ |

Four `input[type="date"]` found on the two pages, which is all of them — `form-labels.test.ts` pins
the source count at 4 and passes.

**No violation was traded for another.** `aria-prohibited-attr` and `aria-allowed-attr` are both 0:
`aria-label` is legal on `input[type=date]` (it has an implicit `textbox`-family role), so unlike
the `<pre>` case in NF36 no explicit `role` was needed here.

---

## NF36 focused verify — the scrollers are reachable

### `/settings`

| rule | `629afd0` | parent `8e3c38c` |
|---|---|---|
| `scrollable-region-focusable` (serious) | **0** | **1** |
| `aria-prohibited-attr` | **0** | 0 |
| `aria-allowed-attr` | **0** | 0 |

`aria-prohibited-attr` staying at 0 is the load-bearing half. `<pre>` is generic, `aria-label` is
prohibited on a generic element, and naming it without a role would have traded `serious` for
`serious`. `role="group"` is what makes the name legal, and axe agrees.

**Keyboard reachability.** Tabbing from the top of the page lands on the `<pre>` at **press 8**:

```
{"tag":"PRE","role":"group","label":"Restart command","ti":"0","steps":8}
```

**The focus ring is painted, not merely declared.** `:focus-visible` matches, and the computed
`box-shadow` carries `oklch(0.623 0.214 259.815) 0px 0px 0px 2px` — `ring-2 ring-blue-500`.
Screenshot: `nf36-settings-focus-ring.png`.

**Keyboard scrolling works — and the first way I measured it was vacuous.** `/settings` renders
**three** `CopyableCommand` blocks, and at 1680 px only the middle one (the macOS `launchctl`
command) overflows. My first probe tabbed to the first block, pressed ArrowRight and saw
`scrollLeft 0 → 0`, because that block *fits* (`scrollWidth 606 = clientWidth 606`). Re-measured on
the block that actually overflows, and across widths:

| width | pre[0] `systemctl…` | pre[1] `launchctl…` | pre[2] `token rotate` | keyboard scroll | axe |
|---|---|---|---|---|---|
| 1680 | fits | **scrolls** (832/606) | fits | pre[1] `0 → 226` ✔ | 0 |
| 900 | fits | **scrolls** (832/606) | fits | pre[1] `0 → 226` ✔ | 0 |
| 600 | **scrolls** (538/534) | **scrolls** (832/534) | fits | pre[0] `0 → 4` ✔ | 0 |
| 420 | **scrolls** (538/354) | **scrolls** (832/354) | fits | pre[0] `0 → 184` ✔ | 0 |

All three carry `tabIndex=0 role=group`, so the fix covers the blocks that only overflow at narrow
widths too — which is the right call, since which block scrolls depends on the viewport.

### The second `<pre>` — TranscriptPanePoll's expanded tool result

This one could not be measured on live data: the longest `tool_result` any session in this run
produced is **135 characters**, nowhere near the `max-h-64` (16 rem) ceiling — exactly the reason
the commit message gives for it having escaped earlier scans. So a transcript carrying a 11 169-character
tool result was **adopted** (hand-written rollout, no model call, ~`$0`) to force the overflow.

```
ti=0 role=group label="Tool result" ws=pre-wrap scrollY=true (742/254)
keyboard: {"focused":true,"before":0,"after":488,"moved":true}
```

Focusable, named, and ArrowDown scrolls it. Page-scope axe on that detail page:
`scrollable-region-focusable = 0`, `aria-prohibited-attr = 0`.

### The third `<pre>` — deliberately left alone

`TranscriptPanePoll`'s `tool_use` details block wraps (`whitespace-pre-wrap break-all`), so it
cannot scroll and a tab stop there would be gratuitous. Measured on the same page, with the block
expanded:

```
ti=null role=null ws=pre-wrap scrollY=false scrollX=false (66/66)
```

`scrollHeight == clientHeight`, `scrollWidth == clientWidth`, and **axe does not flag it**
(`scrollable-region-focusable = 0` for the whole page). The omission is correct, and
`scroll-regions.ts`'s split of `scrollAxes` by axis — sideways needs non-wrapping content, downwards
needs a capped height — is what encodes the distinction.

---

## PAGE-scope axe — the §11 matrix

`wcag2a + wcag2aa`, `axe.run(document)`, once per route. Dialog-scope counts are reported separately
below and **are not added to these** — Base UI puts `role="dialog"` on the same element as
`data-slot="dialog-content"`, so page scope already contains every dialog node.

| rule | impact | `/dashboard` | `/metrics` | `/projects` | `/schedules` | `/settings` | session detail |
|---|---|---|---|---|---|---|---|
| `color-contrast` | serious | 23 | 9 | 6 | 6 | 9 | 9 |
| `label` | critical | **0** | **0** | **0** | **0** | **0** | **0** |
| `select-name` | critical | **0** | **0** | **0** | **0** | **0** | **0** |
| `scrollable-region-focusable` | serious | **0** | **0** | **0** | **0** | **0** | **0** |
| `aria-prohibited-attr` | serious | **0** | **0** | **0** | **0** | **0** | **0** |
| `aria-allowed-attr` | serious | **0** | **0** | **0** | **0** | **0** | **0** |

**Every critical and serious rule except `color-contrast` is zero on every route.**

### The `color-contrast` count grew, and it is not a finding

`/dashboard` reads 23 against the 10 recorded at `29081b5`. §11 says a count that grew is a finding
even when the nodes look familiar, so this was chased rather than assumed.

**It is data, not code.** Two independent demonstrations:

1. **On one fixed build, the count moves with the number of rendered session cards.** Using the
   dashboard's own project filter to vary only how many cards render:

   | cards rendered | 15 | 9 | 1 | 0 |
   |---|---|---|---|---|
   | `color-contrast` nodes | 23 | 23 | 13 | **13** |

   There is a floor of 13 from page chrome, and the card population adds on top. The flagged nodes
   group in fives against five cards — `text-xs text-zinc-400 font-mono`, `text-[10px] … uppercase`,
   `text-zinc-500` — i.e. per-card text, not new markup.

2. **The parent build reports the identical count on the identical data.** `8e3c38c` served on :3012
   against the same API:

   | route | `629afd0` | `8e3c38c` | verdict |
   |---|---|---|---|
   | `/dashboard` | 23 | 23 | same |
   | `/metrics` | 9 | 9 | same |
   | `/projects` | 6 | 6 | same |
   | `/schedules` | 6 | 6 | same |
   | `/settings` | 9 | 9 | same |
   | session detail | 9 | 9 | same |

Dialog scope tells the same story: 13 nodes across the 13 dialogs on `629afd0`, and **the same 13
with the same per-dialog breakdown** on the parent (`DeleteRecordDialog` 4, `ProjectDialog` 2,
`ProjectDialog_Edit` 2, `DeleteProjectDialog` 2, `Spawn`/`Schedule`/`Adopt` 1 each). Batch-18's "10"
was measured against a different session population.

Independently, batch-19's diff cannot affect contrast: it adds `aria-label`, `tabIndex`, `role` and
a focus-only ring, and changes no color, no text and no element on any session card.

**This makes §11's rule as written wrong**, and that is filed as NF38 below.

---

## Regression hold — batches 3..18

| finding | expected | measured | verdict |
|---|---|---|---|
| NF25 dialog dismiss | 104 | **104 / 104** | HOLD |
| NF26 close guard | 163 | **163 / 163** (see flake note) | HOLD |
| NF27 stays-open (six standing surfaces) | 78 | **78 / 78** | HOLD |
| NF27 stays-open (all 13) | 140 / 154 | **140 / 154** | HOLD |
| NF28 focus return | 52 | **52 / 52** | HOLD |
| NF29 navigate survive | 3 | **3 / 3** | HOLD |
| NF30 dialog error — injected 500 | 13 | **13 / 13** | HOLD |
| NF30 dialog error — real refusal | 13 | **13 / 13** | HOLD |
| NF31 `e2e-env.sh` | 20 + 23 | **20 / 20** + **23 / 23** | HOLD |
| NF32 error-box inset | 13 / 13 aligned | **13 / 13** | HOLD |
| NF33 `select-name` + `label` | 0 + 0 | **0** + **0** | HOLD |
| NF34 Import prefixed + parsed | — | `HTTP 404: Project not found: …` | HOLD |
| `apps/web` vitest | 298 | **298 / 298** (20 files) | HOLD |

**NF26's 162/163 was the documented flake, confirmed not a regression.** The single miss was
`KillConfirmDialog`, whose fixture outlives the 60 s `idleTimeoutMs` during a 13-dialog sweep. Re-run
with a fixture minted immediately before each attempt: **15/15, three times out of three.** NF30's
Kill entry failed the same way in the batch run (`waiting for locator('button[title^="Kill session"]')`
— the button is absent once the session sleeps) and likewise came back **1/1 on 3/3 fresh runs**.

**NF27's two numbers are both batch-18's.** The six surfaces that were already on `DialogError`
before batch-17 score 13/13 each (78/78); the all-13 figure is 140/154, unchanged. Neither moved.

**NF32 needs both methods and gets 13/13 from their union.** Method 1 (error box vs its previous
sibling's inset) resolves 8 and reports 5 `CHK` where the sibling is full-bleed; method 2 (vs the
dialog's own body text and footer button) resolves those 5 and reports 3 `CHK` that method 1 already
cleared. `KillConfirmDialog` — the NF32 fix itself — reads `16px == 16px, ml=0px` under method 1 and
`err=16 text=16` under method 2, against the 32px/16px it showed at batch-17.

**NF33 holds at 25 named selects, 0 unnamed** — 22 inside dialogs (`label[for]`) and 3 outside
(`aria-label`: *Filter by project*, *Filter by group*, *Theme*), plus Import's file input named
*Bundle file*.

**`apps/tui` fails on missing `ink`.** Pre-existing, identical at `main`, not a regression, not
counted.

**NF34's asymmetry is not re-filed.** Import uses `throwIfNotOk` while twelve other dialogs keep
their hand-rolled checks; that is a deliberate deferral recorded at batch-18, and the scanner holds
the property they all share rather than forcing the mechanism.

---

## New findings

### NF37 — all three `/settings` commands announce as "Restart command" (LOW, introduced by batch-19)

**What.** NF36 added `aria-label="Restart command"` to `<pre>` inside `CopyableCommand`
(`apps/web/app/settings/page.tsx:47`). That component has **three** call sites:

| line | command | label is |
|---|---|---|
| 176 | `systemctl --user restart orchestron-*.service` | correct |
| 185 | `launchctl kickstart -k gui/$(id -u)/com.orchestron.*` | correct |
| **208** | **`orchestron token rotate`** | **wrong** |

**Impact.** A screen-reader user tabbing `/settings` hears *"Restart command"* three times, and the
third block is a token-rotation command. Rotating the token invalidates existing sessions, so the
mislabel points at an action with a different and more disruptive effect than the name implies.
Sighted users are unaffected — the label is not rendered. Not an axe violation: axe checks that a
name exists, never that it is true, which is why the page-scope matrix is clean.

**Repro.** `/settings` → Tab to any of the three command blocks → read the accessible name.
Measured live at four widths: all three report `role=group label="Restart command"`
(`nf36-settings-narrow.json`).

**Suggested fix.** Make the label a required prop rather than a constant:

```tsx
function CopyableCommand({ command, label }: { command: string; label: string }) {
  …<pre tabIndex={0} role="group" aria-label={label} …>
```

with `"Restart command (Linux)"`, `"Restart command (macOS)"`, `"Token rotation command"`. A
required prop makes the next call site state its own name instead of inheriting a wrong one.
`scroll-regions.ts` already pins the `<pre>` count, so the scanner will see a new call site; it
does not currently assert the name is distinct.

**Evidence.** `nf36-settings-narrow.json`, `nf36-verify.json`, `nf36-settings-focus-ring.png`.

### NF38 — §11's contrast rule produces false findings as written (LOW, documentation)

**What.** `docs/e2e-tests/00-setup.md` §11 *"Read the impact, not just the count"* says a
`color-contrast` count that grew "is a finding even when every individual node looks familiar", and
anchors it to "10 nodes at `29081b5`". The count is a function of how many session cards the
dashboard happens to render — **13 with none, 23 with fifteen, on one fixed build** — so a remembered
number cannot separate a code regression from a busier fixture set. Following §11 literally this
sweep would have filed a regression that does not exist.

**Impact.** Either a false finding, or — worse — the rule gets ignored after it cries wolf once, and
a real contrast regression rides in behind it.

**Repro.** `contrast-vs-cards.json`: filter `/dashboard` by project to vary only the card count and
watch 23 → 13 with no code change.

**Suggested fix.** Replace the remembered baseline with a comparison that holds data constant —
build the parent commit, serve it on a spare port against the same API, and diff per route:

```
| route | HEAD | parent | verdict |
```

That is what `ab-contrast.mjs` does, it takes about two minutes including the build, and it answers
the question the baseline was a proxy for. Keep the "watch critical and serious" half of §11, which
worked exactly as intended — it is what surfaced NF35 and NF36 in the first place.

**Evidence.** `contrast-vs-cards.json`, `contrast-isolate.json`, `ab-contrast.json`.

---

## Cost

**`/api/metrics` for the scenario segment was destroyed before I read it.** I ran
`scripts/e2e-env.sh test-self` to score NF31; its phase 3 is destructive — it wipes the data dir and
stops both units — and it is meant to run at the *end* of a sweep. Running it mid-sweep took the
metrics with it. The brief said to read `/api/metrics` before any cleanup; I did not.

The scenario segment below is therefore **reconstructed** from the 27 harness rollouts that survived
under `~/ClaudeConfigs/e2e/projects/`, which carry per-message `usage` and `model`. It is priced with
`apps/api/src/domain/pricing-table.ts` — the API's own table — so the number is what `/api/metrics`
would have reported, not an independent estimate. Token counts are ground truth; only the aggregation
is mine. The regression segment was read directly from `/api/metrics` before cleanup.

| | |
|---|---|
| **Total** | **`$0.507737`** |
| Scenario segment (reconstructed, 27 rollouts, 1 565 637 tokens) | `$0.507502` |
| Regression segment (direct read, 21 sessions) | `$0.000235` |
| SPAWN-01 — structurally unpinnable | `$0.191878` (**37.8 %**) |
| **Wasted on my own probe bugs** | **`$0.033857` (6.7 %)** |
| Retarget artifact (batch-17's `$0.39`) | **`$0` — did not recur** |

| rollout | cost | what | wasted |
|---|---|---|---|
| `62c47e0d` | **`$0.191878`** | **SPAWN-01**, `claude-opus-5` — cannot be pinned; its whole assertion is that `e2e-claude` inherits *nothing* | |
| `e9c77abc` | `$0.048437` | SPAWN-05, reused for DETAIL-01 | |
| `8dd33956` | `$0.038452` | CLI-01 | |
| `117c0ed2` | `$0.035812` | CLI-06, inquiry half | |
| `c0271663` | `$0.033857` | HEADLESS-01, re-run with a nudge-proof prompt | **yes** |
| `a7de1a29` | `$0.032648` | LIFE-06 | |
| `f34e9b22` | `$0.029916` | CLI-06 modal, answered by text | |
| `f88fc9bd` | `$0.029681` | CLI-06 modal, answered by index | |
| `dfe5b670` | `$0.028649` | HEADLESS-01, first attempt | |
| `66856312` | `$0.021098` | LIFE-01 | |
| `670216cf` | `$0.016883` | HEADLESS-04 | |
| `503a78cf` | `$0.000022` | NF36 long-tool-result fixture (adopted) | |
| 15 × `$0.000011` | `$0.000168` | adopt pool + terminal/active/idle fixtures | |

**The avoidable part, stated plainly.** `$0.033857` — 6.7 % — bought nothing: HEADLESS-01 ran twice
because my turn-2 prompt collided with the documented resume nudge. The first attempt is *not*
counted as waste, since it produced the valid turn-1, same-uuid and `lastActivityAt` results; only
the re-run is.

**The two probe bugs that cost wall-clock but `$0`:** the stale-`RUN` bug (below) made CLI-01 and
CLI-06 *skip* their spawns rather than repeat them, so nothing was paid for twice; and the two
`__status` assertion bugs were pure false alarms.

**Batch-17's retarget artifact did not recur.** Every refusal probe corrupts a request **body**;
the five unsafe URL retargets remain removed from `setup-env.mjs`. No session or schedule was
created by any refusal probe, verified against the API.

---

## Traps

**New this run:**

- **`e2e-env.sh test-self` phase 3 is DESTRUCTIVE — it wipes the data dir and stops both units.**
  It belongs at the very end of a sweep. Run it mid-sweep and you lose `/api/metrics`, every session
  record, and the environment. Read `/api/metrics` *before* it, not after.
- **Copying last sweep's probes forward copies last sweep's `$RUN`.** `harness.mjs` was re-pointed at
  the new run directory but the two `.sh` probes were not. Several probes guard spend with
  `if [ ! -s "$RUN/cli01-spawn.json" ]` — pointed at the *previous* run's directory that guard sees a
  file, skips the spawn, and the probe then asserts against **last sweep's ids**. It reported
  `PASS [CLI-01] spawn returned a session id` for a session that had not existed since `reset`, and
  only the downstream 404s gave it away. **Re-point `$RUN` in every probe, then check mtimes** —
  `cli01-spawn.json` was timestamped 11:35 while its siblings were 14:10.
- **`api()` helpers differ between probes in the same directory.** `setup-env.mjs` sets `__status`
  only on failure; `headless-life.mjs` sets it always. An assertion of `__status === undefined`
  written for one is a guaranteed false FAIL in the other — it reported `FAIL … HTTP 200`.
- **The resume nudge changes what "just" means.** Claude Code injects `"Continue from where you left
  off."` / `"No response requested."` between headless turns (`RESUME_NUDGE`). A recall prompt phrased
  *"what did you just say"* is answered about the nudge. Anchor recall to *"my very first message"*.
- **An arrow-key scroll test is vacuous unless the element actually overflows.** `/settings` has three
  `<pre>` and only the middle one overflows at desktop width; testing the first reports
  `scrollLeft 0 → 0` and looks like a broken fix. Assert `scrollWidth > clientWidth` before pressing a key.
- **A page-scope axe baseline is a function of the fixture data, not just the commit.** `/dashboard`
  is 13 nodes empty and 23 with fifteen cards on one build. Compare against a live parent build, not
  a remembered number.
- **`axe.utils.getNodeFromTree` returns `null` after `axe.run` completes** — the flat tree is torn
  down. Call `axe.setup(document)` before computing names, and `axe.teardown()` after.

**Carried and hit again:**

- `smoke-ui.mjs`'s DETAIL-01 locator matches nothing; score from `detail01.mjs`. **Fifth sweep.**
- `POST /api/sessions/:uuid/input`, **not** `/send` — `headless-life.mjs` still carried the `/send`
  bug batch-18 documented. Fixed before running, so it cost nothing this time.
- `pendingInquiry`, **not** `pendingPrompt`, is the structured-inquiry key — also still wrong in the
  carried-forward probe, also fixed before running.
- **`tokenUsage` is per-turn, not cumulative** — `headless01-rerun.mjs` still asserted `tok2 > tok1`
  and failed on 369 → 293. `lastActivityAt` is the only monotonic evidence a second turn ran.
- Kill needs a fixture minted immediately before the probe; `idleTimeoutMs` is 60 s. Cost NF26 and
  NF30 one apparent failure each.
- Adopt consumes a uuid per run; refill with `mint-pool.mjs`.
- `apps/cli/bin/orchestron` loads `dist/`, so the CLI was rebuilt before CLI-01/02/06.
- A URL retarget is only a refusal if the new URL cannot succeed. Corrupt the body instead.
- Do not sum page-scope and dialog-scope axe counts.

---

## §10 drift statement

```
BASE_SHA  629afd07303b951c8befe0be3f17370e8695b943   (read 14:00)
END_SHA   629afd07303b951c8befe0be3f17370e8695b943   (read 14:41)
git diff --name-only BASE END  →  (empty)
git status --porcelain (tracked) →  (empty, both ends)
```

**NO DRIFT.** `main` did not move during the sweep and the tracked tree was clean at both ends.
Every result above describes `629afd0` and nothing else.

The bundle under test was confirmed independently of `up`'s own reporting: the browser footer read
**`629afd07`** before the first scenario and again after the last.

**Two environment actions this sweep, both disclosed per §10:** the E2E web and API units were
stopped and restarted mid-sweep — not by hand, but as a consequence of my running `test-self`, whose
phase 3 tears the environment down. The environment was rebuilt with `up` + `fixtures` and NF31's
bundle check passed again on the way back. Separately, a **second web build of the parent commit was
served on :3012** for the A/B and then removed. The deployed instance on :8090 / :3010 was never
contacted.

---

## Evidence

`scratchpad/e2e-runs/2026-09-12-batch19/` (not committed — `e2e-runs/` stays out of git).

| file | what it holds |
|---|---|
| `00-base-sha.txt`, `00-build.txt`, `00-up.txt` | BASE_SHA, build and bring-up logs |
| `00-cost-baseline.json` | the genuine `$0` baseline |
| `cost-reconstructed.json/.txt` | scenario-segment cost rebuilt from surviving rollouts |
| `metrics-final.json`, `metrics-regression-baseline.json` | regression-segment cost, read before cleanup |
| `nf35-verify.json` | **NF35** — axe per page + computed names, two engines |
| `nf36-verify.json` | **NF36** — `/settings` axe, tab walk, focus ring, all three `<pre>` |
| `nf36-settings-narrow.json` | **NF36** — overflow and keyboard scroll at 1680/900/600/420 |
| `nf36-settings-focus-ring.png`, `nf36-settings-scrolled.png`, `nf36-toolresult-scrolled.png` | **NF36 / NF37** screenshots |
| `page-axe.json`, `page-axe.txt` | **§11** page-scope matrix, six routes |
| `ab-contrast.json` | **§11** A/B vs the parent build — the contrast verdict |
| `contrast-vs-cards.json`, `contrast-isolate.json` | contrast vs card count; theme ruled out |
| `regression-nf25-27.txt`, `nf26-kill-refresh.txt`, `nf30-kill-refresh.txt` | NF25/26/27 matrices + the Kill flake re-runs |
| `npm-test-web.txt`, `nf31-shell-test.txt`, `nf31-test-self.txt` | 298/298, 20/20, 23/23 |
| `smoke-ui.txt`, `smoke-ui2.txt`, `detail01.txt`, `headless-life.txt`, `headless01-rerun.txt`, `set05.txt`, `cli-smoke.txt`, `cli06-modal.txt` | the 17 scenarios |
| `probes/*.mjs`, `probes/*.sh` | the probes, with this run's `env.json` |

**Probe caveats for reuse.** `harness.mjs` now honours `E2E_WEB_BASE`, which is what makes the A/B
possible — set it to a second build's port and every probe re-targets. `headless-life.mjs` and
`headless01-rerun.mjs` were fixed this run (`/input`, `pendingInquiry`, per-turn tokens); the `.sh`
probes' `$RUN` is pointed at this run and **must be re-pointed again next sweep** or their spend
guards will read stale files. `mint-longresult.mjs` is new and mints the overflowing tool result
NF36's second `<pre>` needs.
