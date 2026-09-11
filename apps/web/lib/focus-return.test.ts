import { describe, it, expect } from 'vitest'
import {
  focusIsAdrift,
  isInsideDialog,
  resolveFocusReturn,
  auditFocusReturn,
  scheduleFocusReturn,
  DIALOG_SCOPE_SELECTOR,
  FOCUS_RETURN_PASSES_MS,
  FOCUS_FALLBACK_SELECTOR,
  type DocumentLike,
  type FocusableLike,
} from './focus-return'
import { createFocusOriginTracker, type FocusInEvent, type FocusOriginHost } from './focus-origin'

/**
 * A document small enough to reason about and real enough to fail honestly.
 *
 * `activeElement` is modelled as state rather than asserted through a `focus`
 * spy because the assertion NF28 actually cares about is
 * `document.activeElement === <the trigger>`, not "`focus()` was called on
 * something". Those two come apart in precisely the case that matters:
 * focusing a disabled or detached element calls the method and moves nothing.
 * Here it moves nothing either.
 */
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
    // A browser refuses all three of these silently and leaves focus where it
    // was — which in this bug's timeline means `<body>`.
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
    for (let el: FakeElement | null = this; el; el = el.parent) {
      if (el.attrs.get('role') === 'dialog') return el
      if (el.attrs.get('data-slot') === 'dialog-content') return el
    }
    return null
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

const NATIVE = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'])

class FakeDocument implements DocumentLike, FocusOriginHost {
  body: FakeElement
  activeElement: FocusableLike | null
  private byTag = new Map<string, FakeElement>()
  private listeners: ((e: FocusInEvent) => void)[] = []

  constructor() {
    this.body = new FakeElement('BODY', this)
    this.activeElement = this.body
  }

  put(selector: string, el: FakeElement): void {
    this.byTag.set(selector, el)
  }

  querySelector(selectors: string): FocusableLike | null {
    const el = this.byTag.get(selectors)
    if (!el || !el.isConnected) return null
    return el
  }

  addEventListener(_t: 'focusin', listener: (e: FocusInEvent) => void): void {
    this.listeners.push(listener)
  }
  removeEventListener(_t: 'focusin', listener: (e: FocusInEvent) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener)
  }
  get listenerCount(): number {
    return this.listeners.length
  }

  /** Focus `el` the way a browser would, and fire `focusin` for it. */
  focusIn(el: FakeElement): void {
    this.activeElement = el
    this.dispatchFocusIn(el)
  }

  /** Fire `focusin` with an arbitrary target, element or not. */
  dispatchFocusIn(target: unknown): void {
    for (const l of [...this.listeners]) l({ target })
  }

  button(attrs: Record<string, string> = {}): FakeElement {
    return new FakeElement('BUTTON', this, attrs)
  }
  main(): FakeElement {
    const el = new FakeElement('MAIN', this)
    this.put(FOCUS_FALLBACK_SELECTOR, el)
    return el
  }
  /** A panel plus a button inside it, as either dialog family renders. */
  dialog(marker: 'role' | 'slot'): { panel: FakeElement; confirm: FakeElement } {
    const panel = new FakeElement(
      'DIV',
      this,
      marker === 'role' ? { role: 'dialog' } : { 'data-slot': 'dialog-content' },
    )
    const confirm = this.button()
    confirm.parent = panel
    return { panel, confirm }
  }
}

/** A scheduler that runs nothing until told, so pass timing is observable. */
function fakeScheduler() {
  const queued: { ms: number; fn: () => void; cancelled: boolean }[] = []
  const schedule = (fn: () => void, ms: number): (() => void) => {
    const entry = { ms, fn, cancelled: false }
    queued.push(entry)
    return () => {
      entry.cancelled = true
    }
  }
  const runAt = (ms: number): void => {
    for (const e of queued) if (e.ms === ms && !e.cancelled) e.fn()
  }
  return { schedule, runAt, queued }
}

describe('isInsideDialog', () => {
  it('recognises a hand-rolled panel by its role', () => {
    const doc = new FakeDocument()
    const { confirm } = doc.dialog('role')
    expect(isInsideDialog(confirm)).toBe(true)
  })

  it('recognises a Base UI popup by the slot DialogContent stamps on it', () => {
    const doc = new FakeDocument()
    const { confirm } = doc.dialog('slot')
    expect(isInsideDialog(confirm)).toBe(true)
  })

  it('leaves an ordinary page button outside', () => {
    const doc = new FakeDocument()
    expect(isInsideDialog(doc.button())).toBe(false)
  })
})

describe('focusIsAdrift', () => {
  it('is true on <body>', () => {
    expect(focusIsAdrift(new FakeDocument())).toBe(true)
  })

  it('is true with no active element', () => {
    const doc = new FakeDocument()
    doc.activeElement = null
    expect(focusIsAdrift(doc)).toBe(true)
  })

  it('is false once focus is on a real element', () => {
    const doc = new FakeDocument()
    doc.activeElement = doc.button()
    expect(focusIsAdrift(doc)).toBe(false)
  })
})

