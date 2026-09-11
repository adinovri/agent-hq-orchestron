import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseSelectorModal,
  parseMcpToolModal,
  parseNativeToolModal,
} from '../src/domain/session-manager.js'

/**
 * NF20 — the tmux pane parsers, against saved panes.
 *
 * The failure: a session blocked on a Claude Code Bash-permission modal stayed
 * `running` with `pendingPrompt: null` for the whole life of the modal. No
 * `needs_input`, no approval banner, and `session answer --choice` refusing
 * because there was nothing on the record. Measured on session `3e24ce25` of
 * the batch-10 sweep: the modal held the pane for >60s across repeated 20s
 * sweeps while the record never moved.
 *
 * Cause: three modal families exist and only two had parsers. The native
 * approval modal has no `☐` header (so `parseSelectorModal` bails at its first
 * gate) and no `About the <server> — <Tool> Tool:` header (so
 * `parseMcpToolModal` bails at its), which left the family that gates *every
 * Bash approval* unread.
 *
 * This suite is as much about drift as about the fix. These regexes read a
 * TUI that is not a contract and changes between patch releases — the same
 * class as the known ready-detection fragility — so each family is pinned to a
 * pane file. See `fixtures/panes/README.md`: one is a real capture, two are
 * reconstructions from the parsers' own docblocks and are labelled as such.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pane = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures/panes', name), 'utf8')

const NATIVE = 'claude-2.1.268-bash-permission.txt'
const SELECTOR = 'claude-2.1.267-selector-modal.txt'
const MCP = 'mcp-tool-approval.txt'
const WRITE = 'claude-2.1.268-write-permission.txt'

describe('parseNativeToolModal (NF20)', () => {
  it('reads the pane that went unread for 60 seconds', () => {
    const prompt = parseNativeToolModal(pane(NATIVE))
    expect(prompt).not.toBeNull()
    expect(prompt?.kind).toBe('permission')
    expect(prompt?.title).toBe('Bash command')
    // All three options, in pane order — `--choice 2` has to mean the
    // allow-for-this-project one and not something else.
    expect(prompt?.options).toEqual([
      'Yes',
      'Yes, allow reading from /tmp/orchestron-e2e from this project',
      'No',
    ])
    expect(prompt?.detail).toContain('ls /tmp/orchestron-e2e .')
  })

  it('keeps the conversation above the modal out of the title', () => {
    // The fixture has five lines of Nanovest banner and the echoed user
    // prompt above the separator. None of it is modal content.
    const prompt = parseNativeToolModal(pane(NATIVE))
    expect(prompt?.title).not.toContain('Run the shell command')
    expect(prompt?.detail ?? '').not.toContain('Message from Nanovest')
  })

  it('still finds the modal when the separator rule is absent', () => {
    // Same modal, rule stripped: the bounded lookback has to carry it, since
    // whether Claude draws the rule is exactly the kind of thing that moves
    // between releases.
    const stripped = pane(NATIVE)
      .split('\n')
      .filter((l) => !/^[─━]{3,}$/.test(l.trim()))
      .join('\n')
    const prompt = parseNativeToolModal(stripped)
    expect(prompt?.title).toBe('Bash command')
    expect(prompt?.options).toHaveLength(3)
  })

  it('is not fooled by prose that merely contains the words', () => {
    // The gate is question + footer + at least one numbered option between
    // them. Transcript text quoting a modal must not become a pending prompt.
    expect(
      parseNativeToolModal(
        '● I asked "Do you want to proceed?" and the docs say Esc to cancel.',
      ),
    ).toBeNull()
    // Question and footer present, no options between them.
    expect(
      parseNativeToolModal(['Do you want to proceed?', '', 'Esc to cancel'].join('\n')),
    ).toBeNull()
    expect(parseNativeToolModal('')).toBeNull()
  })
})

describe('parseNativeToolModal — file approvals (NF22)', () => {
  /**
   * NF22 supersedes B11-1. B11-1 predicted that a file-approval modal would be
   * detected but misclassified as `kind: 'question'`. The batch-11 sweep
   * captured one and found something worse: `kind` was never computed at all,
   * because the question-line gate rejected the pane first. All three parsers
   * returned `null` and the session sat `running` with `pendingPrompt: null`
   * across three 14s polls — the identical symptom NF20 had just fixed for
   * Bash.
   *
   * This fixture is a REAL CAPTURE (claude 2.1.268, session `013368f7` of the
   * batch-11 sweep), which is the whole reason the fix was allowed to be
   * written. `Edit` could not be the probe on that host: the Nanovest managed
   * policy allowlists `Edit` org-wide so it never prompts. `Write` is not
   * allowlisted, so `Write`/create is the family this rests on.
   */
  it('detects the Write approval that parked a session on running', () => {
    const prompt = parseNativeToolModal(pane(WRITE))
    expect(prompt).not.toBeNull()
    // The point of the finding: not a wrong kind, a missing prompt.
    expect(prompt?.options).toEqual([
      'Yes',
      'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
      'No',
    ])
  })

  it('classifies it as a permission, not a question', () => {
    // B11-1's original claim, now actually reachable and actually asserted.
    expect(parseNativeToolModal(pane(WRITE))?.kind).toBe('permission')
  })

  it('titles it from the modal, not from the transcript above it', () => {
    const prompt = parseNativeToolModal(pane(WRITE))
    // The capture's header band is `Create file` / `b11.txt`. Above the rule
    // sits a `● Write(b11.txt)` transcript glyph and the echoed user prompt;
    // neither is modal content.
    expect(prompt?.title).toBe('Create file')
    expect(prompt?.detail).toContain('b11.txt')
    expect(prompt?.title).not.toContain('Use the Write tool')
    expect(prompt?.detail ?? '').not.toContain('Use the Write tool')
  })

  it('drops the dashed rules Claude draws around the content preview', () => {
    // The file-preview band is fenced with `╌`, which the old SEPARATOR_RE
    // did not know — it only covered the solid `─`. Left unhandled the rules
    // land in `detail` as runs of box-drawing noise.
    const detail = parseNativeToolModal(pane(WRITE))?.detail ?? ''
    expect(detail).not.toMatch(/[\u254C\u254D\u2504\u2505\u2508\u2509]{3,}/)
    // The preview itself is still kept — it is what the operator approves.
    expect(detail).toContain('draft')
  })

  it('still refuses prose that merely quotes the new wording', () => {
    // Widening the verb list widens the false-positive surface too. The gate
    // is question + footer + a numbered option between them; none of these
    // clear it.
    expect(
      parseNativeToolModal('● It asked "Do you want to create b11.txt?" — Esc to cancel.'),
    ).toBeNull()
    expect(
      parseNativeToolModal(['Do you want to create x.txt?', '', 'Esc to cancel'].join('\n')),
    ).toBeNull()
  })

  it('gate and classifier agree on every attested verb', () => {
    // NF22's root cause was two regexes for one family drifting apart: the
    // gate knew `proceed`, the classifier knew `proceed` and `allow`, and
    // neither knew `create`. They are one object now, so a verb that opens
    // the gate must also classify as `permission` — assert that rather than
    // trusting the aliasing.
    for (const verb of ['proceed', 'allow', 'create', 'edit', 'modify', 'delete']) {
      const synthetic = [
        '────────────────────────────────────────',
        ' Tool approval',
        ` Do you want to ${verb} something?`,
        ' ❯ 1. Yes',
        '   2. No',
        '',
        ' Esc to cancel · Tab to amend',
      ].join('\n')
      const prompt = parseNativeToolModal(synthetic)
      expect(prompt, `verb ${verb} did not open the gate`).not.toBeNull()
      expect(prompt?.kind, `verb ${verb} did not classify as permission`).toBe('permission')
    }
  })
})

