# E2E Phase 2 — resweep after batch 15 (NF28)

**BASE_SHA** `e4b513c27450b9a867266fa968645837d8d352aa` (`e4b513c`) — read 22:30, before the first scenario
**END_SHA**  `e4b513c27450b9a867266fa968645837d8d352aa` (`e4b513c`) — read 23:34, after the last measurement
**Drift verdict** **NO DRIFT.** Both §10 reads returned the same sha and the working tree was clean at
both ends. Nothing in this report describes code that has since moved.

**Scenarios** 17 attempted / 17 in the smoke set — **17 PASS · 0 PARTIAL · 0 FAIL · 0 SKIP**
**NF28 focused verify** 13 dialog instances × 3 paths = **52 measurements, 49 PASS / 3 FAIL**.
**NF28 is PARTIALLY FIXED**, and the gap is one clean mechanism, not three coincidences.
**NF25 regression** 10 dialogs × 8 = **80/80**. **NF26** **119/119** across 9 dialogs + Kill.
**NF27** 6 dialog surfaces (**78/78**) + 2 toast surfaces (**17/17**).
**Cost** `$0.37868115` (`GET /api/metrics`, 27 costed sessions, 864 491 tokens), read **before** any
cleanup. **Adopted-transcript contamination this run: $0.00022 (0.06%)** — down from batch-14's
26.5%, see Cost.
**Run** 2026-09-11, isolated env (`scripts/e2e-env.sh`, api :8091 / web :3011), Chromium/Playwright
1680×1000, harness `claude` on the E2E config dir.
**Evidence** `scratchpad/e2e-runs/2026-09-11-batch15/`.

**One new finding: NF29 (LOW→MEDIUM).** One recorded-not-filed: the failure path still parks focus
on `<body>` while the dialog is open.

---

## Headline

**The fix works, and it works for the reason the PR says it does — on 10 of 13 dialog instances.
The three it misses are exactly the three whose success navigates away.**

| batch-15 claim | verdict |
|---|---|
| After a dialog closes, focus is never left on `<body>` | **10 / 13 instances.** Holds on every dialog whose page survives its own success |
| Escape and Cancel stay correct (negative control) | **HOLDS — 26/26**, no regression on any dialog |
| A failed mutation must not fire the audit (dialog stays open) | **HOLDS — 13/13**, and focus never jumped to `<main>` |
| Focus must not stick on a still-`disabled` confirm | **HOLDS — 49/49**, `disabled` false on every landing |
| Trigger unmount falls back to `<main tabindex="-1">` | **HOLDS where the page survives** (Adopt, Import, and a real Base UI delete). **FAILS on navigate-on-success** — see NF29 |
| Known limit: Base UI late restore beats the `<main>` fallback | **NOT REPRODUCED.** A real Base UI trigger unmount landed on `<main tabindex="-1">`, not a third element |
| `apps/web` 228 tests | **CONFIRMED — 228 passed**, the PR's number exactly |

Tests: **web 228 · api 699 · cli 138 · file-store 11.** `apps/tui` fails on
`Cannot find package 'ink'` — **pre-existing since batch-13**, unrelated.

---

## Environment integrity — checked before any scenario ran

**The inherited E2E web bundle was stale again — the fourth sweep running.**

| artefact | timestamp | verdict as inherited |
|---|---|---|
| batch-15 web sources (`lib/focus-*.ts`, `lib/use-focus-return.ts`, 10 dialogs) | 22:27:40 | — |
| `apps/web/.next-e2e/BUILD_ID` | **21:03:30** | **before the sources ✗** — batch-14's bundle |

So `down` → `build` → `up` → `fixtures` from an empty data dir, which also gave a clean **`$0` cost
baseline** (`00-cost-baseline.json`). After:

| artefact | value | verdict |
|---|---|---|
| `apps/web/.next-e2e/BUILD_ID` | **22:35:00** | after the 22:27:40 sources ✓ |
| `orchestron-api-e2e` / `orchestron-web-e2e` start | 22:40:15 / 22:40:17 | after the build ✓ |
| **web footer, rendered in the browser** | **`v e4b513c2`** | the commit under test ✓ |

