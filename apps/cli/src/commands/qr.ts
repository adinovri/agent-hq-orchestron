import type { Command } from 'commander'
import { readFileSync, existsSync } from 'node:fs'
import pc from 'picocolors'
import qrcode from 'qrcode-terminal'
import { resolveConfigPath, LEGACY_TOKEN_KEY } from '@agent-hq-orchestron/shared'
import { resolveHost } from '../helpers/resolve-host.js'

function loadToken(): string | undefined {
  const envToken = process.env['ORCHESTRON_REMOTE_TOKEN']
  if (envToken) return envToken
  // `remoteToken` is the key the API reads. This command used to look up
  // `token` only, so on a correctly provisioned instance the documented
  // way to pair a phone could not find the token sitting in the very file
  // it was reading (B6-F1). Legacy `token` stays as a fallback for a
  // config the boot migration has not rewritten yet.
  const cfgPath = resolveConfigPath()
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
      if (typeof cfg['remoteToken'] === 'string' && cfg['remoteToken']) return cfg['remoteToken']
      if (typeof cfg[LEGACY_TOKEN_KEY] === 'string' && cfg[LEGACY_TOKEN_KEY]) {
        return cfg[LEGACY_TOKEN_KEY] as string
      }
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
    .option('-p, --port <port>', 'Web UI port (Next.js /pair route)', '3010')
    .option('--token <token>', 'Auth token (overrides env/config)')
    .action(async (opts: { port: string; token?: string }) => {
      const token = opts.token ?? loadToken()
      if (!token) {
        process.stderr.write(
          pc.red(
            'Error: no token found. Set ORCHESTRON_REMOTE_TOKEN, pass --token, or run `orchestron token rotate` (which writes remoteToken into the config file — `token generate` only prints one).\n',
          ),
        )
        // exitCode + return, not `process.exit`: the same drain rule as every
        // other command, and the `return` is load-bearing now that the call
        // no longer tears the process down where it stands.
        process.exitCode = 1
        return
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
