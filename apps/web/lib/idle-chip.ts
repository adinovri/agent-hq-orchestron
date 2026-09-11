/**
 * Idle-chip arithmetic, in one place, reading the server's real threshold.
 *
 * Both chips used to hardcode `"Auto-sleeps at 15 min."` and an amber warning
 * at `idleMin >= 10` — the schema default, not the value in force. On the E2E
 * instance `idleTimeoutMs` is 60000 and sessions slept in about a minute, so
 * the tooltip stated a threshold 15x off and the amber warning, meant to fire
 * five minutes before sleep, never fired at all (NF14). `idleTimeoutMs` now
 * ships on `/api/health/detail`; these functions format it.
 *
 * Pure and in `lib/` because apps/web's vitest runs node-only over
 * `lib/**\/*.test.ts` — logic that needs a test cannot live in a component.
 */

/** Schema default from `packages/shared/src/config.ts`. Used only when the
 *  health fetch has not landed or the server predates the field — never as a
 *  claim about the running instance. */
export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000

/**
 * A duration as an operator would say it: `45s`, `1 min`, `15 min`, `1h 30m`.
 *
 * Sub-minute matters here — the whole finding was an instance running 60s —
 * so it does not round everything into minutes the way the old string did.
 */
export function formatIdleTimeout(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'disabled'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.round(totalSec / 60)
  if (totalMin < 60) return `${totalMin} min`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/**
 * The chip's `title`.
 *
 * `idleTimeoutMs` of 0 means auto-sleep is off (the schema allows it), and a
 * tooltip promising a sleep that will never come is worse than saying nothing
 * about it — so that case states the fact instead.
 */
export function formatIdleTooltip(idleSince: string | Date, idleTimeoutMs: number): string {
  const since = idleSince instanceof Date ? idleSince : new Date(idleSince)
  const stamp = Number.isNaN(since.getTime()) ? 'unknown' : since.toLocaleTimeString()
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
    return `Idle since ${stamp}. Auto-sleep is disabled on this server.`
  }
  return `Idle since ${stamp}. Auto-sleeps at ${formatIdleTimeout(idleTimeoutMs)}.`
}

/**
 * Should the chip go amber?
 *
 * The old rule was a bare `idleMin >= 10`, which reads as "five minutes left"
 * only against the 15-minute default. Expressed as remaining time it keeps
 * that behaviour exactly (15 min − 5 min = 10 min) and degrades sensibly:
 * a 60s timeout warns at 40s in, with 20s left, rather than never.
 *
 * `WARN_LEAD_MS` caps the lead so a long timeout does not spend hours amber.
 */
export const WARN_LEAD_MS = 5 * 60 * 1000

export function isNearSleep(idleMs: number, idleTimeoutMs: number): boolean {
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return false
  const lead = Math.min(WARN_LEAD_MS, idleTimeoutMs / 3)
  return idleMs >= idleTimeoutMs - lead
}

/** Everything a chip needs, from one `idleSince` and the server's threshold. */
export function idleChipState(
  idleSince: string | Date,
  idleTimeoutMs: number,
  now: number = Date.now(),
): { idleMin: number; nearSleep: boolean; title: string } {
  const since = idleSince instanceof Date ? idleSince : new Date(idleSince)
  const idleMs = Math.max(0, now - since.getTime())
  return {
    idleMin: Math.floor(idleMs / 60_000),
    nearSleep: isNearSleep(idleMs, idleTimeoutMs),
    title: formatIdleTooltip(since, idleTimeoutMs),
  }
}

/**
 * How often a chip showing this threshold has to re-render to stay honest.
 *
 * The chip used to be computed once, during the render that first showed it,
 * and then never again: react-query's structural sharing hands back the *same*
 * `session` object when a poll finds nothing changed, so `refetchInterval`
 * re-fetched but re-rendered nothing. A page left open showed `idle 0m` and a
 * grey chip indefinitely, and the amber warning — whose arithmetic is correct
 * and unit-pinned above — never actually appeared on screen (NF16).
 *
 * So the chip needs a clock of its own. One tick per second on a 15-minute
 * instance is 900 pointless renders per chip; one tick per minute on the 60s
 * E2E instance would miss the amber window entirely. Scaling with the
 * threshold gives both ends what they need: 1s at 60s, 15s at 15 min.
 *
 * The bounds are the interesting part, not the divisor — `MIN_TICK_MS` stops a
 * pathologically small timeout from spinning the render loop, `MAX_TICK_MS`
 * keeps the `idle Nm` counter within 15s of the truth however long the
 * threshold is.
 */
export const MIN_TICK_MS = 1_000
export const MAX_TICK_MS = 15_000

export function tickIntervalMs(idleTimeoutMs: number): number {
  // Auto-sleep off: nothing to count down to, but `idle Nm` still ages, and a
  // minute-resolution counter is served fine by the slowest tick.
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return MAX_TICK_MS
  return Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, Math.round(idleTimeoutMs / 60)))
}