`apps/api/dist`, `apps/cli/dist` and `packages/shared/dist` predate the commit and are **correct, not
stale**: `git diff --name-only f3367a4 e4b513c | cut -d/ -f1-2 | sort -u` is exactly **`apps/web`**
(14 files — the 10 dialogs plus 4 lib files). Every API- and CLI-side check below is therefore a
regression check against a byte-identical binary, not a re-measurement.

---

## Part A — NF28 focused verify

### Method

Per dialog instance, in a real browser, three paths. The trigger is **clicked**, never
`.click()`-ed past focus, because the defect is about real focus. The origin is identified the same
way the fix's own tracker identifies it — a `focusin` listener that keeps the last element focused
*outside* any dialog — and then tagged with `data-e2e-origin` so identity is provable rather than
inferred. Success is delivered by releasing a held route, so no assertion depends on a real
mutation.

`activeElement` is read at **three** times: mid-mutation, ~120 ms after release (past the 0 ms
pass), and again 500 ms later (past the 250 ms pass) — the brief's ">300 ms" requirement.

### Results — 13 instances × 3 paths

The contract is **"not `<body>`, not `null`"**. "Lands on" is reported, not asserted.

| Dialog | family | (a) submit | lands on | (b) Escape | (b) Cancel | (c) 500 no-op |
|---|---|---|---|---|---|---|
| SpawnDialog | hand | **FAIL** | `<BODY>` | PASS | PASS | PASS |
| ScheduleDialog | hand | PASS | `<BUTTON>` — the same trigger | PASS | PASS | PASS |
| AdoptSessionDialog | hand | PASS | `<MAIN>` — `<main>` fallback | PASS | PASS | PASS |
| ImportSessionDialog | hand | PASS | `<MAIN>` — `<main>` fallback | PASS | PASS | PASS |
| DeleteRecordDialog | hand | **FAIL** | `<BODY>` | PASS | PASS | PASS |
| SessionActionDialog (Reopen) | hand | PASS | `<BUTTON>` — the same trigger | PASS | PASS | PASS |
| SessionActionDialog (Fork) | hand | **FAIL** | `<BODY>` | PASS | PASS | PASS |
| SessionActionDialog (Respawn) | hand | PASS | `<BUTTON>` — the same trigger | PASS | PASS | PASS |
| SessionMetadataEditDialog | hand | PASS | `<BUTTON>` — the same trigger | PASS | PASS | PASS |
| KillConfirmDialog | **Base UI** | PASS | `<BUTTON>` — the same trigger | PASS | PASS | PASS |
| ProjectDialog (create) | **Base UI** | PASS | `<BUTTON>` — the same trigger | PASS | PASS | PASS |
| ProjectDialog (edit) | **Base UI** | PASS | `<BUTTON>` — the same trigger | PASS | PASS | PASS |
| DeleteProjectDialog | **Base UI** | PASS | `<BUTTON>` — the same trigger | PASS | PASS | PASS |

**49 / 52.** All three failures are on path (a), and all three are dialogs whose `onSuccess`
navigates. Every Escape and every Cancel passed — **no regression on the paths that were already
safe**, which was the point of the negative control.

Two sub-assertions the brief called out, both across all 13:

- **Confirm-still-disabled.** On every landing, `activeElement.hasAttribute('disabled')` is
  **false**. Focus never stuck on the inert confirm — the `canTakeFocus` check the PR said was the
  difference between working and only looking like it working is doing its job.
- **`<main>` fallback.** Where the trigger genuinely unmounted but the page survived — Adopt and
  Import, whose trigger lives in a dropdown that closes — focus landed on `<MAIN>` with
  `tabindex="-1"` set exactly as designed. **The fallback mechanism is alive.** That matters for
  reading NF29 correctly: it is not that the fallback is broken, it is that it never gets to run.

### The 500 no-op control

All 13 pass: the dialog stayed open (`dialogCount === 1`, NF27 behaviour intact) and focus did
**not** jump to `<main>`. The audit is correctly gated on the dialog actually closing.

