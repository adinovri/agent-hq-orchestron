'use client'

import { useSyncExternalStore } from 'react'

/**
 * Transient, app-wide notices ("the server did something you did not ask
 * for") rendered as a stack of toasts by <NoticeToast />.
 *
 * A tiny module-level pub/sub rather than a state library, because the
 * publisher is almost always a mutation callback — not a component — and it
 * has to work from outside the React tree. zustand is in package.json but
 * nothing else in the app uses it; a five-line emitter keeps this in the
 * same plain-React idiom as the rest of the components.
 */

export interface Notice {
  id: number
  /** One-line headline. Required. */
  text: string
  /** Optional second line, smaller — a hint or a pointer at config. */
  detail?: string
  /** 'info' reads neutral, 'warn' amber, 'error' red. Coercions are
   *  warnings: nothing failed, but the user got something other than what
   *  they configured. 'error' is for a request that did not happen at all —
   *  an action with no dialog to keep open has nowhere else to say so
   *  (NF27). */
  tone: 'info' | 'warn' | 'error'
}

/** How long a notice stays up before it retires itself. Long enough to read
 *  two lines without hunting for the close button. */
export const NOTICE_TTL_MS = 8_000

let nextId = 1
let notices: Notice[] = []
const listeners = new Set<() => void>()

/** Stable empty snapshot. useSyncExternalStore compares by identity and
 *  will loop forever if the server snapshot is a fresh `[]` each call. */
const EMPTY: Notice[] = []

function emit() {
  listeners.forEach(l => l())
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => { listeners.delete(onChange) }
}

/**
 * Raise a notice. Returns its id so a caller can dismiss it early.
 *
 * Deduplicates on text + detail: a bulk action that coerces five spawns
 * should say so once, not stack five identical toasts.
 */
export function pushNotice(
  text: string,
  opts: { detail?: string; tone?: Notice['tone'] } = {},
): number {
  const existing = notices.find(n => n.text === text && n.detail === opts.detail)
  if (existing) return existing.id
  const notice: Notice = {
    id: nextId++,
    text,
    ...(opts.detail === undefined ? {} : { detail: opts.detail }),
    tone: opts.tone ?? 'info',
  }
  notices = [...notices, notice]
  emit()
  return notice.id
}

export function dismissNotice(id: number): void {
  const next = notices.filter(n => n.id !== id)
  if (next.length === notices.length) return
  notices = next
  emit()
}

/**
 * Subscribe a component to the live notice stack.
 *
 * useSyncExternalStore rather than useState+useEffect: the store lives
 * outside React, and the effect version both trips
 * react-hooks/set-state-in-effect and can miss a notice pushed between
 * module load and the effect running. Every mutation replaces the array,
 * so identity comparison is the correct change signal.
 *
 * Notices are client-only — the server snapshot is always empty, which
 * also keeps hydration from rendering a toast the server never saw.
 */
export function useNotices(): Notice[] {
  return useSyncExternalStore(subscribe, () => notices, () => EMPTY)
}

/**
 * Display copy for a headless coercion.
 *
 * Web-local, like every other piece of UI copy in this app. The *wire*
 * value is shared (`HEADLESS_COERCED_REASON`, which is what lands in the
 * response body and the API log) and is not shown to anyone — importing
 * the string from shared would pull its config module, and `node:fs`
 * with it, into the client bundle.
 */
export const HEADLESS_COERCED_TITLE =
  'Headless mode is disabled globally — this session runs in tmux.'
export const HEADLESS_COERCED_DETAIL =
  'set enableHeadlessMode: true in ~/.orchestron/config.json'

/**
 * Raise the standard notice for a mutation the server coerced.
 *
 * Mutation responses carry `coerced` only when the server overrode the
 * request, so `body?.coerced` is the whole condition — no value inspection
 * and no import needed to read it.
 *
 * Call it with any parsed response body; it no-ops on one without the
 * field, which keeps the call sites down to a single line each.
 */
export function noticeIfCoerced(body: unknown): void {
  const coerced = (body as { coerced?: { useTmux?: boolean } } | null | undefined)?.coerced
  if (!coerced?.useTmux) return
  pushNotice(HEADLESS_COERCED_TITLE, {
    detail: HEADLESS_COERCED_DETAIL,
    tone: 'warn',
  })
}

/**
 * Report a mutation that failed, for an action with no dialog of its own.
 *
 * Archive (the header's ✓, "mark as succeeded") and the dashboard's per-row
 * Kill both fire straight from a button. There is no form left on screen to
 * hold an inline error, so before NF27 a 500 from either was completely
 * invisible: the spinner stopped, the row did not change, and nothing said
 * why. The toast is the smallest surface that can carry the reason.
 *
 * Dialog-bearing mutations do not use this — they keep the dialog open and
 * put the same message inside it, next to the retry button.
 */
export function noticeMutationError(action: string, detail: string): number {
  return pushNotice(`${action} failed.`, { detail, tone: 'error' })
}
