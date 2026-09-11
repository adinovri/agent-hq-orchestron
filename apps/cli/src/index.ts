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
  process.exit(1)
})
