/**
 * session-arg.mjs — validate typed positional arguments that probes read
 * before opening a browser or making an API call.
 *
 * NF41 (post-batch-21): three probes hand-rolled argv[2] and accepted the
 * wrong type, producing one wrong verdict, one raw ENOENT stack, and one
 * Playwright viewport crash. The fix is the same lesson as NF40's
 * `env-file.mjs`: an argument a probe does not honour should be caught at
 * the door, not discovered after thirty seconds of browser time.
 *
 *   detail01.mjs     — `process.argv[2]` used as a session uuid with no
 *                       shape check; `./env.json` was accepted, navigated to
 *                       `/session/./env.json`, and returned `{groups:[]}` —
 *                       the exact output of the known DETAIL-01 locator bug,
 *                       making it indistinguishable from a real regression.
 *
 *   smoke-ui.mjs     — `fs.readFileSync(process.argv[2], 'utf8')` with no
 *                       guard; missing arg → `ERR_INVALID_ARG_TYPE` from fs,
 *                       not a sentence. Fixed by `env-file.mjs`, see below.
 *
 *   nf37-verify.mjs  — `Number(process.argv[2] || 1680)` with no shape
 *                       check; `./env.json` → `NaN` → Playwright
 *                       `viewport.width: expected integer, got float NaN`.
 *
 * `resolveSessionArg`   — uuid-shaped positional, any slot.
 * `resolveViewportWidth`— optional integer positional; rejects non-integers.
 *
 * Both are pure (no fs, no network) so they are unit-testable offline.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Resolve and validate a session uuid positional argument.
 *
 * @param {string[]} argv    `process.argv` verbatim.
 * @param {object}   opts
 * @param {string}   opts.caller  Probe filename for error messages.
 * @param {number}   opts.slot    argv index of the uuid (default 2 — the
 *                                first positional after node + script).
 */
export function resolveSessionArg(argv, { caller = 'probe', slot = 2 } = {}) {
  if (!Array.isArray(argv)) throw new TypeError('resolveSessionArg: argv must be an array')
  if (!Number.isInteger(slot) || slot < 2) {
    throw new TypeError(`resolveSessionArg: slot must be an integer >= 2, got ${slot}`)
  }
  const arg = argv[slot]
  if (arg === undefined || arg === null || arg.length === 0) {
    const pos = slot - 1
    throw new Error(
      `${caller}: session uuid required as positional argument ${pos}` +
      ` — usage: node ${caller} <session-uuid>`,
    )
  }
  if (!UUID_RE.test(arg)) {
    const suffix = /^[./]/.test(arg)
      ? ' — looks like a file path; pass a uuid instead'
      : ''
    throw new Error(
      `${caller}: positional argument ${slot - 1} must be a session uuid` +
      ` (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx), got ${JSON.stringify(arg)}${suffix}`,
    )
  }
  return arg
}

/**
 * Resolve and validate an optional integer positional argument.
 *
 * Returns `fallback` when the argument is absent, throws when it is present
 * but is not a valid integer (e.g. a file path passed by mistake).
 *
 * @param {string[]} argv    `process.argv` verbatim.
 * @param {object}   opts
 * @param {string}   opts.caller    Probe filename for error messages.
 * @param {string}   opts.name      Human-readable name of the value.
 * @param {number}   opts.slot      argv index (default 2).
 * @param {number}   opts.fallback  Value when argument is absent.
 */
export function resolveViewportWidth(argv, { caller = 'probe', name = 'viewport width', slot = 2, fallback = 1680 } = {}) {
  if (!Array.isArray(argv)) throw new TypeError('resolveViewportWidth: argv must be an array')
  if (!Number.isInteger(slot) || slot < 2) {
    throw new TypeError(`resolveViewportWidth: slot must be an integer >= 2, got ${slot}`)
  }
  const arg = argv[slot]
  if (arg === undefined || arg === null || arg.length === 0) {
    return fallback
  }
  const n = Number(arg)
  if (!Number.isInteger(n) || n <= 0) {
    const suffix = /^[./]/.test(arg)
      ? ' — looks like a file path; pass an integer instead, or omit for the default'
      : ''
    throw new Error(
      `${caller}: ${name} (positional argument ${slot - 1}) must be a positive integer,` +
      ` got ${JSON.stringify(arg)}${suffix}` +
      (Number.isNaN(n) ? ` (NaN)` : ''),
    )
  }
  return n
}
