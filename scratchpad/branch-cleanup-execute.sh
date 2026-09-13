#!/usr/bin/env bash
# Run this to execute branch cleanup proposal.
# Review the report first: scratchpad/branch-audit-report.md
# This removes remote branches — cannot undo without knowing SHA.

set -e

REMOTE=origin

echo "=== Branch Cleanup: 48 remote branches to delete ==="
echo "Dry-run first (remove --dry-run to execute):"
echo ""

DRY_RUN="${DRY_RUN:---dry-run}"

git push $REMOTE --delete $DRY_RUN \
  feature/api-settings-metadata \
  feature/cli-expansion-b \
  feature/cli-m2-repl \
  feature/cli-new-1-4 \
  feature/cli-parity-fixes \
  feature/docs-beginner-quickstart \
  feature/docs-cli-tui-update \
  feature/e2e-batch-6-gap-fill \
  feature/e2e-followups-batch-1 \
  feature/e2e-followups-batch-10 \
  feature/e2e-followups-batch-11 \
  feature/e2e-followups-batch-12 \
  feature/e2e-followups-batch-13 \
  feature/e2e-followups-batch-14 \
  feature/e2e-followups-batch-15 \
  feature/e2e-followups-batch-16 \
  feature/e2e-followups-batch-17 \
  feature/e2e-followups-batch-18 \
  feature/e2e-followups-batch-19 \
  feature/e2e-followups-batch-2 \
  feature/e2e-followups-batch-20 \
  feature/e2e-followups-batch-3 \
  feature/e2e-followups-batch-4 \
  feature/e2e-followups-batch-5 \
  feature/e2e-followups-batch-7 \
  feature/e2e-followups-batch-8 \
  feature/e2e-gap-fill \
  feature/e2e-phase2-isolation \
  feature/e2e-test-plan \
  feature/headless-adopt-import-mcp-toggle \
  feature/headless-block-mode-edit-at-idle \
  feature/headless-mode-flag \
  feature/headless-mode-phase1 \
  feature/headless-phase2 \
  feature/headless-structured-output-ux-fix \
  feature/headless-symbolic-sleeping \
  feature/schedule-dialog-match-spawn \
  feature/schedule-model-effort-tmux \
  feature/schedule-run-redirect \
  feature/session-details-copy-inline \
  feature/session-details-polish \
  feature/session-details-redesign \
  feature/tui-m1-start \
  feature/tui-m2 \
  feature/tui-m3 \
  feature/tui-p1a \
  feature/tui-p1b \
  feature/tui-p1c

echo ""
echo "=== Done ==="
echo "To actually delete (not dry-run): DRY_RUN='' bash scratchpad/branch-cleanup-execute.sh"