Worth recording, though, because it is the same accessibility gap from the other side: on all 13,
`activeElement` mid-failure is **`<BODY>`**. The dialog is open, a `role="alert"` has been raised,
and the operator's focus is on the document. That is out of the fix's stated contract (which is
about *closing*), and batch-14's own report predicted it. Recorded below, not filed as new.

### Screenshots

`nf28-schedule-focus-returned.png` — Schedule after a successful submit, focus ring on the trigger.
`nf29-deleterecord-focus-lost.png` — Delete Record after a successful submit: `activeElement =
<BODY>`, `<main>` `tabindex = null`, footer `v e4b513c2`.

---

## New findings

### NF29 — the three navigate-on-success dialogs still end on `<body>` · **LOW→MEDIUM**

**What is wrong.** Submit `SpawnDialog`, `DeleteRecordDialog` or `SessionActionDialog`'s **Fork**,
let it succeed, and `document.activeElement` is `<body>` — indefinitely. `<main>` never receives
`tabindex="-1"`, so the fallback the PR describes did not merely land somewhere unexpected; it never
ran.

**Severity is a judgement call and here is the reasoning.** The operator impact is identical to
NF28's (LOW): nothing unreachable, Escape and Tab unaffected. What lifts it is that these are
*navigations* — the operator has just been moved to a page they did not previously have focus on, so
"where am I" is a live question in a way it is not after an in-place save. A screen-reader user
lands on a new route with focus on the document and no announcement. I would fix it, but I would not
block on it.

**Why exactly these three, proven rather than inferred.** `useFocusReturn` schedules its two passes
as the `open→false` effect and returns the cancel **as that effect's cleanup**. When `onSuccess`
also navigates, the component that owns the dialog unmounts, React runs the cleanup, and the passes
are cancelled before they can land. `apps/web/app/session/[uuid]/page.tsx:150` is the clearest case:

```js
onSuccess: () => { setDeleteOpen(false); …; router.push('/dashboard') }
```

Both in one handler, so the close and the unmount are the same commit.

Instrumenting `window.setTimeout`/`clearTimeout` over the 0 ms and 250 ms delays separates the two
groups cleanly (`nf28-mechanism.json`):

| dialog | passes cleared before firing | final focus | `<main>` tabindex |
|---|---:|---|---|
| DeleteRecordDialog | **1** | `BODY` | `null` |
| SpawnDialog | **1** | `BODY` | `null` |
| SessionActionDialog (Fork) | **1** | `BODY` | `null` |
| SessionActionDialog (Reopen) | 0 | `BUTTON` | `null` |
| ScheduleDialog | 0 | `BUTTON` | `null` |

A `cleared` count of exactly 1 on exactly the three failures, and 0 on the controls, is the whole
story: the 0 ms pass fires while the old page is still up (so it is not marked cleared, and it
restores focus to a trigger that is about to vanish), and the 250 ms pass — the one that would have
seen a detached origin and fallen back to `<main>` — is cancelled by the unmount.

The focus timeline confirms it end to end (`nf28-timeline.json`):

```
DeleteRecord   mid-mutation BODY dlg=1 /session/…      +40ms BODY dlg=0 /dashboard  … +1000ms BODY
Schedule       mid-mutation BODY dlg=1 /schedules      +40ms BUTTON dlg=0 /schedules … +1000ms BUTTON
```

The control recovers inside 40 ms. The navigating one never does, across the route change.

**Fix shape (not applied — this is a resweep).** The audit needs to outlive the component that
scheduled it. Either schedule it somewhere that does not unmount with the dialog, or do not return
the cancel as the effect's cleanup — cancel only on *reopen*, which is the case the cancel was
actually written for. The `open→false` effect currently conflates "this dialog reopened" with "this
dialog went away", and only the first should cancel.

**Evidence:** `nf28-SpawnDialog.json`, `nf28-DeleteRecordDialog.json`,
`nf28-SessionActionDialog_Fork.json`, `nf28-mechanism.json`, `nf28-timeline.json`,
`nf29-deleterecord-focus-lost.png`.

### The PR's stated known-limit — **NOT REPRODUCED**

