import { describe, it, expect } from 'vitest'
import {
  createFocusReturnLifecycle,
  scheduleFocusReturn,
  DIALOG_SCOPE_SELECTOR,
  FOCUS_RETURN_PASSES_MS,
  FOCUS_FALLBACK_SELECTOR,
  type DocumentLike,
  type FocusableLike,
} from './focus-return'
import { createFocusOriginTracker, type FocusInEvent, type FocusOriginHost } from './focus-origin'

/**
 * NF29, over the one thing `focus-return.test.ts` takes as given: that a return
 * scheduled by a close is still there when its passes come due.
 *
 * Every unit test of `scheduleFocusReturn` schedules and then runs the passes
 * with nothing happening in between, so all of them would still pass against
 * the batch-15 hook — which returned the cancel as its effect cleanup and so
 * called the whole return off whenever the component went away. That is not a
 * gap a unit test of the scheduler can see, because the scheduler is not the
 * thing that was wrong. The lifecycle around it was.
 *
 * So this file drives the lifecycle the way React drives it, in the three
 * shapes the ten dialogs actually take:
 *
 *   - close and stay        (Reopen, Metadata Edit, Kill, Schedule)
 *   - close and navigate    (Spawn, Delete Record, Fork — the NF29 failures)
 *   - close and reopen      (the case the cancel was written for)
 *
 * The assertion is always `activeElement`, never "cancel was not called":
 * whether the operator can carry on typing is a fact about where focus is, and
 * a test that asserts the mechanism instead would keep passing through the
 * next rewrite of it.
 */

const NATIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'])

class FakeElement implements FocusableLike {
  isConnected = true
  parent: FakeElement | null = null
  private attrs = new Map<string, string>()

  constructor(
    readonly tagName: string,
    private readonly doc: FakeDocument,
    attrs: Record<string, string> = {},
  ) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v)
  }

  focus(): void {
    if (!this.isConnected) return
    if (this.attrs.has('disabled')) return
    if (!NATIVE.has(this.tagName) && !this.attrs.has('tabindex')) return
    this.doc.activeElement = this
  }

  /** Only `DIALOG_SCOPE_SELECTOR` is understood — the one selector the
   *  production code passes. Anything else throws rather than quietly
   *  answering `null` and making a test pass for the wrong reason. */
  closest(selectors: string): FakeElement | null {
    if (selectors !== DIALOG_SCOPE_SELECTOR) throw new Error(`unsupported selector: ${selectors}`)
    if (this.attrs.get('role') === 'dialog') return this
    if (this.attrs.get('data-slot') === 'dialog-content') return this
    return this.parent?.closest(selectors) ?? null
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }
}

/**
 * A document plus the one piece of routing this needs: `<main>` is in
 * `app/layout.tsx`, so a route change swaps what is inside it and leaves the
 * element itself connected. `navigate()` models exactly that — the page's own
 * controls detach, the landmark does not.
 */
class FakeDocument implements DocumentLike, FocusOriginHost {
  body: FakeElement
  activeElement: FocusableLike | null
  readonly mainEl: FakeElement
  private pageEls: FakeElement[] = []
  private listeners: ((e: FocusInEvent) => void)[] = []

  constructor() {
    this.body = new FakeElement('BODY', this)
    this.activeElement = this.body
    this.mainEl = new FakeElement('MAIN', this)
  }

  querySelector(selectors: string): FocusableLike | null {
    if (selectors !== FOCUS_FALLBACK_SELECTOR) throw new Error(`unsupported selector: ${selectors}`)
    return this.mainEl.isConnected ? this.mainEl : null
  }

  addEventListener(_t: 'focusin', listener: (e: FocusInEvent) => void): void {
    this.listeners.push(listener)
  }
  removeEventListener(_t: 'focusin', listener: (e: FocusInEvent) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener)
  }

  /** An element belonging to the current route, detached by `navigate`. */
  pageButton(attrs: Record<string, string> = {}): FakeElement {
    const el = new FakeElement('BUTTON', this, attrs)
    this.pageEls.push(el)
    return el
  }

  /** Focus `el` the way a browser would, and fire `focusin` for it. */
  focusIn(el: FakeElement): void {
    this.activeElement = el
    for (const l of [...this.listeners]) l({ target: el })
  }

  /**
   * What the browser does the instant a focused control becomes `disabled`:
   * it will not leave focus there, and there is nowhere else to put it.
   */
  disableAndDropFocus(el: FakeElement): void {
    el.setAttribute('disabled', '')
    if (this.activeElement === el) this.activeElement = this.body
  }

  /** `router.push` landing: this route's elements are gone, `<main>` is not. */
  navigate(): void {
    for (const el of this.pageEls) el.isConnected = false
    this.pageEls = []
  }
}

/** A clock that runs nothing until told, so pass timing stays observable. */
function fakeClock() {
  const queued: { ms: number; fn: () => void; cancelled: boolean }[] = []
  const schedule = (fn: () => void, ms: number): (() => void) => {
    const entry = { ms, fn, cancelled: false }
    queued.push(entry)
    return () => {
      entry.cancelled = true
    }
  }
  /** Run every pass that is due, in time order, as a real clock would. */
  const runAll = (): void => {
    for (const ms of [...FOCUS_RETURN_PASSES_MS].sort((a, b) => a - b)) {
      for (const e of queued) if (e.ms === ms && !e.cancelled) e.fn()
    }
  }
  return { schedule, runAll, queued }
}

