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