The PR warns that for a Base UI dialog whose trigger unmounts, floating-ui's late (~100 ms) restore
may beat the `<main>` fallback and land on a third element from its own history. Tested with a
**real** project delete (no mock, so the row genuinely went away):

| at | activeElement | `<main>` tabindex |
|---|---|---|
| +250 ms | `MAIN` | `-1` |
| +500 ms | `MAIN` | `-1` |
| +1000 ms | `MAIN` | `-1` |

Focus landed on `<main tabindex="-1">` and stayed there. The limit is real in principle — it depends
on floating-ui's module-level history happening to hold a still-connected element — but it did not
occur here. Reported as **not observed**, not as "cannot happen". `nf28-baseui-real-unmount.json`.

### Recorded, not filed

- **A failed mutation leaves focus on `<body>` while the dialog is open** (13/13, see Part A). The
  fix's contract is about closing, so this is not a regression and not a missed claim — but NF27
  made failures recoverable, and the operator's focus is still not on the error or the retry. It is
  the same gap NF28 closed for the success path, left open on the failure path.
- **`adopt/validate` is workspace-scoped, `POST /api/sessions/adopt` appears not to be.** The dialog
  refuses a transcript that is not under the selected project's workspace, while the adopt endpoint
  accepted the same pairing over curl. Cost this sweep one cycle. Not investigated further — out of
  scope, and it may be deliberate.

---

## Part B — NF25 / NF26 / NF27 regression

### NF25 — three dismissal vectors, guarded mid-mutation — **80/80**

Escape, backdrop and in-panel click, pre-submit and mid-mutation, plus hold-not-latch, on all ten
dialogs. Every dialog **8/8**, including the negative control that the `×`/backdrop *actually
closes* pre-submit — without which every "still open" assertion is satisfied by a dialog that never
closes.

| Dialog | checks | | Dialog | checks |
|---|---|---|---|---|
| SpawnDialog | 8/8 | | SessionMetadataEditDialog | 8/8 |
| ScheduleDialog | 8/8 | | ProjectDialog | 8/8 |
| AdoptSessionDialog | 8/8 | | DeleteProjectDialog | 8/8 |
| ImportSessionDialog | 8/8 | | KillConfirmDialog | 8/8 |
| DeleteRecordDialog | 8/8 | | SessionActionDialog | 8/8 |

Batch-15 touched all ten of these files, so this was re-run in full rather than assumed.

### NF26 — a `×` that refuses says so — **119/119**

| Dialog | checks | | Dialog | checks |
|---|---|---|---|---|
| SpawnDialog | 15/15 | | ProjectDialog | 15/15 |
| ScheduleDialog | 15/15 | | DeleteProjectDialog | 15/15 |
| AdoptSessionDialog | 15/15 | | KillConfirmDialog | 10/10 (in `kill-probes`) |
| ImportSessionDialog | 15/15 | | SessionActionDialog | 7/7 (renders no `×`) |
| DeleteRecordDialog | 15/15 | | SessionMetadataEditDialog | 7/7 (renders no `×`) |

The Chrome trap holds as batch-14 documented it: on the Base UI dialogs the element under the
pointer is `SPAN[data-slot="dialog-close-blocked"]` with `cursor: not-allowed` and the tooltip
`Please wait for the request to finish`, while the disabled button's own cursor computes `default`.
Eight dialogs have an `×`; two render none, same as batch-13 and batch-14 measured.

### NF27 — a failed mutation never looks like a success — **78/78 dialog + 17/17 toast**

| Surface | injected 500 | real API refusal | success | checks |
|---|---|---|---|---|
| Kill | stays open | `HTTP 404: Session not found: …00ff` | closes, really killed | 24/24 (with NF26) |
| Reopen | stays open | `HTTP 409: …` | closes | 13/13 |
| Fork | stays open | `HTTP 404: …` | closes | 13/13 |
| Respawn | stays open | `HTTP 409: …` | closes | 13/13 |
| Delete Record | stays open | `HTTP 404: …` | settles | 13/13 |
| Metadata Edit | stays open | `HTTP 404: …` | closes | 13/13 |
| **Archive** (toast) | red + `assertive` | **`HTTP 409: Cannot archive session in killed state`** | **0 toasts**, really `succeeded` | 10/10 |
| **dashboard row Kill** (toast) | red + `assertive` | — | **0 toasts**, really `killed` | 7/7 |

