import type { Command } from 'commander'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

export function registerTui(program: Command): void {
  program
    .command('tui')
    .description('Open the Ink TUI dashboard')
    .option('--url <url>', 'API base URL', 'http://localhost:8080')
    .option('--token <token>', 'Auth token')
    .action((opts: { url: string; token?: string }) => {
      const tuiEntry = join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../tui/src/index.tsx',
      )
      const args = ['--url', opts.url]
      if (opts.token) args.push('--token', opts.token)
      spawnSync('tsx', [tuiEntry, ...args], { stdio: 'inherit' })
    })
}
