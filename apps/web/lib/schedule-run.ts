/**
 * Where a "Run now" click should leave the user.
 *
 * POST /api/schedules/:id/run answers `{ ok: true }` and adds
 * `sessionUuid` only when the fire actually produced a session id. Keeping
 * the decision in a pure function here — rather than inline in the mutation
 * callback — is what makes it testable: apps/web's vitest suite is node-only
 * and covers `lib/`, not component rendering.
 */

import { sessionHref } from './session-href'

export interface ScheduleRunResponse {
  ok?: boolean
  sessionUuid?: unknown
}

/**
 * The href to navigate to after a one-off run, or `null` to stay put.
 *
 * `null` on anything unexpected — no body, no `sessionUuid`, a non-string —
 * because an older API (or a spawn path whose response carries no id) still
 * ran the schedule successfully. Staying on the list and refreshing it is the
 * pre-existing behaviour and remains the correct fallback; navigating to
 * `/session/undefined` would not be.
 */
export function scheduleRunHref(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  // The id lands straight in a path segment, so `sessionHref` — shared with
  // the spawn dialog — is what refuses anything a UUID never contains.
  return sessionHref((body as ScheduleRunResponse).sessionUuid)
}