Every surface failed twice — an injected Fastify 500 envelope and a refusal the API itself authored
via retarget — so both body shapes (`message` on a 500, `error` on a route refusal) are exercised.

> Two harness traps re-confirmed the hard way this sweep. Archive's real-refusal retarget needs an
> actually-killed session id or the toast reads `Session not found: undefined` and the assertion
> fails for the probe's reasons, not the product's. And the dashboard row Kill needs a session that
> is **active right now** — with `idleTimeoutMs: 60000` a fixture adopted two minutes earlier is
> asleep and the button is simply absent.

---

## Part C — the 17-scenario smoke set

| Id | Result | Notes |
|---|---|---|
| `SPAWN-01` | **pass** | tmux spawn on `e2e-claude` **through the dialog**; navigated to `/session/57aaa32b…` (NF6 holds); `useTmux: true`; `model` and `effort` **both `undefined`** — the "nothing to inherit" assertion |
| `SPAWN-05` | **pass** | headless spawn on `e2e-headless` through the dialog; `useTmux: false`, `tmuxName: "headless-b0d7dcea"`; model pinned `claude-haiku-4-5` in the dialog |
| `LIFE-01` | **pass** | `idle` → `DELETE` → `killed` → Reopen → `idle`; tmux `orchestron-31787ccc` → `…-6fd605`. One internal retry, see below |
| `LIFE-06` | **pass** | sleep-on-idle at `idleTimeoutMs: 60000` — **35 sleeping** at census. Wake-on-send proven: `sleeping` → send → **`running`** → `idle` |
| `HEADLESS-01` | **pass** | two turns, one conversation: **6 entries, strict alternation, 0 orphans**; resume pair `Continue from where you left off.` / `No response requested.` both present |
| `HEADLESS-04` | **pass** | inquiry renders as a form; the two field labels match the two `pendingInquiry` fields verbatim (`Which environment?`, `Which region?`); **Send answer** present and **disabled while empty** |
| `META-01` | **pass** | pencil dialog; `claude-haiku-4-5` → `claude-opus-5` saved and **persisted**. Save disabled until the selection differed |
| `SCHED-01` | **pass** | created through the form (project `e2e-haiku`, cron `0 3 * * *`, `model: claude-haiku-4-5`) |
| `SCHED-09` | **pass** | *Run now* navigated to `/session/75739192…`; ran on the **pinned** `claude-haiku-4-5`; exactly one *Run now* on screen before clicking |
| `DASH-01` | **pass** | DOM card order vs API: **strictly descending** by `lastActivityAt`, **39/39** cards matched |
| `DETAIL-01` | **pass** | panel **collapsed by default** (0 `h3`); after expanding, four groups **in order** — IDENTITY / LOCATION / COMMANDS / TIMING; 4 `section.border-t`, 4 `first:border-0` |
| `PROJ-01` | **pass** | registered through the **ProjectDialog form**; API confirms `e2e-b15-mtx5oml9` → `25d99d5f…` |
| `METRICS-01` | **pass** | SESSIONS / TOKENS / COST tiles render, 15 svg nodes, per-project breakdown names a fixture project |
| `SET-05` | **pass** | `/api/readiness` **200 anonymous**; anti-stub control: reported `uptime` **2102** vs `ps -o etimes=` on MainPID **2102** — the real process clock |
| `CLI-01` | **pass** | `session spawn --headless` → `idle` → `session send` → `idle` → `session archive` → **`succeeded`** |
| `CLI-02` | **pass** | all 5 step-1 documents carry top-level `ok`, every exit 0 (`session list` 42 067 B, `project list` 1 984, `schedule list` 445, `metrics` 348, `doctor` 1 088) |
| `CLI-06` | **pass** | `session answer --choice "Yes"` on the live **Write** modal → `{"ok":true,"answered":"prompt","index":1,"option":"Yes"}`; file created, content `draft`, `pendingPrompt` null, status settled to `idle` |

