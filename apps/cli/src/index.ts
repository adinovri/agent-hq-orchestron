import { Command } from 'commander'
import { registerServe } from './commands/serve.js'
import { registerTui } from './commands/tui.js'
import { registerToken } from './commands/token.js'
import { registerProject } from './commands/project.js'
import { registerSession } from './commands/session.js'
import { registerSchedule } from './commands/schedule.js'
import { registerQr } from './commands/qr.js'
import { registerDoctor } from './commands/doctor.js'
import { registerMetrics } from './commands/metrics.js'

/**
 * A reader that stops reading is not an error (NEW-1).
 *
 * `orchestron session list --json | head` is an ordinary thing to type, and it
 * was unhandled across the whole CLI: `head` takes its bytes and closes,
 * everything still queued fails with `EPIPE`, and a stream with no `error`
 * listener turns that into an unhandled `error` event — stack trace on stderr,
 * non-zero status, for a pipeline the operator considers successful. It stayed
 * invisible while documents fit in the 64 KiB a pipe buffers for free; once
 * `session list` outgrew that, the first `| head` started crashing.
 *
 * `process.exit(0)` here, deliberately against the rule the rest of this CLI
 * follows. Everywhere else the code sets `process.exitCode` so a pending write
 * to a pipe can drain first — but the pipe is exactly what has just gone away,
 * so there is nothing left to drain and nothing to wait for.
 *
 * Node ignores SIGPIPE and reports EPIPE instead, so the signal handler is
 * belt-and-braces for a platform or a spawn mode that does deliver it.
 */
function exitQuietlyOnBrokenPipe(stream: NodeJS.WriteStream): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0)
    // Anything else keeps the old behaviour: an unhandled stream error.
    throw err
  })
}
exitQuietlyOnBrokenPipe(process.stdout)
exitQuietlyOnBrokenPipe(process.stderr)
process.on('SIGPIPE', () => process.exit(0))

const program = new Command()
  .name('orchestron')
  .description('Agent supervisor — CLI entry point')
  .version('0.1.0')

registerServe(program)
registerTui(program)
registerToken(program)
registerProject(program)
registerSession(program)
registerSchedule(program)
registerQr(program)
registerDoctor(program)
registerMetrics(program)

program.parseAsync(process.argv).catch((e: unknown) => {
  process.stderr.write(String(e) + '\n')
  // Last-resort handler for anything the per-command `action()` wrapper did
  // not catch. `exitCode` rather than `exit` so a partially written stdout
  // document still reaches the pipe before the process ends.
  process.exitCode = 1
})
