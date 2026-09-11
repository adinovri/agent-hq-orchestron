import pc from 'picocolors'
import type { Command } from 'commander'
import { ApiError, type CommonOpts } from './api.js'

/**
 * The envelope every `--json` command prints.
 *
 * Fixed `ok` discriminator so a caller can branch on one field without
 * knowing which command produced the document — the point of the flag is that
 * the TUI and the Phase 3 executor can drive the whole surface without a
 * per-command parser.
 *
 * Both branches carry arbitrary extra fields. The failure branch was once
 * exactly `{ok, error, status?}`, which was right while the only failures
 * were HTTP ones. `doctor` is not one: it fails on what it *found*, and the
 * findings are the reason a caller ran it, so its `ok:false` document still
 * has to carry `checks`. See NF23.
 */
export type JsonEnvelope =
  | ({ ok: true } & Record<string, unknown>)
  | ({ ok: false; error: string; status?: number } & Record<string, unknown>)

/** Attach `--url`, `--token` and `--json` in one place so every command spells
 *  them identically. `--host` is the deprecated alias `schedule` shipped with. */
export function withCommonOptions(cmd: Command): Command {
  return cmd
    .option('--url <url>', 'API base URL (else $ORCHESTRON_URL, else config.json)')
    .option('--host <url>', 'Deprecated alias for --url')
    .option('--token <token>', 'Bearer token (else $ORCHESTRON_TOKEN, else config.json)')
    .option('--json', 'Machine-readable output')
}

/** Success: one JSON envelope, or one human line. Nothing else goes to stdout,
 *  so `--json` output is always parseable in full. */
export function emit(opts: CommonOpts, payload: Record<string, unknown>, human: string): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify({ ok: true, ...payload }, null, 2) + '\n')
  } else {
    process.stdout.write(human.endsWith('\n') ? human : human + '\n')
  }
}

/**
 * Failure: the same envelope shape with `ok:false`, then a non-zero exit.
 *
 * The JSON envelope goes to **stdout** (a caller piping to `jq` wants it
 * there); the human line goes to stderr. Exit code is 1 for everything —
 * callers that need to distinguish read `status` out of the envelope.
 *
 * Sets `process.exitCode` rather than calling `process.exit(1)`. A write to a
 * PIPE is asynchronous, and `process.exit` does not wait for it: piping any
 * failing `--json` command into `jq` produced an empty document and exit 1,
 * which is precisely the case a workflow driver has to be able to read. With
 * `exitCode` the process ends on its own once the write has drained, and the
 * code is the same.
 */
export function fail(opts: CommonOpts, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  if (opts.json) {
    const envelope: JsonEnvelope = err instanceof ApiError
      ? { ok: false, error: message, status: err.status }
      : { ok: false, error: message }
    process.stdout.write(JSON.stringify(envelope, null, 2) + '\n')
  } else {
    process.stderr.write(pc.red('Error: ') + message + '\n')
  }
  process.exitCode = 1
}

/** Wrap an action so every command fails the same way. Without this each
 *  handler's rejection surfaces as commander's bare `Error: …` dump with exit
 *  1 and no `--json` envelope at all. */
export function action<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args)
    } catch (err) {
      fail(optionsOf(args), err)
    }
  }
}

/**
 * Dig the parsed options out of a Commander action's arguments.
 *
 * Commander calls an action handler with `(...positionals, options, command)`
 * — the **last** argument is the Command instance, not the options. Reading
 * `args[args.length - 1]` therefore hands back a Command, whose `json`
 * property is undefined, and every failing `--json` command silently printed
 * a human error to stderr and an empty stdout instead of the `{ok:false}`
 * envelope its caller was parsing.
 *
 * Walk from the end and skip anything that answers to `.opts()`, which is the
 * Command and nothing else the CLI passes.
 */
function optionsOf(args: unknown[]): CommonOpts {
  for (let i = args.length - 1; i >= 0; i--) {
    const candidate = args[i]
    if (
      candidate &&
      typeof candidate === 'object' &&
      typeof (candidate as { opts?: unknown }).opts !== 'function'
    ) {
      return candidate as CommonOpts
    }
  }
  return {}
}