> **LIFE-01, the same line worth reading twice as last sweep.** The reopen logged
> `[session-manager] tmux pane died during reopen for 8eee46ff…, retrying (attempt 2/2)` and the
> retry succeeded, which is why the final tmux suffix (`-6fd605`) differs from the one the reopen
> response returned (`-be3643`). Every assertion holds, so it is a **pass** — but this is the known
> TUI-ready fragility surfacing again, absorbed by the built-in retry. Second sweep running. Still
> worth watching rather than filing, though "twice in two sweeps" is no longer obviously noise.

---

## Part D — carried regressions, batches 3 → 14

| item | verdict | evidence |
|---|---|---|
| **NF4 / Phantom** parser + normaliser | **HOLDS** | HEADLESS-01: 6 entries, strict alternation, **0 orphans** |
| **NF6** spawn navigates | **HOLDS** | SPAWN-01 and SCHED-09 both landed on `/session/<id>` |
| **NF13** `/api/readiness` | **HOLDS** | 200 anonymous; `uptime` 2102 vs `etimes` 2102 on the real MainPID |
| **NF14 / NF16** idle chip from `idleTimeoutMs`, ticking | **HOLDS** | one page opened once, **0 reloads**, 140 s: `idle 1m → 2m → 3m → 4m`; tooltip reads `Idle since 11:17:59 PM. Auto-sleeps at 1 min.` — the configured 60 s, not a hardcoded 15 min |
| **NF17** enforcement does not manufacture an inquiry | **HOLDS** | HEADLESS-01 turn 1 landed `idle`; **0** `StructuredOutput`, **0** `structured-output-enforce` in the rendered transcript |
| **NF19** inquiry intent | **HOLDS** | official inquiry prompt → `needs_input` with structured `pendingInquiry` (message + **2 fields**, both `text`) |
| **NF20** Bash modal | **HOLDS** | `touch` probe → `kind: "permission"`, title `Bash command`, 3 options, option 2 **78 chars** ending `…m this project`, **0** dashed box-drawing runs |
| **NF21** Escape closes every dialog | **HOLDS — 10/10** | subsumed by the NF25 negative controls, and independently by NF28's Escape column (13/13) |
| **NF22** Write modal detected | **HOLDS** | live `Write` modal → `kind: "permission"`, title `Create file`, detail `nf22-b15.txt\n1 draft`, option 2 **111 chars ending `(shift+tab)`** — byte-for-byte the batch-12/13/14 shape |
| **NF23** `doctor --json` envelope | **HOLDS, both directions** | happy: `{ok:true}`, keys exactly `['checks','ok']`, 9 checks, exit 0. Failing (PATH reduced to a lone `node` symlink): `ok:false`, **exit 1**, `error` = `3 critical check(s) failed: tmux, git, claude`, all 9 checks present, **`node` still `pass`** |
| **NF24** Session Action stays open | **HOLDS — all three actions** | Reopen / Fork / Respawn each 13/13 under NF27 |
| **NF25** three dismissal vectors | **HOLDS — 80/80** | Part B |
| **NF26** the `×` refuses legibly | **HOLDS — 119/119** | Part B |
| **NF27** a failure never looks like a success | **HOLDS — 95/95** | Part B |
| **NEW-1** EPIPE | **HOLDS** | `session list --json \| head -c 300` → exit **0**, stderr **0 B** |
| **NEW-3** phantom `projectId` | **HOLDS — all three readings** | `PATCH /api/sessions/<phantom>` → **404**; `PATCH <real>` body `{projectId: phantom}` → **200**, key stripped by zod, `projectId` unchanged; `POST /api/sessions` body `{projectId: phantom}` → **404** `Project not found` |

---

## Cost

`GET /api/metrics`, read **before** any cleanup:

```
sessions: 27        tokens: 864 491        cost_usd: $0.37868115
```

**Adopted-transcript contamination is essentially gone this run: $0.00022, 0.06%** (batch-14:
$0.11781, 26.5%). The fixtures were adopted from **504-byte transcripts** rather than whatever was
newest — twelve sessions that never ran a turn price out at twenty-two hundredths of a cent between
them. The baseline was a verified `$0`, so **the whole $0.37868 is this sweep's own spend** and needs
no subtraction. Recommend keeping this as the fixture rule; it makes the cost line mean something.

