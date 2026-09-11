# E2E Test Plan — Orchestron

Human-readable, LLM-executable end-to-end scenarios for every shipped
orchestron feature. Nothing here runs itself yet; each file is a script
a person (or an agent driving a browser) can follow top to bottom.

**Run them against the isolated environment, not the deployed one** —
these scenarios kill sessions, delete records and flip config flags:

```bash
./scripts/e2e-env.sh build && ./scripts/e2e-env.sh up && ./scripts/e2e-env.sh fixtures
. ~/.orchestron-e2e/e2e.env      # $ORCH, $ORCH_WEB, $TOKEN, fixture ids
# dashboard: http://127.0.0.1:3011
```

[`00-setup.md`](00-setup.md) § 8 has the layout and, more usefully, what
is *not* isolated. [`scripts/README.md`](../../scripts/README.md) has
the command reference.

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

**Looking one up.** `./scripts/e2e-scenario.sh SPAWN-05` prints a single
scenario next to the current run's `$ORCH`, `$TOKEN` and fixture ids;
`list` / `list --smoke` enumerate the ids.

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
| [`metadata-edit.md`](metadata-edit.md) | Pencil dialog — model / effort / *Use tmux*, and the mode+state gates on each |
| [`schedule.md`](schedule.md) | Cron schedules, pinned model/effort/mode, Run now redirect, project read-only on edit, YAML export/import |
| [`feature-flag.md`](feature-flag.md) | `enableHeadlessMode: false` — hidden toggles, coercion, toast, badge masking |
| [`mcp-spawn.md`](mcp-spawn.md) | `spawn_session` from a running agent, mode inheritance, delegation graph, guardrails |
| [`session-details.md`](session-details.md) | Collapsed details panel — four groups, skip rules, copy buttons |
| [`dashboard-ui.md`](dashboard-ui.md) | Cards, ordering, filter bar, project grouping, delegation chips, status pills |
| [`projects.md`](projects.md) | Project registry — register, edit defaults, delete, filters, per-harness config |
| [`metrics.md`](metrics.md) | Cost page — tiles, dedup, per-event pricing, empty states, the five `groupBy` axes |
| [`graph.md`](graph.md) | Delegation graph — nodes, edges, click-through, empty roots, narrow viewport, live theme |
| [`settings.md`](settings.md) | Settings — theme, server info, the two health endpoints, log level, adapter matrix |
| [`pairing.md`](pairing.md) | `/pair` — token sink, no-token state, unverified tokens, PWA install prompt |
| [`reset.md`](reset.md) | `/reset` and `/api/reset` — client-only wipe, blast radius, the two origins |
| [`diagnostics.md`](diagnostics.md) | `/session-diag/<uuid>` — the minimal SSE transcript dump |
| [`cli.md`](cli.md) | `orchestron` the binary — session mutations, schedule CRUD, metrics, adopt/import/export, the `--json` envelope |

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

The short pre-deploy sweep — 17 scenarios, roughly 30 minutes by hand.

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
| `SCHED-09` | Run now navigates to the session it spawned |
| `DASH-01` | Dashboard lists sessions newest-activity first |
| `DETAIL-01` | Details panel shows four groups |
| `PROJ-01` | Register a project through the form |
| `METRICS-01` | Summary tiles and the range they describe |
| `SET-05` | `/api/readiness` answers the anonymous probe |
| `CLI-01` | Spawn headless, send a turn, archive — all from the shell |
| `CLI-02` | Every command speaks one `--json` envelope |
| `CLI-06` | `session answer` picks index vs text off the record |

All seventeen run with `enableHeadlessMode` **on** — its default — so
the sweep needs no config change and no API restart.

The three `CLI-*` entries run in a shell rather than a browser, which
makes them the cheapest part of the sweep and the only part an agent
can execute today without driving Chrome. `CLI-02` in particular is the
contract the TUI and the Phase 3 executor are written against: if the
`--json` envelope stops parsing, every automated caller breaks at once
and no browser scenario would notice.

`SET-05` earns its place despite being a single `curl`: the route it
covers did not exist at all until batch 8, whitelisted and documented
the whole time, and a load balancer pointed at it would have marked the
API permanently unhealthy. It is also the cheapest possible check that
a deploy actually restarted the process — `uptime` resets.

**The flag-off pair, run separately.** `FLAG-02` (every *Use tmux*
control is hidden) and `FLAG-03` (a headless request is coerced, and
says so) are also marked `[smoke]` but are deliberately **not** in the
table above: they require `enableHeadlessMode: false` and an API
restart, which invalidates the preconditions of every other scenario
here. Run them as their own short sweep when a release touches the
masking path, following [`feature-flag.md`](feature-flag.md) from its
preconditions through `FLAG-08` — which restores the switch. Do not
interleave them with the main sweep.

**The five client-side `[smoke]` scenarios, also outside the table.**
Each area added in batch 6 carries one `[smoke]` scenario, but only
`PROJ-01` and `METRICS-01` earned a place in the pre-deploy table — the
other five are cheap, client-side and not on the path a deploy breaks:

| Id | Scenario | Why not in the table |
|---|---|---|
| `GRAPH-01` | Parent and children render with status colours | needs an `MCP-02` tree already in place |
| `SET-01` | Theme select, and where it persists | browser-local; no server state |
| `DIAG-01` | The diag pane opens the stream and renders raw events | developer tool, unlinked route |
| `PAIR-01` | A pairing link stores the token and lands on the dashboard | needs a clean browser profile |
| `RESET-01` | `/reset` wipes client state on load | **destroys the runner's own token** |

Run all seven after a change to the pages they cover. `RESET-01` wants a
scratch browser profile — see [`reset.md`](reset.md) preconditions.

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
