import type { Command } from 'commander'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

export function registerServe(program: Command): void {
  program
    .command('serve')
    .description('Start the Orchestron API server')
    .option('-p, --port <port>', 'Port to listen on', '8080')
    .option('-H, --host <host>', 'Host to bind', '127.0.0.1')
    .action((opts: { port: string; host: string }) => {
      const apiEntry = join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../api/src/server.ts',
      )
      spawnSync('npx', ['tsx', apiEntry], {
        stdio: 'inherit',
        env: {
          ...process.env,
          ORCHESTRON_PORT: opts.port,
          ORCHESTRON_BIND_HOST: opts.host,
        },
      })
    })
}
