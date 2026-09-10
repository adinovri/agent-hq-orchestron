# E2E Test Plan — Orchestron

Human-readable, LLM-executable end-to-end scenarios for every shipped
orchestron feature. **Phase 1 = documentation only.** Nothing here runs
itself yet; each file is a script a person (or an agent driving a
browser) can follow top to bottom.

The plan is the **spec baseline**. When a feature PR changes a UI or API
contract, the matching scenario file is updated in the same PR. A
scenario that no longer matches the app is a bug in one of the two —
decide which, then fix that one.

---

## How to use this

**Manually.** Open [`00-setup.md`](00-setup.md), get the fixtures in
place, then work through whichever file covers the area you touched.
Each scenario is self-contained: it states what must be true before it
starts and how to put the world back afterwards.

**As a regression sweep before a deploy.** Run the *Smoke set* below —
roughly 20 minutes, covers the paths that break most often.

**With an agent (Phase 3, not built yet).** The steps are imperative and
the assertions are observable, so an LLM with a browser can execute a
file and report per-scenario pass/fail. The 📷 cues mark where a
screenshot is worth capturing for a human to review or for a
screenshot-diff assertion.

---

## Files

Read [`00-setup.md`](00-setup.md) first. The rest are independent.

| File | Covers |
|---|---|
| [`00-setup.md`](00-setup.md) | Global preconditions, fixture projects, token, cleanup helpers |
| [`spawn-session.md`](spawn-session.md) | Spawn dialog — project info panel, model/effort override, *Use tmux*, attachments, templates |
| [`session-lifecycle.md`](session-lifecycle.md) | Reopen / Fork / Respawn (with mode toggle), Archive, Kill, sleep + wake, Delete record |
| [`headless-flow.md`](headless-flow.md) | Headless multi-turn, interrupt, input gating mid-turn, structured `inquiry` form, symbolic sleeping |
| [`adopt-import.md`](adopt-import.md) | Adopt an outside session (5 validation layers), Import bundle, where *Use tmux* comes from |
| [`export-import.md`](export-import.md) | Bundle export formats, cross-host round-trip, UUID collision regeneration |
| [`metadata-edit.md`](metadata-edit.md) | Pencil dialog — model / effort / *Use tmux*, and the state gates on each |
| [`schedule.md`](schedule.md) | Cron schedules, pinned model/effort/mode, project read-only on edit, YAML export/import |
| [`feature-flag.md`](feature-flag.md) | `enableHeadlessMode: false` — hidden toggles, coercion, toast, badge masking |
| [`mcp-spawn.md`](mcp-spawn.md) | `spawn_session` from a running agent, mode inheritance, delegation graph, guardrails |
| [`session-details.md`](session-details.md) | Collapsed details panel — four groups, skip rules, copy buttons |
| [`dashboard-ui.md`](dashboard-ui.md) | Cards, ordering, filter bar, project grouping, delegation chips, status pills |

---

## Conventions

**Scenario IDs.** Every scenario has a stable id — `SPAWN-03`,
`HEADLESS-05`. Report results against these ids; never renumber an
existing one. Retire a scenario by marking it `(retired)` rather than
reusing its number.

**Section shape.** Each scenario is the same five blocks, always in this
order:

- **Covers** — one line saying what would break if this regressed.
- **Steps** — numbered and imperative. Every step is one user action.
- **Expect** — bulleted, observable assertions. UI-visible wherever
  possible; an API or on-disk check appears only where the UI cannot
  show the thing being tested.
- **📷 Screenshot** — a filename plus what must be in frame. Optional;
  present where a visual is the clearest evidence.
- **Cleanup** — how to get back to the state the next scenario assumes.

**Priority markers.** `[smoke]` marks the scenarios in the smoke set.
Everything else is a full-sweep scenario.

**What is out of scope here.** These are user-flow tests. Data
correctness, transition legality, path resolution, schema validation and
similar are covered by the unit suites (`apps/api`, `apps/web`,
`packages/*`) and are not re-asserted scenario by scenario. Where a
scenario does reach into the API or the filesystem, it is because the
behaviour has no UI surface — the coerce field, the 400 on a locked
mode edit, the transcript written by a headless turn.

**Spec authority.** Behaviour statements live in
[`../USAGE.md`](../USAGE.md); scenarios link to the relevant section
rather than restating it. If the two disagree, USAGE.md is the intent
and the scenario is stale — unless the app agrees with the scenario, in
which case USAGE.md is stale.

---

## Smoke set

The short pre-deploy sweep. Roughly 20 minutes by hand.

| Id | Scenario |
|---|---|
| `SPAWN-01` | Spawn a tmux session with project defaults |
| `SPAWN-05` | Spawn headless |
| `LIFE-01` | Reopen a killed session |
| `LIFE-06` | Sleep, then wake on send |
| `HEADLESS-01` | Two headless turns against one conversation |
| `HEADLESS-04` | Structured inquiry renders as a form |
| `META-01` | Pencil edits model on a terminal session |
| `SCHED-01` | Create a schedule, run it once |
| `DASH-01` | Dashboard lists sessions newest-activity first |
| `DETAIL-01` | Details panel shows four groups |

---

## Reporting a run

One row per scenario attempted. Keep it next to the run's screenshots.

```markdown
# E2E run — <date> — <branch/commit>

Environment: <host, port, config dir>
Scope: <smoke | full | file name>

| Id | Result | Notes |
|---|---|---|
| SPAWN-01 | pass | |
| SPAWN-02 | fail | model chip read `claude-sonnet-5`, expected `claude-opus-5` |
| SPAWN-03 | skip | no codex project on this host |

Failures: <one paragraph each — what was expected, what happened,
which screenshot shows it>
```

`skip` is a legitimate result and needs a reason. A scenario that could
not run is not a scenario that passed.

---

## Roadmap

Phase 1 is this directory. The rest is designed but not built:

- **Phase 2** — isolated test environment (`~/.orchestron-e2e/`, its own
  port and bearer token, a dedicated `CLAUDE_CONFIG_DIR`) so a run never
  touches real sessions. See the *Isolation* section of
  [`00-setup.md`](00-setup.md) for what the scenarios already assume.
- **Phase 3** — an agent that reads these files, drives the PWA, and
  reports pass/fail with screenshots.
- **Phase 4** — post-merge trigger, so a regression is caught by the
  merge rather than by the next person to open the dashboard.
