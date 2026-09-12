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

/* ------------------------------------------------------------------------ *
 * That every failure path says which status it was (NF34).
 * ------------------------------------------------------------------------ */

/**
 * NF27 gave the app one way to describe a failed request. It did not make that
 * the only way: most call sites still hand-roll ``HTTP ${res.status}: ${await
 * res.text()}``, which the batch-17 commit deliberately left alone because
 * changing the *text* changes what live E2E scenarios assert.
 *
 * The cost of that fork showed up as NF34. Import's hand-rolled check was
 * wrong twice — it omitted the prefix entirely, so a failed import rendered a
 * bare JSON blob and an operator could not tell a 404 from a 500 without
 * devtools; and its `throw` sat inside the `try` meant to parse the body, so
 * its own `catch` swallowed the parsed message and re-threw the raw text. The
 * JSON branch was unreachable from the day it was written.
 *
 * Both are the same root fact: a hand-rolled check is unreviewed code on a
 * path nobody exercises. This scanner does not force `throwIfNotOk` — the
 * remaining sites are a deliberate deferral, not a bug — but it does hold the
 * one property they all share and Import had lost: **if you check `.ok`
 * yourself, the message you throw names the status.**
 */

/** `if (!res.ok)`, `if (!upRes.ok && …)` — a hand-rolled status check. */
const OK_GUARD = /\bif\s*\(\s*!\w+\.ok\b/
/** The prefix that makes a message legible as an HTTP failure. */
const NAMES_THE_STATUS = /HTTP \$\{/

export interface UnprefixedErrorThrow {
  file: string
  line: number
  snippet: string
}

/**
 * Every `throw` under a hand-rolled `.ok` check whose message omits the status.
 *
 * The guarded region is taken by brace depth from the guard line, so a
 * one-line `if (!res.ok) throw …` and a ten-line block with a nested
 * `try`/`catch` are both covered — the nesting is exactly what hid NF34's
 * second half from review.
 */
export function findUnprefixedErrorThrows(file: string, source: string): UnprefixedErrorThrow[] {
  const lines = source.split('\n')
  const found: UnprefixedErrorThrow[] = []

  for (let i = 0; i < lines.length; i++) {
    if (!OK_GUARD.test(lines[i])) continue

    // The guard's body: the rest of its line, then to brace balance.
    let depth = 0
    let started = false
    for (let j = i; j < lines.length; j++) {
      const line = lines[j]
      for (const ch of line) {
        if (ch === '{') { depth++; started = true }
        else if (ch === '}') depth--
      }
      if (/\bthrow new Error\(/.test(line) && !NAMES_THE_STATUS.test(line)) {
        found.push({ file, line: j + 1, snippet: line.trim() })
      }
      if (started && depth <= 0) break
      if (!started && j > i) break // one-liner with no block
    }
  }

  return found
}
