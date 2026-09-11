import { describe, it, expect, vi } from 'vitest'
import { bindDialogEscape, createDialogDismiss, createOpenChangeGuard, type KeyTarget } from './dialog-dismiss'

/**
 * NF21. Escape closed the Spawn dialog and nothing else; the other hand-rolled
 * overlays each needed their own copy of the effect and never got one. This
 * covers the part worth covering — which keys close, which do not, and whether
 * the listener is actually let go of afterwards.
 */

/** A `document` stand-in. The app's vitest has no DOM, and this needs no more
 *  of one than add/remove/dispatch. */
function fakeTarget() {
  const listeners = new Set<(e: KeyboardEvent) => void>()
  const target: KeyTarget = {
    addEventListener: (_t, l) => { listeners.add(l) },
    removeEventListener: (_t, l) => { listeners.delete(l) },
  }
  return {
    target,
    get count() { return listeners.size },
    press(key: string, opts: { defaultPrevented?: boolean } = {}) {
      const e = { key, defaultPrevented: opts.defaultPrevented ?? false } as KeyboardEvent
      for (const l of [...listeners]) l(e)
    },
  }
}

describe('bindDialogEscape', () => {
  it('closes on Escape', () => {
    const onClose = vi.fn()
    const doc = fakeTarget()
    bindDialogEscape(doc.target, onClose)
    doc.press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores every other key', () => {
    const onClose = vi.fn()
    const doc = fakeTarget()
    bindDialogEscape(doc.target, onClose)
    for (const key of ['Enter', 'Tab', 'e', 'Esc', 'escape', ' ', 'ArrowUp']) doc.press(key)
    // 'Esc' and 'escape' included deliberately: `KeyboardEvent.key` for this
    // key is exactly 'Escape', and a near-miss comparison would still pass a
    // test that only tried 'Enter'.
    expect(onClose).not.toHaveBeenCalled()
  })

  it('leaves an Escape another handler already claimed alone', () => {
    // A select or a menu inside the dialog closes itself on Escape and calls
    // preventDefault. Closing the dialog as well would make one key press do
    // two things.
    const onClose = vi.fn()
    const doc = fakeTarget()
    bindDialogEscape(doc.target, onClose)
    doc.press('Escape', { defaultPrevented: true })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('unbinds, and the same listener it bound', () => {
    const onClose = vi.fn()
    const doc = fakeTarget()
    const off = bindDialogEscape(doc.target, onClose)
    expect(doc.count).toBe(1)
    off()
    expect(doc.count).toBe(0)
    doc.press('Escape')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does not leak a listener per dialog opened', () => {
    // The failure this guards: an effect whose cleanup removes a freshly
    // constructed closure instead of the one it added. Ten opens then ten
    // closes has to end at zero, not ten.
    const doc = fakeTarget()
    const offs = Array.from({ length: 10 }, () => bindDialogEscape(doc.target, () => {}))
    expect(doc.count).toBe(10)
    for (const off of offs) off()
    expect(doc.count).toBe(0)
  })
})

/**
 * NF25. Escape was one dismissal vector of three and the only one that ever
 * consulted `pending`. The backdrop `div` carried `onClick={onClose}` and the
 * header `×` called `onClose` directly, so both walked straight past the guard
 * NF21 installed and NF24 gave a window to — including on the Session Action
 * dialog, the one NF24 had just fixed.
 *
 * The resweep measured it with a positive control: same dialog, same held
 * route, Escape stayed at 1 dialog → 1 dialog while backdrop and × went 1 → 0.
 * These tests are that control in miniature — every case asserts the guarded
 * *and* the unguarded direction, because a handler that never fires would pass
 * a suite that only checked "did not close".
 */
describe('createDialogDismiss', () => {
  /** Two sentinels: the overlay a click may land on, and a child of it. */
  const overlay = { id: 'overlay' }
  const panel = { id: 'panel' }

  describe('while dismissible', () => {
    it('closes on a click that landed on the backdrop itself', () => {
      const onClose = vi.fn()
      createDialogDismiss(true, onClose).onBackdropClick({ target: overlay, currentTarget: overlay })
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('closes on the × button', () => {
      const onClose = vi.fn()
      createDialogDismiss(true, onClose).onCloseButtonClick()
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('ignores a click that only bubbled up from inside the panel', () => {
      // The reason the identity test exists at all: `onClick={onClose}` on the
      // overlay fires for every click in the dialog whose chain forgot to stop
      // bubbling, so typing in a field could close the thing.
      const onClose = vi.fn()
      createDialogDismiss(true, onClose).onBackdropClick({ target: panel, currentTarget: overlay })
      expect(onClose).not.toHaveBeenCalled()
    })
  })

  describe('mid-mutation', () => {
    it('holds the dialog open against the backdrop', () => {
      const onClose = vi.fn()
      createDialogDismiss(false, onClose).onBackdropClick({ target: overlay, currentTarget: overlay })
      expect(onClose).not.toHaveBeenCalled()
    })

    it('holds the dialog open against the ×', () => {
      const onClose = vi.fn()
      createDialogDismiss(false, onClose).onCloseButtonClick()
      expect(onClose).not.toHaveBeenCalled()
    })

    it('still swallows in-panel clicks — the guard is not a reason to leak them', () => {
      // `onPanelClick` is deliberately ungated: it exists to stop a bubble,
      // and a bubble that escapes while pending would reach an overlay handler
      // that is inert now but is one refactor from not being.
      const stopPropagation = vi.fn()
      createDialogDismiss(false, () => {}).onPanelClick({ stopPropagation })
      expect(stopPropagation).toHaveBeenCalledTimes(1)
    })
  })

  it('reopens to dismissible once the mutation settles', () => {
    // The guard is a function of `enabled`, not a latch. A dialog that stayed
    // shut against its own × after the request came back would be the same bug
    // wearing the other sign.
    const onClose = vi.fn()
    createDialogDismiss(false, onClose).onCloseButtonClick()
    expect(onClose).not.toHaveBeenCalled()
    createDialogDismiss(true, onClose).onCloseButtonClick()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('never closes twice on one backdrop click', () => {
    const onClose = vi.fn()
    const d = createDialogDismiss(true, onClose)
    d.onPanelClick({ stopPropagation: () => {} })
    d.onBackdropClick({ target: overlay, currentTarget: overlay })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

/**
 * The Base UI half of NF25. Project, Delete Project and Kill Confirm get
 * Escape from the primitive, so NF21 passed them over — but all three shipped
 * `(v) => !v && onClose()`, which forwards a backdrop click and the built-in ×
 * just as readily as Escape, disabled Cancel button notwithstanding.
 */
describe('createOpenChangeGuard', () => {
  it('closes on a close request while dismissible', () => {
    const onClose = vi.fn()
    createOpenChangeGuard(true, onClose)(false)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('refuses the close request mid-mutation', () => {
    // The primitive is controlled: not forwarding leaves `open` true, so the
    // dialog is still there when the request comes back.
    const onClose = vi.fn()
    createOpenChangeGuard(false, onClose)(false)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('never mistakes an open request for a close one', () => {
    // `onOpenChange(true)` is the primitive reporting it opened. Calling
    // `onClose` there would close the dialog the instant it appeared, which is
    // exactly what the dropped `!v` clause used to prevent.
    const onClose = vi.fn()
    for (const enabled of [true, false]) createOpenChangeGuard(enabled, onClose)(true)
    expect(onClose).not.toHaveBeenCalled()
  })
})
