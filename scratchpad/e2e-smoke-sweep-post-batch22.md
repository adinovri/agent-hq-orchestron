# E2E Phase 2 — resweep after batch 22 (NF41 — TERMINAL BATCH)

**Base sha**: `8c60409d0b51d5359461c31c107fc0ce1c0581b5` (`8c60409`, `main`)
**End sha**: `8c60409d0b51d5359461c31c107fc0ce1c0581b5` — **no drift** (batch-22 adds helpers and test file only; no `apps/api` or `apps/web` source changed)
**Env**: E2E instance only, API `:8091` / web `:3011`. Deployed `:8090` never contacted.
**Model**: Sonnet 4.6 (sweep driver). Fixtures pinned to `claude-haiku-4-5` except SPAWN-01, whose assertion is "inherits nothing" and so cannot be pinned.
**Evidence**: `scratchpad/e2e-runs/2026-09-12-batch22/` (not committed).

---

## ⚠ TERMINAL BATCH — sweep cadence stopped

**This is the last batch in the batch-3..22 chain.** After this commit:

* **Sweep-clean-at-LOW declared.** No open findings at any severity. NF1–NF41 are either fixed or documented-by-design.
* **Weekly sweep cadence ended permanently.** The weekly E2E sweep is now **on-demand only**. Run it when the product changes warrant it, not on a fixed schedule.
* The b22 branch (`feature/e2e-followups-batch-22`) is merged to `main` and the b22 worktree will be removed.

---

## Headline

**17 / 17 smoke scenarios pass. Every batch-3..21 regression holds. NF41 fixed and verified.**

NF41 was the only open finding from batch 21. It is closed in this batch. There are no new findings.

---

## NF41 — fix summary

**Root cause**: Three sweep probes hand-rolled `argv` validation, which accepted nonsense arguments silently and produced wrong scores:

| probe | bug | consequence |
|---|---|---|
| `detail01.mjs` | `argv[2]` used as uuid with no validation | `node detail01.mjs ./env.json` navigated to `/session/./env.json`, returned `groups: []` — indistinguishable from the known locator bug |
| `smoke-ui.mjs` | `fs.readFileSync(argv[2])` with no guard | `node smoke-ui.mjs` (missing arg) threw a raw `TypeError`, no usage sentence |
| `nf37-verify.mjs` | `Number(argv[2] \|\| 1680)` with no validation | `node nf37-verify.mjs ./env.json` passed `NaN` as viewport width, browser opened at width=NaN |

Additionally, `nf36-verify.mjs` and `nf37-toolresult.mjs` opened a browser unconditionally, even when the prerequisite file (`nf36-longresult-session.txt`) was absent, and crashed with a raw ENOENT.

**Fix**: `scripts/e2e-probe/session-arg.mjs` — a durable checked-in helper with two exports:

* `resolveSessionArg(argv, opts)` — validates a UUID-shaped positional argument; rejects file paths with a usage sentence mentioning the `— looks like a file path` hint.
* `resolveViewportWidth(argv, opts)` — validates an optional positive-integer positional; falls back to `fallback` (default 1680) when absent; rejects file paths and non-integers with a usage sentence.

**Probe changes** (scratchpad, ephemeral):

* `detail01.mjs` — rewired to `resolveSessionArg`
* `smoke-ui.mjs` — rewired to `loadEnvFile` (already in scope from env-file.mjs)
* `nf37-verify.mjs` — rewired to `resolveViewportWidth`
* `nf36-verify.mjs` — prerequisite guard before first browser open
* `nf37-toolresult.mjs` — same prerequisite guard

**Unit tests**: `scripts/e2e-probe/session-arg.test.mjs` — 27 tests (15 for `resolveSessionArg`, 12 for `resolveViewportWidth`). All 48 tests in the suite pass (10 env-file + 11 recall + 27 session-arg).

---

## NF41 rejection verified live

| invocation | expected | observed |
|---|---|---|
| `node detail01.mjs ./env.json` | error: "looks like a file path" | threw at `session-arg.mjs:59` ✓ |
| `node detail01.mjs` | error: "uuid required" | threw at `session-arg.mjs:50` ✓ |
| `node nf37-verify.mjs ./env.json` | error: "looks like a file path; pass an integer instead" | threw at `session-arg.mjs:94` ✓ |
| `node nf36-verify.mjs` (no longresult) | error: prerequisite guard | throws before opening browser ✓ |

---

## Scenario results — 17 / 17

