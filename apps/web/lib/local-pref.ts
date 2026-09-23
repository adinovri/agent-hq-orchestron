/**
 * localStorage-backed UI preferences, shaped for `useSyncExternalStore`.
 *
 * These values cannot be read during render: `localStorage` is impure, and on
 * the server it does not exist at all. The usual workaround is a mount effect
 * that reads the value and sets state, which costs a second render pass and
 * makes the first painted frame show the default rather than the preference —
 * a group-by toggle that visibly flips, a collapsed section that unfolds and
 * folds again.
 *
 * `useSyncExternalStore` is the API built for this case. It takes a server
 * snapshot (the default), a client snapshot (the stored value) and a
 * subscription, and React reads through it without an extra pass. The one
 * piece it cannot supply is change notification: a `setItem` in this tab
 * fires no `storage` event — that event is for *other* tabs — so writers here
 * notify the subscribers by hand.
 *
 * Every snapshot returned through this module must be a primitive or a cached
 * reference. React calls `getSnapshot` on each render and re-renders when the
 * result differs by `Object.is`, so returning a fresh object or Set each time
 * is an infinite loop. Callers derive a boolean or a string from the stored
 * value rather than handing back the parsed structure.
 */

type Listener = () => void

const listeners = new Set<Listener>()

/** Subscribe to same-tab preference writes. Pass directly as the first
 *  argument of `useSyncExternalStore` — it is referentially stable, which
 *  keeps React from resubscribing on every render. */
export function subscribeLocalPref(onChange: Listener): () => void {
  listeners.add(onChange)
  return () => { listeners.delete(onChange) }
}

/** Tell subscribers the stored value changed. Only needed for writes that do
 *  not go through `writeLocalPref` — one that serialises its own structure,
 *  for instance. */
export function notifyLocalPrefChange(): void {
  for (const listener of Array.from(listeners)) listener()
}

/** The raw stored string, or null when absent, blocked or unreadable.
 *  Private-mode and disabled-storage browsers throw on access rather than
 *  returning null, so the read is guarded. */
export function readLocalPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Store a value and notify. A blocked write is not an error worth surfacing:
 *  the preference simply does not persist, and the session keeps working. */
export function writeLocalPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch { /* private mode / storage disabled */ }
  notifyLocalPrefChange()
}
