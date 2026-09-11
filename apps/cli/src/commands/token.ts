import type { Command } from 'commander'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import pc from 'picocolors'
import { resolveConfigPath, LEGACY_TOKEN_KEY } from '@agent-hq-orchestron/shared'
import { jsonOut } from '../helpers/defineCommand.js'

/** The same file the API reads — honours ORCHESTRON_CONFIG and
 *  ORCHESTRON_DATA_DIR instead of hard-coding ~/.orchestron, so rotating
 *  from inside a second instance's env touches that instance's config. */
function configPath(): string {
  return resolveConfigPath()
}

function readConfig(): Record<string, unknown> {
  const p = configPath()
  if (!existsSync(p)) return {}
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
}

function writeConfig(cfg: Record<string, unknown>): void {
  const p = configPath()
  mkdirSync(dirname(p), { recursive: true })
  // 0600: the file holds the plaintext bearer. loadConfig warns when the
  // mode is looser; a token this command just wrote should not trip it.
  writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 })
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
      // `remoteToken` is the key ConfigSchema reads. Writing `token` (what
      // this command did until B6-F1) produced a rotate that changed
      // nothing: the printed token never authenticated and the old one
      // stayed live. Drop any legacy key in the same write so the two
      // spellings cannot disagree afterwards.
      cfg['remoteToken'] = t
      const hadLegacy = typeof cfg[LEGACY_TOKEN_KEY] === 'string'
      if (hadLegacy) delete cfg[LEGACY_TOKEN_KEY]
      writeConfig(cfg)
      if (opts.json) {
        jsonOut({
          token: t,
          key: 'remoteToken',
          saved: configPath(),
          legacyKeyRemoved: hadLegacy,
          restartRequired: true,
        })
      } else {
        process.stdout.write(pc.green('Token rotated: ') + t + '\n')
        process.stdout.write(pc.gray('Saved to: ') + configPath() + ' (key: remoteToken)\n')
        if (hadLegacy) {
          process.stdout.write(pc.gray('Removed legacy "token" key from the same file.\n'))
        }
        // The API parses config.json once at boot. Without this line an
        // operator rotating after a leak walks away believing the leaked
        // token is dead while the running process still accepts it.
        process.stdout.write(
          pc.yellow('Restart the API for this to take effect — the running process still accepts the old token.\n'),
        )
      }
    })
}
