import type { Command } from 'commander'
import pc from 'picocolors'

export function registerSchedule(program: Command): void {
  const schedule = program.command('schedule').description('Manage scheduled tasks (stub)')

  schedule
    .command('list')
    .description('List scheduled tasks [stub]')
    .action(() => {
      process.stdout.write(pc.yellow('schedule list: not yet implemented\n'))
    })

  schedule
    .command('run <id>')
    .description('Run a scheduled task immediately [stub]')
    .action((id: string) => {
      process.stdout.write(pc.yellow(`schedule run ${id}: not yet implemented\n`))
    })

  schedule
    .command('daemon')
    .description('Start the scheduler daemon [stub]')
    .action(() => {
      process.stdout.write(pc.yellow('schedule daemon: not yet implemented\n'))
    })
}
