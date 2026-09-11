/**
 * `--headless` / `--tmux` collapsed into the tri-state `useTmux` the API
 * speaks.
 *
 * The tri-state is load-bearing on every revival route (reopen / fork /
 * respawn / metadata): `undefined` means "keep the mode this session already
 * has", which is NOT the same as `true`. Coalescing the two would turn every
 * `orchestron session reopen <id>` against a headless session into a silent
 * migration back to tmux. So an untouched pair of flags must return
 * `undefined`, never a boolean.
 *
 * Both flags at once is a user error, not a precedence puzzle — refuse it
 * rather than picking a winner.
 */
export function resolveUseTmux(opts: { headless?: boolean; tmux?: boolean }): boolean | undefined {
  if (opts.headless && opts.tmux) {
    throw new Error('--headless and --tmux are mutually exclusive')
  }
  if (opts.headless) return false
  if (opts.tmux) return true
  return undefined
}

/** `--use-tmux true|false` for `session metadata`, where the edit is the whole
 *  point of the command and "leave alone" is spelled by omitting the flag. */
export function parseBoolFlag(raw: string | undefined, flag: string): boolean | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim().toLowerCase()
  if (v === 'true' || v === 'yes' || v === '1') return true
  if (v === 'false' || v === 'no' || v === '0') return false
  throw new Error(`${flag} expects true or false, got ${JSON.stringify(raw)}`)
}

/** Drop `undefined` values so a PATCH body carries only the fields the user
 *  actually named — the API's merge semantics treat an absent key as
 *  "leave alone", and `JSON.stringify` already drops undefined, but building
 *  the object cleanly keeps the `--json` echo honest about what was sent. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out as Partial<T>
}
