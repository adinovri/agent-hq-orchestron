/**
 * Turning a failed request into a sentence the operator can act on (NF27).
 *
 * Until now the web app had two halves of an error story and neither one
 * finished it. Most mutations threw ``HTTP ${res.status}: ${await res.text()}``
 * — which puts a raw JSON envelope in front of a human — and three did not
 * check `res.ok` at all, so a 500 arrived at `onSettled` indistinguishable
 * from a 200. `settleSessionAction`'s own doc comment named the gap and left
 * it: "none of the mutations on this page has an `onError`, so a failure
 * leaves the dialog open with the button back to `Reopen` and nothing said
 * about why."
 *
 * The two body shapes are not interchangeable, which is why this is a
 * function and not a field access:
 *
 *   • A route that *refuses* answers `{ error: string }`. Every one of them
 *     — 85 call sites in `apps/api/src/routes/sessions.ts`, no exceptions —
 *     and the string is the whole message ("Cannot delete a running session").
 *   • A route that *throws* is serialised by Fastify into
 *     `{ statusCode, error: 'Internal Server Error', message }`, where `error`
 *     is the generic class name and `message` is the only useful part.
 *
 * So `message` wins when present and `error` is the fallback — reading either
 * field alone gets one of the two cases wrong.
 */

/** Longest raw body we will paste into a dialog before cutting it short. */
const MAX_DETAIL = 300

function truncate(s: string): string {
  return s.length <= MAX_DETAIL ? s : `${s.slice(0, MAX_DETAIL - 1)}…`
}

/**
 * The human-readable part of an error body, or null if there isn't one.
 *
 * Null rather than a placeholder: the caller pairs it with the status code,
 * and "HTTP 502" on its own beats "HTTP 502: <!DOCTYPE html>". A proxy's HTML
 * error page and an empty body are both "no detail", not detail worth showing.
 */
export function extractApiErrorDetail(bodyText: string): string | null {
  const trimmed = bodyText.trim()
  if (!trimmed) return null

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (parsed && typeof parsed === 'object') {
      const body = parsed as Record<string, unknown>
      for (const key of ['message', 'error'] as const) {
        const value = body[key]
        if (typeof value === 'string' && value.trim()) return truncate(value.trim())
      }
      // Valid JSON with neither field — an object dumped at the operator is
      // worse than the status line alone.
      return null
    }
    if (typeof parsed === 'string' && parsed.trim()) return truncate(parsed.trim())
    return null
  } catch {
    // Not JSON. A gateway's HTML page is markup, not a message.
    if (trimmed.startsWith('<')) return null
    return truncate(trimmed)
  }
}

/** `HTTP 409: Cannot delete a running session`, or `HTTP 502` when the body
 *  carried nothing worth repeating. */
export function describeApiError(status: number, bodyText: string): string {
  const detail = extractApiErrorDetail(bodyText)
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`
}

/**
 * Throw `describeApiError` unless the response is ok; return it otherwise.
 *
 * One line at each call site is the point — the three mutations that skipped
 * the check skipped it because writing it out was four lines of ceremony
 * around a one-line happy path.
 *
 * `res.text()` is defended because it rejects on a body already consumed or a
 * connection cut mid-response, and an error *about* reading the error would
 * replace the status the caller already knows with a stack trace it doesn't.
 */
export async function throwIfNotOk(res: Response): Promise<Response> {
  if (res.ok) return res
  let body = ''
  try {
    body = await res.text()
  } catch {
    /* status alone, then */
  }
  throw new Error(describeApiError(res.status, body))
}

/**
 * What react-query handed `onError`, as a string fit for a dialog.
 *
 * Anything can land here: the `Error` thrown above, a `TypeError: Failed to
 * fetch` from a network that went away mid-request, or — if a `mutationFn`
 * ever rejects with a non-Error — something with no message at all. The last
 * case is why there is a fallback rather than `String(err)`, which renders
 * `[object Object]` into the UI.
 */
export function mutationErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return truncate(err.message.trim())
  if (typeof err === 'string' && err.trim()) return truncate(err.trim())
  return 'The request failed.'
}
