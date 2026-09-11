import { isInsideDialog } from './focus-return'
import type { FocusableLike, ScopedElement } from './focus-return'

/**
 * Remembering where the operator was before a dialog took focus (NF28).
 *
 * The obvious place to capture that is "when `open` flips true, read
 * `document.activeElement`". It does not work here, for two independent
 * reasons, and both of them bite on exactly the dialogs that matter most:
 *
 *   - React runs child effects before parent effects. `FloatingFocusManager`
 *     lives inside `DialogContent`, which is a *descendant* of the component
 *     that would be doing the capturing, so by the time a `useEffect` in the
 *     dialog component can look, Base UI has already moved focus into the
 *     popup and the answer is an element inside the thing being opened.
 *   - Two of the hand-rolled dialogs (Adopt, Spawn) put `autoFocus` on their
 *     first input, which React applies during the commit — again before the
 *     effect runs, again with the same wrong answer.
 *
 * Reading `document.activeElement` during render would dodge both, and is
 * where the first cut of this went; it is also a ref write during render,
 * which the React Compiler's rules reject outright and would silently
 * mis-optimise if the compiler is ever switched on.
 *
 * So: watch `focusin` on the document and keep the last element focused that
 * was *not* inside a dialog. It is immune to effect ordering because it is not
 * an effect, immune to `autoFocus` because that focus lands inside the dialog
 * and is filtered out, and it needs no capture step at open time at all — at
 * close time the tracker still holds the trigger, because nothing outside a
 * dialog could have taken focus while a modal one was up.
 *
 * This is also what the primitive underneath does: `FloatingFocusManager`
 * keeps its own module-level list of previously focused elements for the same
 * job. The difference is only which elements each one is willing to remember.
 *
 * The tracker is a factory over an injected host rather than a module
 * singleton with a hard `document` reference, so the whole thing is reachable
 * from a `node` vitest with a fake.
 */

/** A focus event, reduced to the one field this reads. */
export interface FocusInEvent {
  target: unknown
}

/** The slice of `document` the tracker listens on. */
export interface FocusOriginHost {
  body: unknown
  addEventListener(
    type: 'focusin',
    listener: (e: FocusInEvent) => void,
    options: { capture: true },
  ): void
  removeEventListener(
    type: 'focusin',
    listener: (e: FocusInEvent) => void,
    options: { capture: true },
  ): void
}

/** What the tracker remembers: something focusable it can also locate. */
export type FocusOrigin = FocusableLike & ScopedElement

export interface FocusOriginTracker {
  /**
   * Start listening if nobody was, and return the matching release. Refcounted
   * so ten dialogs share one listener and the last one out unhooks it.
   */
  retain(): () => void
  /** The last element focused outside any dialog, if there is one. */
  current(): FocusOrigin | null
}

function isFocusOrigin(value: unknown): value is FocusOrigin {
  if (value === null || typeof value !== 'object') return false
  const el = value as Partial<FocusOrigin>
  return typeof el.closest === 'function' && typeof el.focus === 'function'
}

export function createFocusOriginTracker(host: FocusOriginHost): FocusOriginTracker {
  let current: FocusOrigin | null = null
  let holders = 0

  const onFocusIn = (e: FocusInEvent): void => {
    const target = e.target
    if (!isFocusOrigin(target)) return
    // `<body>` is where focus lands when it has nowhere else to go. Recording
    // it would mean the audit "restores" focus to the exact state it exists
    // to correct.
    if (target === host.body) return
    if (isInsideDialog(target)) return
    current = target
  }

  return {
    retain(): () => void {
      holders += 1
      if (holders === 1) host.addEventListener('focusin', onFocusIn, { capture: true })
      return (): void => {
        holders -= 1
        if (holders > 0) return
        host.removeEventListener('focusin', onFocusIn, { capture: true })
        // Dropping the reference matters: without it the last dialog to
        // unmount leaves a detached element pinned for the life of the tab.
        current = null
      }
    },
    current(): FocusOrigin | null {
      return current
    },
  }
}
