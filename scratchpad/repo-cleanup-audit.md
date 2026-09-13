# Repo Cleanup Audit — 2026-09-13

**Repo:** `/home/scriberion/Works/agent-hq-orchestron`  
**HEAD:** `85295e4`  
**Audited by:** NafuTech (read-only pass)  
**Scope:** scratchpad/ tracked files, scripts/*.md tracked files, docs/e2e-tests/, root strays

---

## Summary

| Category | Files | Disk size |
|---|---|---|
| **safe-prune** (git rm) | 21 | ~320 KB |
| **keep** | 24+ | ~12 KB tracked |
| **uncertain** | 0 | — |
| **local-only cleanup** (rm, not git rm) | 2060 | ~50 MB |

**Estimated disk savings after cleanup:** ~50.3 MB total  
- ~320 KB from git working tree (21 `git rm`)  
- ~50 MB from local-only `scratchpad/e2e-runs/` (untracked, never in git)

---

## Note: 14-Day Rule

The .gitignore already declares `scratchpad/` and `scripts/*.md` as "Session-scoped working notes... Not production docs." All tracked files in scratchpad/ were force-added during E2E chain work (2026-09-04 through 2026-09-12). The 14-day safety rule is interpreted here as protecting **active WIP** — not archival artifacts from completed phases. Every file proposed for safe-prune below is from a **closed chapter** (initial impl batch-1..5 complete, E2E chain declared TERMINAL at batch-22).

**Adi judgment call:** If you want stricter 14-day protection, hold the batch-15..21 files until 2026-09-26 then re-run.

---

## Category 1: SAFE-PRUNE (git rm + commit)

### scratchpad/ — Session artifacts, impl complete, no live code refs

| File | Last commit | Size | Reason |
|---|---|---|---|
| `orchestron-COMPLETE.md` | 2026-09-04 | 8 KB | Initial 30-task impl completion summary; covered by memory |
| `orchestron-batch1-summary.md` | 2026-09-04 | 4 KB | Batch impl progress note; impl done |
| `orchestron-batch2-summary.md` | 2026-09-04 | 4 KB | Batch impl progress note; impl done |
| `orchestron-batch3-summary.md` | 2026-09-04 | 4 KB | Batch impl progress note; impl done |
| `orchestron-batch4-summary.md` | 2026-09-04 | 4 KB | Batch impl progress note; impl done |
| `orchestron-batch5-summary.md` | 2026-09-04 | 4 KB | Batch impl progress note; impl done |
| `parity-audit.md` | 2026-09-04 | 20 KB | FR/parity audit from initial impl; covered by memory project_orchestron_e2e_test_plan |
| `e2e-followups-batch-18-pr.md` | 2026-09-12 | 8 KB | PR draft; batch-18 merged, no external refs |
| `e2e-followups-batch-19-pr.md` | 2026-09-12 | 8 KB | PR draft; batch-19 merged, no external refs |
| `e2e-smoke-sweep-post-batch15.md` | 2026-09-11 | 28 KB | Intermediate sweep report; chain TERMINAL at batch-22 |
| `e2e-smoke-sweep-post-batch16.md` | 2026-09-12 | 24 KB | Intermediate sweep report; superseded |
| `e2e-smoke-sweep-post-batch17.md` | 2026-09-12 | 32 KB | Intermediate sweep report; superseded |
| `e2e-smoke-sweep-post-batch18.md` | 2026-09-12 | 36 KB | Intermediate sweep report; superseded |
| `e2e-smoke-sweep-post-batch19.md` | 2026-09-12 | 32 KB | Intermediate sweep report; superseded |
| `e2e-smoke-sweep-post-batch20.md` | 2026-09-12 | 28 KB | Intermediate sweep report; superseded |
| `e2e-smoke-sweep-post-batch21.md` | 2026-09-12 | 36 KB | Intermediate sweep report; superseded by batch-22 TERMINAL |

**Subtotal:** 16 files, ~272 KB

### scripts/ — Impl planning docs, all tasks complete, no refs

| File | Last commit | Size | Reason |
|---|---|---|---|
| `scripts/impl-batch1.md` | 2026-09-04 | 8 KB | Task breakdown for batch-1 impl; complete, no refs in code/docs |
| `scripts/impl-batch2.md` | 2026-09-04 | 8 KB | Task breakdown for batch-2 impl; complete, no refs |
| `scripts/impl-batch3.md` | 2026-09-04 | 8 KB | Task breakdown for batch-3 impl; complete, no refs |
| `scripts/impl-batch4.md` | 2026-09-04 | 4 KB | Task breakdown for batch-4 impl; complete, no refs |
| `scripts/impl-batch5.md` | 2026-09-04 | 8 KB | Task breakdown for batch-5 impl; complete, no refs |

**Subtotal:** 5 files, ~36 KB

---

## Category 2: KEEP

### scratchpad/ — Explicitly protected

| File | Last commit | Size | Reason |
|---|---|---|---|
| `scratchpad/e2e-smoke-sweep-post-batch22.md` | 2026-09-12 | 12 KB | **TERMINAL sweep report** — memory-referenced (MEMORY.md entry: "Batch-22 TERMINAL… 17/17 PASS, sweep-clean-at-LOW declared"). Authoritative final E2E record. |

### scripts/ — Shell scripts and docs

| Path | Reason |
|---|---|
| `scripts/README.md` | Explicitly protected; documents the checked-in scripts |
| `scripts/dev.sh` | Active shell script |
| `scripts/e2e-env.sh` | Active shell script |
| `scripts/e2e-env.test.sh` | Active shell script |
| `scripts/e2e-scenario.sh` | Active shell script |
| `scripts/init.sh` | Active shell script |
| `scripts/e2e-probe/` (6 files) | Active E2E probe modules |
| `scripts/systemd/` (2 files) | Systemd service units |

### docs/e2e-tests/ — Active test documentation (23 files)

All 23 files in `docs/e2e-tests/` are test scenario documentation (00-setup.md, dashboard-ui.md, cli.md, headless-flow.md, etc.). These are **KEEP** — they define the test scenarios that back the sweep cadence and are referenced by the sweep protocol.

### Root

No `.DS_Store`, swap files, or other stray files found in repo root.

---

## Category 3: UNCERTAIN (needs Adi review)

None. All candidates resolve clearly to safe-prune or keep.

---

## Category 4: LOCAL-ONLY (untracked, not in git — rm only, no git rm)

These files exist on disk but are NOT tracked in git (gitignored). Removing them does NOT affect git history.

| Path | Files | Size | Action |
|---|---|---|---|
| `scratchpad/e2e-runs/` | 2,060 | ~50 MB | Safe to `rm -rf` — screenshots/JSON from completed E2E sweeps. All within 14 days but chain is TERMINAL. |
| Other `scratchpad/` untracked files | ~100 | ~8 MB | Local working files; gitignored. Do NOT `git rm`. |

**Note on transcript-format.test.ts:** Line 143 references `scratchpad/e2e-smoke-sweep-post-batch2.md` as a code comment ("Fixtures trimmed from..."). This is documentation-only, not a structural dependency. That file is NOT tracked in git and its removal would have zero runtime impact.

---

## Suggested .gitignore Additions

The current `.gitignore` already covers `scratchpad/` and `scripts/*.md`. No new entries needed for those categories.

**Recommended additions** for defense-in-depth:

```gitignore
# Explicitly exclude E2E run artifacts even if someone force-adds accidentally
scratchpad/e2e-runs/

# Exclude all scratchpad subdirs
scratchpad/*/
```

These are belt-and-suspenders: the existing `scratchpad/` rule already covers them, but being explicit prevents accidental `git add --force scratchpad/e2e-runs/` in future sessions.

---

## Cleanup Execution

Run `scratchpad/repo-cleanup-execute.sh` to stage the `git rm` operations.  
Then: `git commit -m "chore: remove tracked session artifacts (scratchpad + impl planning docs)"`  
Then: `git push origin main`

For local disk cleanup of e2e-runs: `rm -rf scratchpad/e2e-runs/` (independent, can run any time).
