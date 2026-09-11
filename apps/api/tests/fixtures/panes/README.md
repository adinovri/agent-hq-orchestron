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

A reconstructed fixture is worth less than a captured one and is labelled so
nobody cites it as evidence the harness still draws that shape. What all three
do buy is precedence: each family must be claimed by its own parser and by no
other.