**The dominant cost is still structural and still SPAWN-01.**

| | batch-14 | batch-15 | |
|---|---:|---:|---|
| SPAWN-01 | 0.19171 (43.1%) | **0.19191 (50.7%)** | *not* pinnable — the assertion **is** `model`/`effort` absence |
| SPAWN-05 | 0.01967 | 0.01633 | pinned haiku in the dialog, every assertion intact |
| headline | 0.44522 | **0.37868** | −15%, all of it the removed adopt contamination |

SPAWN-01 is now **half the sweep** because everything around it got cheaper. The scenario-design
question batch-13 and batch-14 both raised is unchanged and still belongs to whoever owns
`00-setup.md` §4: assert model/effort absence on a record that never completes a turn, or accept
~$0.19 a sweep and say so. I have not changed the scenario — a resweep is the wrong place to move
the thing being measured.

**My own waste, named rather than rounded:**

- **One fixture project deleted by accident.** The Base UI real-unmount probe targeted
  `button[title="Delete"]` with `.last()` and removed **`e2e-claude-opus`** instead of the throwaway
  it created. Caught immediately (the probe asserts the intended project still exists, and it did),
  and the fixture was recreated with its `claude-opus-5` / `high` defaults before META-01 ran. **$0**
  — the project held no sessions. The probe should have scoped to its own row; that is a probe bug
  and it is fixed in the committed copy only insofar as it is documented here.
- **Four probe-side false failures** costing cycles, not money: the adopt UUID pool was filtered on
  `harnessSessionId` when the record field is **`claudeSessionUuid`**, so the "unadopted" list was
  empty and three probes tried to re-adopt live transcripts; and `smoke-ui`'s DETAIL-01 sub-check
  missed the expand toggle, which the dedicated `detail01.mjs` then passed cleanly. All **$0**.
- **Adopt/validate workspace scoping** cost one cycle before the Adopt probe was pointed at
  `e2e-headless` instead of `e2e-haiku`. **$0**.

---

## Traps confirmed still live

- **`e2e-env.sh build` does not rebuild what it thinks is current.** Fourth sweep running. Check
  `BUILD_ID` against source mtime *and* process start against dist mtime, every time.
- **The session record's field is `claudeSessionUuid`, not `harnessSessionId`.** The adopt *request*
  takes `harnessSessionId`; the record does not carry it back under that name. A set-difference over
  the wrong key silently yields "everything is free", and the failure surfaces three probes later as
  `already adopted`.
- **`adopt/validate` is workspace-scoped.** The dialog will not enable Adopt for a transcript that is
  not under the selected project's workspace, however valid the UUID.
- **Archive goes through `window.confirm()`** — Playwright auto-dismisses it, so without
  `page.on('dialog', d => d.accept())` the mutation never fires.
- **Fork POSTs to `/clone`**, not `/fork`. A route glob on `/fork` never arms and a real fork runs.
- **The Kill button exists only on an `active` session** and this env sleeps at 60 s. Adopt fresh
  immediately before any Kill probe.
- **`apps/cli/bin/orchestron` loads `dist/`.** Not re-tripped (no CLI change in batch 15), but the
  dist timestamps were checked against the diff rather than assumed.
- **`text-transform` beats a regex over source text** — HEADLESS-04's header renders
  `AGENT NEEDS INPUT`. Match case-insensitively.
- **`/api/projects` returns `{projects: […]}`**, not a bare array.

---

## §10 sweep coordination

```
BASE_SHA  e4b513c27450b9a867266fa968645837d8d352aa   22:30, before the first scenario
END_SHA   e4b513c27450b9a867266fa968645837d8d352aa   23:34, after the last measurement
```

**No drift.** `git status --porcelain` was empty at both reads. Unlike the last two sweeps, nothing
wrote to the shared checkout mid-run. The standing mitigation — run a sweep from its own worktree —
remains worth doing; it was simply not needed this time.
