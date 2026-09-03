import type { Command } from 'commander'

export function registerServe(program: Command): void {
  program
    .command('serve')
    .description('Start the Orchestron API server')
    .option('-p, --port <port>', 'Port to listen on', '8080')
    .option('-h, --host <host>', 'Host to bind', '0.0.0.0')
    .action(async (opts: { port: string; host: string }) => {
      const { startServer } = await import('@agent-hq-orchestron/api' as string)
      await startServer({ port: Number(opts.port), host: opts.host })
    })
}