/**
 * `useFocusReturn` with React's effect ordering spelled out by hand.
 *
 * `render(open)` is the `[open]` effect, `unmount()` is the cleanup of the
 * mount effect — declared first in the hook precisely so that `dispose` gets
 * to read the origin tracker before `release` empties it, which is the
 * ordering this reproduces.
 */
function mountDialog(doc: FakeDocument, clock: ReturnType<typeof fakeClock>) {
  const tracker = createFocusOriginTracker(doc)
  const release = tracker.retain()
  const lifecycle = createFocusReturnLifecycle(() =>
    scheduleFocusReturn(tracker.current(), doc, clock.schedule),
  )
  let lastOpen = false
  return {
    render(open: boolean): void {
      if (open === lastOpen) return // React only re-runs the effect on change
      lastOpen = open
      lifecycle.sync(open)
    },
    unmount(): void {
      lifecycle.dispose()
      release()
    },
  }
}

/** Open a dialog and press its confirm, up to the point the mutation resolves. */
function openAndSubmit(doc: FakeDocument, dialog: ReturnType<typeof mountDialog>) {
  const trigger = doc.pageButton()
  doc.focusIn(trigger)
  dialog.render(true)

  // Inside the panel, as every confirm button is — which is the whole reason
  // the origin tracker filters by `closest(DIALOG_SCOPE_SELECTOR)`. Focusing
  // it must not displace the trigger as the element to come back to.
  const confirm = doc.pageButton()
  confirm.parent = doc.pageButton({ role: 'dialog' })
  doc.focusIn(confirm)
  expect(doc.activeElement).toBe(confirm)

  // `pending` flips true, every dialog here disables its own confirm, and the
  // browser drops focus to `<body>` before `onSuccess` has said anything.
  doc.disableAndDropFocus(confirm)
  expect(doc.activeElement).toBe(doc.body)
  return { trigger, confirm }
}

describe('focus return lifecycle (NF29)', () => {
  it('lands focus back on the trigger when success stays on the page', () => {
    const doc = new FakeDocument()
    const clock = fakeClock()
    const dialog = mountDialog(doc, clock)
    const { trigger, confirm } = openAndSubmit(doc, dialog)

    dialog.render(false) // onSuccess closes
    confirm.isConnected = false // the dialog subtree goes with it
    clock.runAll()

    expect(doc.activeElement).toBe(trigger)
  })

  it('lands focus in <main> when success closes and then navigates', () => {
    const doc = new FakeDocument()
    const clock = fakeClock()
    const dialog = mountDialog(doc, clock)
    openAndSubmit(doc, dialog)

    // Delete Record's onSuccess, in order: setDeleteOpen(false) commits first,
    // then the route transition lands and takes the page with it.
    dialog.render(false)
    doc.navigate()
    dialog.unmount()

    clock.runAll()

    // This is the NF29 assertion. Before the fix the unmount cleanup cancelled
    // both passes here and `activeElement` stayed `<body>`.
    expect(doc.activeElement).toBe(doc.mainEl)
    expect(doc.activeElement).not.toBe(doc.body)
  })

  it('still returns focus when the navigation never closes the dialog', () => {
    const doc = new FakeDocument()
    const clock = fakeClock()
    const dialog = mountDialog(doc, clock)
    openAndSubmit(doc, dialog)

    // No `render(false)` at all: the route simply changes underneath an open
    // dialog. That is a close nobody announced, and it owes a return too.
    doc.navigate()
    dialog.unmount()
    clock.runAll()

    expect(doc.activeElement).toBe(doc.mainEl)
  })

  it('does not return focus for a dialog that was never opened', () => {
    const doc = new FakeDocument()
    const clock = fakeClock()
    const dialog = mountDialog(doc, clock)
    const elsewhere = doc.pageButton()
    doc.focusIn(elsewhere)

    // The session page mounts four dialogs closed. None of them may move focus.
    dialog.render(false)
    dialog.unmount()
    clock.runAll()

    expect(clock.queued).toHaveLength(0)
    expect(doc.activeElement).toBe(elsewhere)
  })

  it('a dialog reopening before the passes land keeps its own focus', () => {
    const doc = new FakeDocument()
    const clock = fakeClock()
    const dialog = mountDialog(doc, clock)
    const { trigger } = openAndSubmit(doc, dialog)

    dialog.render(false)
    dialog.render(true) // reopened inside the 250ms window

    // The reopened dialog's own focus. `focusin` on something inside a dialog
    // is filtered by the origin tracker, so this is not a new origin either.
    const field = doc.pageButton()
    field.parent = doc.pageButton({ role: 'dialog' })
    doc.focusIn(field)

    clock.runAll()

    // The cancel still does its original job. Nothing yanks focus out of the
    // dialog that is currently on screen.
    expect(doc.activeElement).toBe(field)
    expect(doc.activeElement).not.toBe(trigger)
  })

  it('returns focus on a later close after an earlier one was cancelled', () => {
    const doc = new FakeDocument()
    const clock = fakeClock()
    const dialog = mountDialog(doc, clock)
    const { trigger } = openAndSubmit(doc, dialog)

    dialog.render(false)
    dialog.render(true) // cancels the first return

    // Second submit, same shape: focus is on the confirm, the confirm disables
    // itself, focus is on `<body>` again.
    doc.activeElement = doc.body

    dialog.render(false)
    clock.runAll()

    expect(doc.activeElement).toBe(trigger)
  })
})
