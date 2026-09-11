'use client'

import { useEffect, useState } from 'react'
import { idleChipState, tickIntervalMs } from './idle-chip'

/**
 * The idle chip's live state — label, colour and tooltip — recomputed on a
 * clock of its own.
 *
 * Both chips used to call `idleChipState(session.idleSince, idleTimeoutMs)`
 * inline in JSX, which reads `Date.now()` at render time. Nothing re-rendered
 * them: the session list polls, but react-query's structural sharing returns
 * the identical `session` object when the payload has not changed, so a page
 * left open froze the chip at whatever it said when it first mounted — `idle
 * 0m`, grey, forever. The amber near-sleep warning was therefore unreachable
 * in the browser even though its arithmetic was right (NF16).
 *
 * `useTick`-style hooks usually take a fixed interval; this one derives it
 * from the server's threshold via `tickIntervalMs` so a 60s instance gets
 * second-resolution and a 15-minute instance is not re-rendered 900 times.
 *
 * Returns `null` when there is nothing to show, so the caller can render the
 * chip conditionally while still calling the hook unconditionally — pass
 * `null` for `idleSince` whenever the session is not in an idle state and the
 * interval is not armed at all.
 */
export function useIdleChip(
  idleSince: string | null | undefined,
  idleTimeoutMs: number,
): { idleMin: number; nearSleep: boolean; title: string } | null {
  const interval = tickIntervalMs(idleTimeoutMs)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!idleSince) return
    // Re-read on arm as well as on tick: `now` was captured when the component
    // first mounted, which may be long before this session went idle.
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(id)
  }, [idleSince, interval])

  if (!idleSince) return null
  return idleChipState(idleSince, idleTimeoutMs, now)
}
