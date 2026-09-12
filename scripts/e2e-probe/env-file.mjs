/**
 * env-file.mjs — which fixture file a probe is actually measuring.
 *
 * Every sweep mints a fixture document (project ids, a session to open a
 * dialog against, the run's bearer token) and every probe reads it. The
 * matrix runners pass it positionally, after whatever the probe's own
 * positional arguments are:
 *
 *     node nf26.mjs KillConfirmDialog ./env-kill.json     # 1 positional
 *     node headless-life.mjs ./env.json                   # 0 positionals
 *
 * NF40 (post-batch-20): `nf30.mjs` took that argument and read `./env.json`
 * anyway. The documented remedy for the Kill flake — re-mint into
 * `env-kill.json`, re-run — therefore measured the *stale* fixture and failed
 * identically to the flake it was meant to rule out. Three 30 s timeout runs
 * and very nearly a false regression filed against NF30.
 *
 * So the rule here is narrower than "read argv": a probe must never silently
 * accept an argument it does not honour. `resolveEnvFile` throws on an extra
 * argument and throws on a path that is not there, because failing in one
 * second beats measuring the wrong session for thirty.
 */
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_ENV_FILE = './env.json'

/**
 * The fixture path this invocation names.
 *
 * @param argv        `process.argv` verbatim — indices 0/1 are node and the
 *                    script, so the env file sits at `2 + positionals`.
 * @param positionals how many arguments the probe consumes before it.
 * @param fallback    used when the argument is absent, which is the common
 *                    case and stays supported.
 * @param mustExist   set false only in tests that do not read the file.
 */
export function resolveEnvFile(argv, { positionals = 0, fallback = DEFAULT_ENV_FILE, mustExist = true } = {}) {
  if (!Array.isArray(argv)) throw new TypeError('resolveEnvFile: argv must be an array')
  if (!Number.isInteger(positionals) || positionals < 0) {
    throw new TypeError(`resolveEnvFile: positionals must be a non-negative integer, got ${positionals}`)
  }
  const args = argv.slice(2)
  if (args.length > positionals + 1) {
    // The NF40 defect class, caught at the door: arguments nobody reads.
    throw new Error(
      `resolveEnvFile: ${args.length} argument(s) but this probe reads ${positionals} positional(s) ` +
      `plus an optional env file — unread: ${JSON.stringify(args.slice(positionals + 1))}`,
    )
  }
  const named = args[positionals]
  const file = named && named.length > 0 ? named : fallback
  if (mustExist && !fs.existsSync(file)) {
    throw new Error(
      `resolveEnvFile: no fixture at ${file}` +
      (named ? '' : ` (no env-file argument given, fell back to ${fallback})`) +
      ' — mint it first, or pass the one you minted',
    )
  }
  return file
}

/** `resolveEnvFile` plus the parse, which is what probes actually want. */
export function loadEnvFile(argv, opts = {}) {
  const file = resolveEnvFile(argv, opts)
  const env = JSON.parse(fs.readFileSync(file, 'utf8'))
  return { file, env }
}

/**
 * One line naming the fixture and how stale it is. Printed by probes so a
 * failing run says which document it measured — the signal whose absence made
 * NF40 cost three runs instead of one.
 */
export function describeEnvFile(file, now = Date.now()) {
  const abs = path.resolve(file)
  let age = 'age unknown'
  try {
    const ageMs = now - fs.statSync(file).mtimeMs
    age = `minted ${Math.max(0, Math.round(ageMs / 1000))}s ago`
  } catch { /* reported as unknown rather than thrown — this is a log line */ }
  return `fixture: ${abs} (${age})`
}
