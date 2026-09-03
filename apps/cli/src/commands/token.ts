import type { Command } from 'commander'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import pc from 'picocolors'
import { jsonOut } from '../helpers/defineCommand.js'

function configPath(): string {
  return join(homedir(), '.orchestron', 'config.json')
}

function readConfig(): Record<string, unknown> {
  const p = configPath()
  if (!existsSync(p)) return {}
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
}

function writeConfig(cfg: Record<string, unknown>): void {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2))
}

export function registerToken(program: Command): void {
  const token = program.command('token').description('Manage API tokens')

  token
    .command('generate')
    .description('Generate a new hex-48 token')
    .option('--json', 'Machine-readable output')
    .action((opts: { json?: boolean }) => {
      const t = randomBytes(24).toString('hex')
      if (opts.json) {
        jsonOut({ token: t })
      } else {
        process.stdout.write(pc.green('Token: ') + t + '\n')
      }
    })

  token
    .command('rotate')
    .description('Rotate token and update config file')
    .option('--json', 'Machine-readable output')
    .action((opts: { json?: boolean }) => {
      const t = randomBytes(24).toString('hex')
      const cfg = readConfig()
      cfg['token'] = t
      writeConfig(cfg)
      if (opts.json) {
        jsonOut({ token: t, saved: configPath() })
      } else {
        process.stdout.write(pc.green('Token rotated: ') + t + '\n')
        process.stdout.write(pc.gray('Saved to: ') + configPath() + '\n')
      }
    })
}
