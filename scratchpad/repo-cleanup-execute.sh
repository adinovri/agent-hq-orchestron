#!/usr/bin/env bash
# Run this to execute the cleanup plan. Review first. Requires main worktree, on main branch.
#
# What this does:
#   1. git rm  — removes 21 tracked session artifacts from the git index + working tree
#   2. Prints instructions for the commit + push
#   3. Prints the separate rm -rf command for local e2e-runs/ (untracked, disk only)
#
# What this does NOT do:
#   - Does NOT commit (you review the staged changes first)
#   - Does NOT push
#   - Does NOT touch apps/, packages/, docs/, scripts/*.sh, or scripts/e2e-probe/
#   - Does NOT touch scratchpad/e2e-smoke-sweep-post-batch22.md (TERMINAL report, keep)

set -e

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo "ERROR: not on main branch (currently: $BRANCH). Switch to main first."
  exit 1
fi

echo "=== Staging scratchpad session artifacts for removal ==="

# Completed initial impl summaries (2026-09-04)
git rm scratchpad/orchestron-COMPLETE.md
git rm scratchpad/orchestron-batch1-summary.md
git rm scratchpad/orchestron-batch2-summary.md
git rm scratchpad/orchestron-batch3-summary.md
git rm scratchpad/orchestron-batch4-summary.md
git rm scratchpad/orchestron-batch5-summary.md
git rm scratchpad/parity-audit.md

# Merged PR drafts (batch-18 and batch-19, no external refs)
git rm scratchpad/e2e-followups-batch-18-pr.md
git rm scratchpad/e2e-followups-batch-19-pr.md

# Intermediate E2E sweep reports (chain TERMINAL at batch-22; batch-22 is kept)
git rm scratchpad/e2e-smoke-sweep-post-batch15.md
git rm scratchpad/e2e-smoke-sweep-post-batch16.md
git rm scratchpad/e2e-smoke-sweep-post-batch17.md
git rm scratchpad/e2e-smoke-sweep-post-batch18.md
git rm scratchpad/e2e-smoke-sweep-post-batch19.md
git rm scratchpad/e2e-smoke-sweep-post-batch20.md
git rm scratchpad/e2e-smoke-sweep-post-batch21.md

echo ""
echo "=== Staging scripts impl planning docs for removal ==="

# Task breakdowns for initial impl batches — all complete, no code refs
git rm scripts/impl-batch1.md
git rm scripts/impl-batch2.md
git rm scripts/impl-batch3.md
git rm scripts/impl-batch4.md
git rm scripts/impl-batch5.md

echo ""
echo "=== 21 files staged. Review staged changes: ==="
echo "  git status"
echo "  git diff --cached --stat"
echo ""
echo "=== Then commit + push: ==="
echo "  git commit -m 'chore: remove tracked session artifacts (scratchpad + impl planning docs)'"
echo "  git push origin main"
echo ""
echo "=== SEPARATE: local disk cleanup (untracked, not in git): ==="
echo "  rm -rf scratchpad/e2e-runs/   # frees ~50 MB; independent of git, run any time"