describe('the three families do not poach each other', () => {
  // Precedence at the call site is selector → mcp → native. That only holds
  // if each parser declines the panes it does not own.
  it('the native modal is claimed by neither older parser', () => {
    expect(parseSelectorModal(pane(NATIVE))).toBeNull()
    expect(parseMcpToolModal(pane(NATIVE))).toBeNull()
    expect(parseNativeToolModal(pane(NATIVE))).not.toBeNull()
  })

  it('the Write approval is claimed by neither older parser either', () => {
    // Widening the question regex could have handed this pane to the MCP
    // parser, which shares the gate. It has no `About the <server> — <Tool>
    // Tool:` header and no `☐`, so both older parsers must still decline.
    expect(parseSelectorModal(pane(WRITE))).toBeNull()
    expect(parseMcpToolModal(pane(WRITE))).toBeNull()
    const winner =
      parseSelectorModal(pane(WRITE)) ??
      parseMcpToolModal(pane(WRITE)) ??
      parseNativeToolModal(pane(WRITE))
    expect(winner?.title).toBe('Create file')
  })

  it('the selector modal still belongs to parseSelectorModal', () => {
    const prompt = parseSelectorModal(pane(SELECTOR))
    expect(prompt).not.toBeNull()
    expect(prompt?.options).toContain('Yes')
    // Claude puts built-in extras below a separator; they are still options.
    expect(prompt?.options).toContain('Chat about this')
    // And the new parser must not steal it — no "Do you want to proceed?".
    expect(parseNativeToolModal(pane(SELECTOR))).toBeNull()

    // `kind` is STILL deliberately not asserted, and NF22 is the reason it
    // stays that way. This fixture asks "Do you want to make this edit?" —
    // `make`, a verb that appears nowhere in any captured pane. The sweep
    // settled B11-1 against a real capture and found the wording was
    // `Do you want to create <file>?`, which no reconstruction produced. So
    // the family regex was widened to the verbs that are attested and no
    // further: adding `make` would be widening it to match a sentence this
    // repo wrote for itself, and the fixture would then "prove" a fix to its
    // own invention. This pane consequently still classifies as `question`.
    // That is a known, deliberate gap — see the WRITE suite below for what
    // evidence-backed detection looks like, and fixtures/panes/README.md.
    expect(prompt?.kind).toBe('question')
  })

  it('the MCP modal still belongs to parseMcpToolModal', () => {
    const prompt = parseMcpToolModal(pane(MCP))
    expect(prompt).not.toBeNull()
    expect(prompt?.title).toBe('atlassian · getJiraIssue')
    // The native parser DOES match this pane's shape — question + footer +
    // options — which is why it must run last. Order is load-bearing, so
    // assert both halves rather than only the winner.
    expect(parseNativeToolModal(pane(MCP))).not.toBeNull()
    const winner =
      parseSelectorModal(pane(MCP)) ?? parseMcpToolModal(pane(MCP)) ?? parseNativeToolModal(pane(MCP))
    expect(winner?.title).toBe('atlassian · getJiraIssue')
  })
})
