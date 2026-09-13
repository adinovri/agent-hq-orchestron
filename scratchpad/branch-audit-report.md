# Remote Branch Audit — 2026-09-13

**Repo:** agent-hq-orchestron  
**Main HEAD:** 85295e4  
**Audit date:** 2026-09-13  
**Total remote branches (excl. main):** 48

## Summary

| Category | Count |
|---|---|
| **Safe remove** (merged to main) | 41 |
| **Safe remove** (rebased/squashed into main — subject found in main log) | 7 |
| **Keep** (main itself) | 1 |
| **Uncertain / real unmerged work** | 0 |

**Total safe-remove candidates: 48** — all non-main remote branches can be deleted.

---

## All Branches

| Branch | Last Commit Date | Last Commit Subject | Status | Action |
|---|---|---|---|---|
| feature/api-settings-metadata | 2026-09-13 | feat(api): add GET /api/settings endpoint | merged | safe-remove |
| feature/cli-expansion-b | 2026-09-13 | feat(cli): watch + batch commands — CLI Opsi B expansion | merged | safe-remove |
| feature/cli-m2-repl | 2026-09-13 | feat(cli): add interactive REPL shell (CLI M2) | merged | safe-remove |
| feature/cli-new-1-4 | 2026-09-12 | fix(cli): doctor now checks config, token, and API reachability (NEW-4) | merged | safe-remove |
| feature/cli-parity-fixes | 2026-09-11 | test(cli): stop shelling out through npx for every spawn | merged | safe-remove |
| feature/docs-beginner-quickstart | 2026-09-13 | docs(USAGE): add Section 0 — beginner quickstart (5 min to first session) | merged | safe-remove |
| feature/docs-cli-tui-update | 2026-09-13 | docs(USAGE): update section 10 — CLI watch/batch/repl + TUI M1-M3 full walkthrough | merged | safe-remove |
| feature/e2e-batch-6-gap-fill | 2026-09-11 | docs(e2e): correct four batch-6 scenarios against what the run observed | merged | safe-remove |
| feature/e2e-followups-batch-1 | 2026-09-10 | docs: the real dashboard sort key, and the two rules that just changed | merged | safe-remove |
| feature/e2e-followups-batch-10 | 2026-09-11 | docs(e2e): only /pair sinks the token, and pin the sweep base sha | merged | safe-remove |
| feature/e2e-followups-batch-11 | 2026-09-11 | docs(cli): adopt/validate takes no effort, and name the payload that can truncate | merged | safe-remove |
| feature/e2e-followups-batch-12 | 2026-09-11 | fix(web): Session Action dialog stays open while its mutation runs (NF24) | merged | safe-remove |
| feature/e2e-followups-batch-13 | 2026-09-11 | fix(web): backdrop and × wait for the mutation, like Escape already did (NF25) | merged | safe-remove |
| feature/e2e-followups-batch-14 | 2026-09-11 | fix(web): a failed Kill stops looking exactly like a successful one (NF27) | merged | safe-remove |
| feature/e2e-followups-batch-15 | 2026-09-11 | fix(web): submitting a dialog no longer drops focus on the floor (NF28) | merged | safe-remove |
| feature/e2e-followups-batch-16 | 2026-09-12 | fix(web): a focus return now survives the navigation that caused it (NF29) | merged | safe-remove |
| feature/e2e-followups-batch-17 | 2026-09-12 | fix(web,e2e): announce dialog failures, and stop up() lying about the bundle | merged | safe-remove |
| feature/e2e-followups-batch-18 | 2026-09-12 | fix(web): name every select, align Kill's error box, prefix Import's status | merged | safe-remove |
| feature/e2e-followups-batch-19 | 2026-09-12 | fix(web): name the date inputs, let the keyboard into the scrollers | merged | safe-remove |
| feature/e2e-followups-batch-2 | 2026-09-10 | fix(web): write the inquiry key separator as an escape, not a raw NUL | merged | safe-remove |
| feature/e2e-followups-batch-20 | 2026-09-12 | fix(web): derive the command names, replace the remembered axe baseline | merged | safe-remove |
| feature/e2e-followups-batch-3 | 2026-09-11 | fix(web): give the two session dialogs an explicit dialog role | merged | safe-remove |
| feature/e2e-followups-batch-4 | 2026-09-11 | feat(web): render the resume exchange as an aside, not as two turns | merged | safe-remove |
| feature/e2e-followups-batch-5 | 2026-09-11 | docs(e2e): say that the cost ranges were measured against a broken endpoint | merged | safe-remove |
| feature/e2e-followups-batch-7 | 2026-09-11 | docs(e2e): NF5 revision four — the record over-counts, not the endpoint | merged | safe-remove |
| feature/e2e-followups-batch-8 | 2026-09-11 | docs(e2e): scenarios for the two fixes, and un-stale the token-rotate note | merged | safe-remove |
| feature/e2e-gap-fill | 2026-09-10 | docs(e2e): unstale the Reopen/Fork pointer, and reconcile the smoke set | merged | safe-remove |
| feature/e2e-phase2-isolation | 2026-09-10 | docs: the isolated E2E environment, and what it does not isolate | merged | safe-remove |
| feature/e2e-test-plan | 2026-09-10 | docs: an E2E test plan for every shipped feature | rebased-into-main | safe-remove |
| feature/headless-adopt-import-mcp-toggle | 2026-09-10 | docs: where the Adopt and Import checkboxes start, and why | merged | safe-remove |
| feature/headless-block-mode-edit-at-idle | 2026-09-10 | docs: the pencil edits the mode only from a state that spawns | merged | safe-remove |
| feature/headless-mode-flag | 2026-09-10 | fix(web): keep shared runtime values out of the client bundle | merged | safe-remove |
| feature/headless-mode-phase1 | 2026-09-09 | test: headless adapters, lifecycle, route cascade, transcript formats | merged | safe-remove |
| feature/headless-phase2 | 2026-09-10 | docs: PR notes for Phase 2 | merged | safe-remove |
| feature/headless-structured-output-ux-fix | 2026-09-10 | docs: headless structured output is invisible to the reader | merged | safe-remove |
| feature/headless-symbolic-sleeping | 2026-09-10 | docs: headless sleeps now, symbolically | rebased-into-main | safe-remove |
| feature/schedule-dialog-match-spawn | 2026-09-10 | test(web): cover the project info panel and its shared defaults | merged | safe-remove |
| feature/schedule-model-effort-tmux | 2026-09-10 | docs: a schedule can pin model, effort and run mode | merged | safe-remove |
| feature/schedule-run-redirect | 2026-09-10 | docs: say where Run now leaves you, and what the run endpoint answers | merged | safe-remove |
| feature/session-details-copy-inline | 2026-09-10 | fix(web): put the copy button next to the value, not at the panel edge | rebased-into-main | safe-remove |
| feature/session-details-polish | 2026-09-10 | test(web): cover the mode gate for both harnesses and the resolver itself | rebased-into-main | safe-remove |
| feature/session-details-redesign | 2026-09-10 | test(web): cover the details grouping, and give apps/web a test runner | merged | safe-remove |
| feature/tui-m1-start | 2026-09-12 | feat(tui): M1 — fix build + session actions + spawn + polling transcript | merged | safe-remove |
| feature/tui-m2 | 2026-09-13 | feat(tui): M2 P2+P3 — session action buttons + composer + AskUserQuestion | rebased-into-main | safe-remove |
| feature/tui-m3 | 2026-09-13 | feat(tui): M3 P4 wizards + P5 polish | merged | safe-remove |
| feature/tui-p1a | 2026-09-13 | feat(tui): P1a — Dashboard filter/sort/group + SessionDetail entry roles | merged | safe-remove |
| feature/tui-p1b | 2026-09-13 | feat(tui): M1 P1b — Schedules, Projects, Settings screens (read-only) | rebased-into-main | safe-remove |
| feature/tui-p1c | 2026-09-13 | feat(tui): M1 P1c — MetricsScreen + DiagnosticsScreen + DelegationGraph | rebased-into-main | safe-remove |

---

## Notes on "rebased-into-main"

These 7 branches show as `--no-merged` by git (no common merge commit), but their tip commit subject line appears verbatim in `main` log — strong indicator they were squash-merged or fast-forward rebased. Content is in `main`. Safe to delete.

## Notes on uncertain / real unmerged work

**None found.** All 48 non-main remote branches have their work accounted for in `main`.
