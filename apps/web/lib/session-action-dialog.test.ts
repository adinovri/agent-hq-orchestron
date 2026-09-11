import { describe, it, expect, vi } from 'vitest'
import {
  confirmSessionAction,
  settleSessionAction,
  type SessionActionKind,
  type SessionActionRunners,
} from './session-action-dialog'

/**
 * NF24 — the Session Action dialog closed before its mutation started.
 *
 * The batch-11 PR stated that all three guarded callers "already disable
 * Cancel while a mutation is in flight". True of Metadata Edit and Delete
 * Record. Not of Session Action: its caller ran `setActionDialog(null)` and
 * *then* `mutate()`, so `open` was already false by the time `pending` turned
 * true. `if (!open) return null` unmounted the component, and the `!pending`
 * in `useDialogDismiss(open && !pending, onClose)` guarded a window that never
 * opened. Measured with the reopen POST held for 8s: gone at 1.5s.
 *
 * The regression is about *ordering*, which is why confirm and settle are two
 * functions: a test can hold the moment between them open and look at it.
 */

function runners() {
  const calls: Array<{ kind: SessionActionKind; opts: unknown }> = []
  const run: SessionActionRunners = {
    reopen: (opts) => calls.push({ kind: 'reopen', opts }),
    fork: (opts) => calls.push({ kind: 'fork', opts }),
    respawn: (opts) => calls.push({ kind: 'respawn', opts }),
  }
  return { run, calls }
}

describe('confirmSessionAction', () => {
  it('does not close the dialog — that is the whole finding', () => {
    // If confirming could close, the two responsibilities would be reachable
    // from one callback again and NF24 would be one edit away from returning.
    const close = vi.fn()
    const { run } = runners()
    confirmSessionAction('reopen', {}, run)
    expect(close).not.toHaveBeenCalled()
  })

  it('routes each kind to its own mutation, and only that one', () => {
    for (const kind of ['reopen', 'fork', 'respawn'] as const) {
      const { run, calls } = runners()
      confirmSessionAction(kind, {}, run)
      expect(calls.map((c) => c.kind)).toEqual([kind])
    }
  })

  it('passes the dialog options straight through', () => {
    const { run, calls } = runners()
    const opts = { model: 'claude-opus-5', effort: 'high' as const, prompt: 'go', useTmux: false }
    confirmSessionAction('fork', opts, run)
    expect(calls[0]?.opts).toEqual(opts)
  })

  it('is a no-op with no action selected', () => {
    // `actionDialog` is null whenever the dialog is closed, and a stray
    // confirm must not fire a mutation against nothing.
    const { run, calls } = runners()
    confirmSessionAction(null, {}, run)
    expect(calls).toEqual([])
  })
})

describe('settleSessionAction', () => {
  it('closes on success', () => {
    const close = vi.fn()
    settleSessionAction('success', close)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('leaves the dialog open on error', () => {
    // Matches Metadata Edit and Delete Record, which close from onSuccess.
    // The form still holds what was typed, so a retry does not start over.
    const close = vi.fn()
    settleSessionAction('error', close)
    expect(close).not.toHaveBeenCalled()
  })
})

describe('the confirm → settle window', () => {
  it('stays open for the whole life of the mutation', () => {
    // The sequence the old code could not produce. `open` is read at three
    // points: after confirm (mutation in flight), and after each outcome.
    let open = true
    const close = () => { open = false }
    const { run, calls } = runners()

    confirmSessionAction('reopen', { model: 'claude-opus-5' }, run)
    expect(calls).toHaveLength(1)
    expect(open, 'dialog closed before the mutation settled — NF24').toBe(true)

    settleSessionAction('success', close)
    expect(open).toBe(false)
  })

  it('survives a failed mutation without closing', () => {
    let open = true
    const close = () => { open = false }
    const { run } = runners()

    confirmSessionAction('respawn', {}, run)
    expect(open).toBe(true)
    settleSessionAction('error', close)
    expect(open).toBe(true)
  })
})