describe('resolveFocusReturn', () => {
  it('prefers the origin', () => {
    const doc = new FakeDocument()
    const trigger = doc.button()
    doc.main()
    expect(resolveFocusReturn(trigger, doc)).toBe(trigger)
  })

  it('falls back to the landmark when the origin left the document', () => {
    const doc = new FakeDocument()
    const trigger = doc.button()
    const main = doc.main()
    trigger.isConnected = false
    expect(resolveFocusReturn(trigger, doc)).toBe(main)
  })

  it('falls back when the origin is still disabled from the mutation', () => {
    const doc = new FakeDocument()
    const confirm = doc.button({ disabled: '' })
    const main = doc.main()
    expect(resolveFocusReturn(confirm, doc)).toBe(main)
  })

  it('falls back when there was no origin to begin with', () => {
    const doc = new FakeDocument()
    const main = doc.main()
    expect(resolveFocusReturn(null, doc)).toBe(main)
  })

  it('gives up rather than inventing a target when the landmark is gone', () => {
    const doc = new FakeDocument()
    expect(resolveFocusReturn(null, doc)).toBeNull()
  })
})

describe('auditFocusReturn', () => {
  it('the NF28 case: submit closes the dialog and focus comes back to the trigger', () => {
    const doc = new FakeDocument()
    const trigger = doc.button()
    doc.main()

    // Operator clicks the trigger; the dialog opens.
    doc.activeElement = trigger

    // Operator clicks Confirm, which disables itself, so the browser drops
    // focus. Then the mutation succeeds and the dialog unmounts.
    doc.activeElement = doc.body
    expect(focusIsAdrift(doc)).toBe(true)

    auditFocusReturn(trigger, doc)
    expect(doc.activeElement).toBe(trigger)
    expect(doc.activeElement).not.toBe(doc.body)
  })

  it('leaves focus alone when the primitive already restored it', () => {
    const doc = new FakeDocument()
    const trigger = doc.button()
    const elsewhere = doc.button()
    doc.main()

    doc.activeElement = elsewhere
    expect(auditFocusReturn(trigger, doc)).toBeNull()
    expect(doc.activeElement).toBe(elsewhere)
  })

  it('lands on the landmark when success unmounted the trigger', () => {
    const doc = new FakeDocument()
    const trigger = doc.button()
    const main = doc.main()

    trigger.isConnected = false
    doc.activeElement = doc.body

    expect(auditFocusReturn(trigger, doc)).toBe(main)
    expect(doc.activeElement).toBe(main)
  })

  it('makes the landmark focusable without putting it in the tab order', () => {
    const doc = new FakeDocument()
    const main = doc.main()
    expect(main.getAttribute('tabindex')).toBeNull()

    auditFocusReturn(null, doc)
    expect(main.getAttribute('tabindex')).toBe('-1')
  })

  it('does not add a tabindex to a natively focusable origin', () => {
    const doc = new FakeDocument()
    const trigger = doc.button()
    doc.activeElement = doc.body

    auditFocusReturn(trigger, doc)
    expect(trigger.getAttribute('tabindex')).toBeNull()
    expect(doc.activeElement).toBe(trigger)
  })

  it('does not strand focus on a confirm button that is still disabled', () => {
    const doc = new FakeDocument()
    const confirm = doc.button()
    const main = doc.main()

    // `pending` is still true when the audit runs, so the button it would
    // return to is disabled. Focusing it would move nothing.
    confirm.setAttribute('disabled', '')
    doc.activeElement = doc.body

    auditFocusReturn(confirm, doc)
    expect(doc.activeElement).toBe(main)
    expect(doc.activeElement).not.toBe(doc.body)
  })

  it('reports doing nothing when there is nowhere to go', () => {
    const doc = new FakeDocument()
    expect(auditFocusReturn(null, doc)).toBeNull()
    expect(doc.activeElement).toBe(doc.body)
  })
})

