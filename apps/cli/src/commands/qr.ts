import type { Command } from 'commander'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import pc from 'picocolors'
import qrcode from 'qrcode-terminal'
import { resolveHost } from '../helpers/resolve-host.js'

function loadToken(): string | undefined {
  const envToken = process.env['ORCHESTRON_REMOTE_TOKEN']
  if (envToken) return envToken
  const cfgPath = join(homedir(), '.orchestron', 'config.json')
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
      if (typeof cfg['token'] === 'string') return cfg['token']
    } catch {
      // ignore
    }
  }
  return undefined
}

export function registerQr(program: Command): void {
  program
    .command('qr')
    .description('Show QR code for pairing a remote device')
    .option('-p, --port <port>', 'API port', '8080')
    .option('--token <token>', 'Auth token (overrides env/config)')
    .action(async (opts: { port: string; token?: string }) => {
      const token = opts.token ?? loadToken()
      if (!token) {
        process.stderr.write(
          pc.red(
            'Error: no token found. Set ORCHESTRON_REMOTE_TOKEN, pass --token, or run `orchestron token generate`.\n',
          ),
        )
        process.exit(1)
      }

      const { host } = await resolveHost()
      const url = `http://${host}:${opts.port}/pair?token=${token}`

      process.stdout.write('\n')
      process.stdout.write(pc.bold(pc.yellow('⚠  SECURITY WARNING')) + '\n')
      process.stdout.write(
        pc.yellow(
          'This QR code grants full access to your Orchestron instance. Do NOT screen-share while it is visible.\n',
        ),
      )
      process.stdout.write('\n')
      process.stdout.write(pc.cyan('Pair URL: ') + url + '\n\n')

      qrcode.generate(url, { small: true })
    })
}
