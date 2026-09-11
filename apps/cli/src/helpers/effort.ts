/**
 * Effort enums, one per endpoint, because the API does not have one.
 *
 * `EffortLevel` in `@agent-hq-orchestron/shared` lists six levels, but no
 * single route accepts all six. Three different zod enums are in force:
 *
 * | route                                   | accepts                          |
 * |-----------------------------------------|----------------------------------|
 * | `POST /api/sessions` (spawn)            | low high medium xhigh max ultra  |
 * | `POST /api/sessions/:id/{reopen,respawn,clone}` | …no `ultra`               |
 * | `POST /api/sessions/adopt[/validate]`   | …no `xhigh`, no `max`            |
 * | `PATCH /api/sessions/:id` (metadata)    | …no `ultra`                      |
 * | `POST|PATCH /api/schedules`             | all six                          |
 * | `POST|PATCH /api/projects`              | all six                          |
 *
 * The API is the source of truth and this file does not try to widen it. What
 * it removes is the misleading 400: a rejected `--effort ultra` on `reopen`
 * came back as a flattened zod dump naming `effort` with no hint that the
 * same word is legal on `spawn`, which reads like a typo rather than a
 * per-route difference. Validating locally also means a rejected value sends
 * **no request at all**, which is what an unattended caller needs.
 *
 * Each list is transcribed from the zod enum it mirrors; a route that widens
 * its enum has to be reflected here, and the live-API test asserts every
 * level in every list is actually accepted by the route it is filed under.
 */

/** Which endpoint a value is bound for. */
export type EffortEndpoint = 'spawn' | 'revival' | 'adopt' | 'metadata' | 'schedule' | 'project'

const ALL_SIX = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const

export const EFFORT_BY_ENDPOINT: Record<EffortEndpoint, readonly string[]> = {
  spawn: ALL_SIX,
  revival: ['low', 'medium', 'high', 'xhigh', 'max'],
  adopt: ['low', 'medium', 'high', 'ultra'],
  metadata: ['low', 'medium', 'high', 'xhigh', 'max'],
  schedule: ALL_SIX,
  project: ALL_SIX,
}

/** Human label for the route, used in the error so the reader knows which of
 *  the several enums they just hit. */
const ENDPOINT_LABEL: Record<EffortEndpoint, string> = {
  spawn: 'session spawn',
  revival: 'reopen / respawn / fork',
  adopt: 'session adopt',
  metadata: 'session metadata',
  schedule: 'schedules',
  project: 'projects',
}

/**
 * Throw unless `value` is a level this endpoint accepts.
 *
 * `undefined` passes (the flag was not given) and so does `''` when
 * `allowClear` is set — the metadata and schedule routes spell "unset this"
 * as the empty string, which is not a level and must not be enum-checked.
 *
 * The message names the levels that *are* accepted here and, when the value
 * is a real level that some other route takes, says so — that difference is
 * the whole reason the 400 was confusing.
 */
export function assertEffort(
  value: string | undefined,
  endpoint: EffortEndpoint,
  { allowClear = false, flag = '--effort' }: { allowClear?: boolean; flag?: string } = {},
): void {
  if (value === undefined) return
  if (value === '' && allowClear) return

  const accepted = EFFORT_BY_ENDPOINT[endpoint]
  if (accepted.includes(value)) return

  const known = (ALL_SIX as readonly string[]).includes(value)
  const detail = known
    ? ` — ${JSON.stringify(value)} is a valid effort level, but not on this endpoint`
    : ''
  throw new Error(
    `${flag} ${JSON.stringify(value)} is not accepted by ${ENDPOINT_LABEL[endpoint]}${detail}. ` +
      `Accepted here: ${accepted.join(', ')}${allowClear ? ', or "" to clear' : ''}.`,
  )
}

/** The `--effort` flag's help text, spelled from the same list so the help
 *  and the validation can never drift apart. */
export function effortHelp(endpoint: EffortEndpoint, { allowClear = false } = {}): string {
  return `Reasoning effort: ${EFFORT_BY_ENDPOINT[endpoint].join('|')}${allowClear ? ' (or "" to clear)' : ''}`
}
