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

describe('the three families do not poach each other', () => {
  // Precedence at the call site is selector → mcp → native. That only holds
  // if each parser declines the panes it does not own.
  it('the native modal is claimed by neither older parser', () => {
    expect(parseSelectorModal(pane(NATIVE))).toBeNull()
    expect(parseMcpToolModal(pane(NATIVE))).toBeNull()
    expect(parseNativeToolModal(pane(NATIVE))).not.toBeNull()
  })

  it('the selector modal still belongs to parseSelectorModal', () => {
    const prompt = parseSelectorModal(pane(SELECTOR))
    expect(prompt).not.toBeNull()
    expect(prompt?.options).toContain('Yes')
    // Claude puts built-in extras below a separator; they are still options.
    expect(prompt?.options).toContain('Chat about this')
    // And the new parser must not steal it — no "Do you want to proceed?".
    expect(parseNativeToolModal(pane(SELECTOR))).toBeNull()

    // `kind` is deliberately NOT asserted here. It is decided by
    // PERMISSION_HINT_RE, which knows only "do you want to proceed" and "do
    // you want to allow", so this edit-approval pane classifies as
    // `question` rather than `permission`. That may well be a real defect —
    // an Edit approval is a permission by any reading — but this fixture is a
    // reconstruction, and its wording is not evidence about what the harness
    // actually prints. Filed for the sweep to settle against a real capture
    // rather than fixed here against a string this repo invented.
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
