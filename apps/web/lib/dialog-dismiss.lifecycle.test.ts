import { describe, it, expect, vi } from 'vitest'
import { bindDialogEscape, createDialogDismiss, createOpenChangeGuard, type KeyTarget } from './dialog-dismiss'
import { confirmSessionAction, settleSessionAction } from './session-action-dialog'

/**
 * NF25, end to end over the one thing the unit tests take as given: that
 * `enabled` is actually false for the whole window the mutation is in flight.
 *
 * Each unit test above hands `createDialogDismiss` a hard-coded boolean, so
 * every one of them would still pass against a dialog wired to `open` alone —
 * which is exactly what Spawn, Schedule, Adopt and Import were before this
 * change. What that cannot catch is the sequencing bug NF24 was: the dialog
 * closing itself *before* the mutation starts, so `pending` never reaches the
 * mounted dialog and the guard protects a window that does not exist.
 *
 * So this drives the real sequence — submit, pending, dismissal attempt,
 * settle — through a mutation that is genuinely unresolved at the moment the
 * operator clicks, and asserts the dialog is still on screen. `Dialog` here is
 * the render loop of a hand-rolled dialog with the DOM taken out: `enabled` is
 * recomputed from `open && !pending` on every attempt, the way a re-render
 * would, rather than captured once.
 */
function Dialog(opts: { onSubmit: () => Promise<void> }) {
  let open = true
  let pending = false
  const doc = fakeDoc()
  let unbindEscape: (() => void) | null = null

  const close = () => { open = false }
  /** What the component recomputes each render: on screen *and* dismissible. */
  const enabled = () => open && !pending
  const handlers = () => createDialogDismiss(enabled(), close)

  const rebindEscape = () => {
    unbindEscape?.()
    unbindEscape = enabled() ? bindDialogEscape(doc.target, close) : null
  }
  rebindEscape()

  return {
    get open() { return open },
    get pending() { return pending },
    async submit() {
      pending = true
      rebindEscape()
      try {
        await opts.onSubmit()
        settleSessionAction('success', close)
      } catch {
        settleSessionAction('error', close)
      } finally {
        pending = false
        rebindEscape()
      }
    },
    clickBackdrop() {
      const overlay = {}
      handlers().onBackdropClick({ target: overlay, currentTarget: overlay })
    },
    clickCloseButton() { handlers().onCloseButtonClick() },
    pressEscape() { doc.press('Escape') },
  }
}

function fakeDoc() {
  const listeners = new Set<(e: KeyboardEvent) => void>()
  const target: KeyTarget = {
    addEventListener: (_t, l) => { listeners.add(l) },
    removeEventListener: (_t, l) => { listeners.delete(l) },
  }
  return {
    target,
    press(key: string) {
      const e = { key, defaultPrevented: false } as KeyboardEvent
      for (const l of [...listeners]) l(e)
    },
  }
}

/** A request the test decides when to answer — the held route, in-process. */
function heldRequest() {
  let settle!: (ok: boolean) => void
  const promise = new Promise<void>((resolve, reject) => {
    settle = (ok) => (ok ? resolve() : reject(new Error('HTTP 500')))
  })
  return { promise, resolve: () => settle(true), reject: () => settle(false) }
}

describe('a dialog over a mutation that has not come back yet', () => {
  for (const [name, dismiss] of [
    ['the backdrop', (d: ReturnType<typeof Dialog>) => d.clickBackdrop()],
    ['the × button', (d: ReturnType<typeof Dialog>) => d.clickCloseButton()],
    ['Escape', (d: ReturnType<typeof Dialog>) => d.pressEscape()],
  ] as const) {
    it(`stays open against ${name}, and closes on success`, async () => {
      const req = heldRequest()
      const d = Dialog({ onSubmit: () => req.promise })
      const submitted = d.submit()

      expect(d.pending).toBe(true)
      dismiss(d)
      expect(d.open).toBe(true)

      req.resolve()
      await submitted
      expect(d.open).toBe(false)
    })
  }

  it('takes the dismissal the moment the mutation settles, not before', async () => {
    // The guard is a hold, not a veto: the operator who clicked the backdrop
    // mid-flight should not be locked out of the dialog afterwards.
    const req = heldRequest()
    const d = Dialog({ onSubmit: () => req.promise })
    const submitted = d.submit()
    d.clickBackdrop()
    expect(d.open).toBe(true)

    req.reject()
    await submitted
    // A failed action leaves the dialog up with the form intact
    // (`settleSessionAction`), so dismissal has to work again now.
    expect(d.open).toBe(true)
    d.clickBackdrop()
    expect(d.open).toBe(false)
  })

  it('is dismissible before anything is submitted', async () => {
    // The negative control. Without it every assertion above is satisfied by a
    // dialog that simply never closes.
    const d = Dialog({ onSubmit: async () => {} })
    d.clickBackdrop()
    expect(d.open).toBe(false)
  })

  it('the same, for a Base UI dialog', async () => {
    // Project / Delete Project / Kill Confirm reach `onClose` through one
    // `onOpenChange(false)` for all three vectors.
    const req = heldRequest()
    let open = true
    let pending = false
    const close = () => { open = false }
    const requestClose = () => createOpenChangeGuard(open && !pending, close)(false)

    requestClose()
    expect(open).toBe(false)   // control: it does close when nothing is running

    open = true
    pending = true
    const settled = req.promise.then(() => { pending = false; close() })
    requestClose()
    expect(open).toBe(true)

    req.resolve()
    await settled
    expect(open).toBe(false)
  })
})

describe('the window the guard needs in order to mean anything (NF24)', () => {
  it('confirm does not close, so pending can reach a mounted dialog', () => {
    // The regression this locks: `confirmSessionAction` closing the dialog
    // itself would put every guard above back to protecting nothing.
    const close = vi.fn()
    const reopen = vi.fn()
    confirmSessionAction('reopen', {}, { reopen, fork: vi.fn(), respawn: vi.fn() })
    expect(reopen).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
  })
})
