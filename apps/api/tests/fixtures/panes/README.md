# tmux pane fixtures

Panes as a Claude Code TUI actually draws them, held here so a harness bump
fails a unit test instead of a sweep. Modal detection is the most
version-fragile surface in the API (see NF20, and the TUI ready-detection
fragility before it), and until batch-11 none of it had a single test.

| file | provenance |
|---|---|
| `claude-2.1.268-bash-permission.txt` | **captured** — `scratchpad/e2e-runs/2026-09-11-batch10/cli-06-tmux-pane.txt`, session `3e24ce25` of the batch-10 sweep. This is the pane that sat unread for >60s and produced NF20. |
| `claude-2.1.267-selector-modal.txt` | **reconstructed** from the shape documented in `parseSelectorModal`'s docblock. No capture of this modal survives, so it asserts the parser against its own stated contract, not against a harness. Replace it with a real capture when one is next taken. |
| `mcp-tool-approval.txt` | **reconstructed**, same caveat, from `parseMcpToolModal`'s docblock. |
| `claude-2.1.268-write-permission.txt` | **captured** — `scratchpad/e2e-runs/2026-09-11-batch11/b11-1-write-approval-pane.txt`, session `013368f7` of the batch-11 sweep. The pane that sat `running` with `pendingPrompt: null` across three 14s polls and produced NF22. |

A reconstructed fixture is worth less than a captured one and is labelled so
nobody cites it as evidence the harness still draws that shape. What all three
do buy is precedence: each family must be claimed by its own parser and by no
other.


## What the Write capture settled (NF22)

B11-1 was filed as a misclassification: an Edit approval would be detected but
land on `kind: 'question'`. Batch-11 captured a real file-approval pane and the
truth was worse — **the modal was not detected at all**. The question-line gate
knew only `Do you want to proceed?`; the file family asks
`Do you want to create <filename>?`, interpolating the filename. All three
parsers returned `null`, so `kind` was never computed and there was nothing to
misclassify. Same blast radius as NF20: an unattended agent asking to create a
file parks `running` forever, invisible to the dashboard and unanswerable by
`session answer`.

Two things follow, and both are about evidence rather than regexes.

**`Edit` cannot be captured on a Nanovest-managed host.** The managed policy
(`remote-settings.json`) allowlists `Edit` org-wide, so an Edit never prompts —
verified live. `Write` is not allowlisted, which is why the capture, the
fixture and the fix all rest on the create-file family. Anyone who wants the
Edit variant needs a host without that policy.

**`make` is deliberately absent from the widened regex.** The verb list in
`PERMISSION_QUESTION_RE` covers `proceed` and `create` because both appear in
captured panes, plus `allow`, `edit`, `modify` and `delete` as the rest of the
imperative family. It does *not* cover `make`, even though
`claude-2.1.267-selector-modal.txt` says `Do you want to make this edit?` —
because that fixture is a reconstruction and that sentence is one this repo
wrote for itself. Widening the regex to match it, then citing the fixture as
proof the widening works, is circular. The selector pane therefore still
classifies as `question`, and `modal-parsers.test.ts` asserts that it does, so
the gap is pinned and visible rather than assumed away. **Replacing that
fixture with a real capture is the open item** — if the harness really does say
`make`, the verb list is a one-word change and the test will say so.

A third lesson, cheaper but sharp: the capture draws `╌` rules around the
file-content preview *inside* the modal, where `─` marks the modal's top edge.
Folding both into one separator regex is the obvious move and it truncates the
title band at the first fence — detected, but with no detail for the operator
to read. They are two regexes because they mean opposite things.
