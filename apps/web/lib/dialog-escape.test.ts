import { describe, it, expect, vi } from 'vitest'
import { bindDialogEscape, type KeyTarget } from './dialog-escape'

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