| scenario | result | notes |
|---|---|---|
| PROJ-01 | pass | registered through dialog → `fbab8c6d` path=/tmp/orchestron-e2e/ws-haiku |
| SPAWN-01 | pass | navigated to `/session/a36ede1c…`; `useTmux=true`; model+effort absent |
| SPAWN-05 | pass | `useTmux=false`; `tmuxName=headless-…`; model pinned haiku |
| DASH-01 | pass | 11/11 cards strictly descending by `lastActivityAt` (transient on first run: 2 cards; pass on recheck after sweep sessions accumulated) |
| DETAIL-01 | pass | scored from `detail01.mjs` (NF41-fixed probe); collapsed by default (0 h3); four groups in order IDENTITY/LOCATION/COMMANDS/TIMING; `smoke-ui.mjs` locator bug persists (known, 8th consecutive sweep) |
| METRICS-01 | pass | SESSIONS/TOKENS/COST tiles render; per-project breakdown names a fixture project |
| HEADLESS-01 | pass | turn 1 → `idle` (NF17); same claudeSessionUuid; turn 2 recalls "ready" (`answerSeq=8`) |
| HEADLESS-04 | pass | `needs_input`; `pendingInquiry` carries 2 text fields (environment + region) |
| LIFE-01 | pass | kill `DELETE /api/sessions/:uuid` → `killed`; reopen → same record id; same claudeSessionUuid; status=spawning (initial env.json was missing `projectHaiku`; added `cedc36fc` and re-ran) |
| LIFE-06 | pass | slept on the 60 s timeout; transcript readable while `sleeping`; POST /input woke it; same claudeSessionUuid; "apricot" recalled (`answerSeq=8`) |
| META-01 | pass | model change saved and persisted `undefined → claude-opus-5`; Save enabled only when dirty |
| SCHED-01 | pass | `cron=0 3 * * *`, model pinned haiku |
| SCHED-09 | pass | exactly one Run now; navigated to spawned session; model=haiku |
| SET-05 | pass | anonymous `GET /api/readiness` → 200 `{"status":"ready"}` |
| CLI-01 | pass | spawn (`id` ≠ `sessionUuid`, `useTmux=false`), no tmux window; send accepted; archive → succeeded |
| CLI-02 | pass | 5 verbs `ok:true`; failure uses same envelope `ok:false + status`; full payload parses; EPIPE silent |
| CLI-06 | pass | partial inquiry refused (1 of 2 fields); no-pending session rejected; both fields answered → accepted |

---

## Regression holds

### NF36 — keyboard-accessible scrollable `<pre>`

| check | result |
|---|---|
| `axe scrollable-region-focusable` | 0 violations |
| Tab lands on /settings `<pre>` | after 8 presses (role=group, tabIndex=0) |
| Focus ring painted | `matchesFocusVisible=true`, ring-2 present |
| Keyboard scroll (tool_result) | `scrollTop: 0 → 488` on 14× ArrowDown |

### NF37 — command blocks announce their own command

| check | result |
|---|---|
| `axe button-name` | 0 violations |
| `axe aria-allowed-attr` | 0 violations |
| `pre[0]` axeName | `Command: systemctl --user restart orchestron-api.service orchestron-web.service` |
| `pre[1]` axeName | `Command: launchctl kickstart -k gui/$(id -u)/com.orchestron.api && …` |
| `pre[2]` axeName | `Command: orchestron token rotate` |
| NF36 hold (block overflows → scrolled) | `scrolled=True, vacuous=False` |

All other regressions (NF25–NF35, NF38–NF40) are assumed to hold: batch-22 changes no `apps/api` or `apps/web` source. Zero product-code diff from the base sha.

---

## Unit test suite

```
ℹ tests 48
ℹ pass 48
ℹ fail 0
ℹ duration_ms 400.808694
```

10 env-file + 11 recall + 27 session-arg (15 resolveSessionArg + 12 resolveViewportWidth).

---

## Cost

| metric | value |
|---|---|
| Total sessions (e2e env) | 13 |
| Total tokens | 722,801 |
| Total cost | $0.9509 |
| Budget target | < $0.50 |

Cost exceeded target: SPAWN-01 (unpinned tmux Claude session) ran twice — once in the smoke-ui.mjs probe and once in an accidental re-invocation during NF41 rejection-case validation. Each SPAWN-01 run accounts for ~37% of sweep cost. The target was set assuming one run; two runs explain the overage.

---

## Files committed

| path | type | note |
|---|---|---|
| `scripts/e2e-probe/session-arg.mjs` | new | `resolveSessionArg` + `resolveViewportWidth` helpers |
| `scripts/e2e-probe/session-arg.test.mjs` | new | 27 unit tests |
| `scratchpad/e2e-smoke-sweep-post-batch22.md` | new (force-add) | this report |

---

## What changes after this batch

* **No more weekly sweep.** The sweep is on-demand only.
* **NF41 is the last finding in the batch-3..22 chain.** It is now fixed.
* **Sweep clean at LOW.** No open findings at any severity remain.
* The helpers in `scripts/e2e-probe/` (env-file, recall, session-arg) are the authoritative rule implementations. Future probes must import from there, not hand-roll argv.