describe('scheduleFocusReturn', () => {
  it('queues one pass per configured delay', () => {
    const doc = new FakeDocument()
    const { schedule, queued } = fakeScheduler()
    scheduleFocusReturn(null, doc, schedule)
    expect(queued.map((q) => q.ms)).toEqual([...FOCUS_RETURN_PASSES_MS])
  })

  it('the immediate pass fixes a hand-rolled dialog', () => {
    const doc = new FakeDocument()
    const trigger = doc.button()
    doc.main()
    doc.activeElement = doc.body

    const { schedule, runAt } = fakeScheduler()
    scheduleFocusReturn(trigger, doc, schedule)

    runAt(0)
    expect(doc.activeElement).toBe(trigger)
  })

  it('the late pass catches a primitive that dropped focus after its exit transition', () => {
    const doc = new FakeDocument()
    const trigger = doc.button()
    doc.main()
    doc.activeElement = doc.body

    const { schedule, runAt } = fakeScheduler()
    scheduleFocusReturn(trigger, doc, schedule)

    runAt(0)
    expect(doc.activeElement).toBe(trigger)

    // Base UI's own restore runs when the popup finally unmounts, finds
    // nothing it can use, and leaves focus on <body>.
    doc.activeElement = doc.body
    runAt(250)
    expect(doc.activeElement).toBe(trigger)
  })

  it('the late pass stays out of the way when focus is already somewhere real', () => {
    const doc = new FakeDocument()
    const trigger = doc.button()
    const elsewhere = doc.button()
    doc.main()
    doc.activeElement = doc.body

    const { schedule, runAt } = fakeScheduler()
    scheduleFocusReturn(trigger, doc, schedule)

    runAt(0)
    doc.activeElement = elsewhere
    runAt(250)
    expect(doc.activeElement).toBe(elsewhere)
  })

  it('cancelling stops a reopened dialog from having focus pulled out of it', () => {
    const doc = new FakeDocument()
    const trigger = doc.button()
    const inside = doc.button()
    doc.main()
    doc.activeElement = doc.body

    const { schedule, runAt } = fakeScheduler()
    const cancel = scheduleFocusReturn(trigger, doc, schedule)

    // Reopened before either pass landed; focus is now inside the dialog.
    cancel()
    doc.activeElement = inside

    runAt(0)
    runAt(250)
    expect(doc.activeElement).toBe(inside)
  })
})

describe('createFocusOriginTracker', () => {
  it('remembers the trigger the operator focused on the page', () => {
    const doc = new FakeDocument()
    const tracker = createFocusOriginTracker(doc)
    tracker.retain()

    const trigger = doc.button()
    doc.focusIn(trigger)
    expect(tracker.current()).toBe(trigger)
  })

  it('ignores focus moving inside the dialog — including autoFocus on its first input', () => {
    const doc = new FakeDocument()
    const tracker = createFocusOriginTracker(doc)
    tracker.retain()

    const trigger = doc.button()
    doc.focusIn(trigger)

    // The dialog opens and focuses its own first field. This is the moment an
    // open-time `useEffect` capture would have recorded the wrong element.
    const { confirm } = doc.dialog('role')
    doc.focusIn(confirm)

    expect(tracker.current()).toBe(trigger)
  })

  it('ignores the Base UI popup too', () => {
    const doc = new FakeDocument()
    const tracker = createFocusOriginTracker(doc)
    tracker.retain()

    const trigger = doc.button()
    doc.focusIn(trigger)
    doc.focusIn(doc.dialog('slot').confirm)

    expect(tracker.current()).toBe(trigger)
  })

  it('never records <body>, which is the state it exists to correct', () => {
    const doc = new FakeDocument()
    const tracker = createFocusOriginTracker(doc)
    tracker.retain()

    const trigger = doc.button()
    doc.focusIn(trigger)
    doc.focusIn(doc.body)

    expect(tracker.current()).toBe(trigger)
  })

  it('starts with nothing to offer, so the audit falls back to the landmark', () => {
    const doc = new FakeDocument()
    const tracker = createFocusOriginTracker(doc)
    tracker.retain()
    expect(tracker.current()).toBeNull()
  })

  it('shares one listener across every dialog and unhooks on the last release', () => {
    const doc = new FakeDocument()
    const tracker = createFocusOriginTracker(doc)
    expect(doc.listenerCount).toBe(0)

    const releases = [tracker.retain(), tracker.retain(), tracker.retain()]
    expect(doc.listenerCount).toBe(1)

    releases[0]()
    releases[1]()
    expect(doc.listenerCount).toBe(1)

    releases[2]()
    expect(doc.listenerCount).toBe(0)
  })

  it('drops the remembered element on the last release rather than pinning it', () => {
    const doc = new FakeDocument()
    const tracker = createFocusOriginTracker(doc)
    const release = tracker.retain()

    doc.focusIn(doc.button())
    expect(tracker.current()).not.toBeNull()

    release()
    expect(tracker.current()).toBeNull()
  })

  it('ignores a focus event whose target is not an element', () => {
    const doc = new FakeDocument()
    const tracker = createFocusOriginTracker(doc)
    tracker.retain()

    const trigger = doc.button()
    doc.focusIn(trigger)

    // `focusin` can arrive with a target that is not an element at all — the
    // document, the window, or nothing. None of them may displace the trigger.
    for (const target of [null, undefined, 'window', {}, { closest: 'not a function' }]) {
      doc.dispatchFocusIn(target)
    }
    expect(tracker.current()).toBe(trigger)
  })
})
