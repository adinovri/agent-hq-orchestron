import type { Command } from 'commander'
import pc from 'picocolors'
import Table from 'cli-table3'

async function apiFetch<T>(url: string, method = 'GET', body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  if (method === 'DELETE' || res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

interface ScheduleEntry {
  id: string
  cron: string
  projectId: string
  enabled: boolean
  template?: string
  prompt?: string
  createdAt: string
}

export function registerSchedule(program: Command): void {
  const schedule = program.command('schedule').description('Manage scheduled agent tasks')

  schedule
    .command('list')
    .description('List scheduled tasks')
    .option('--host <host>', 'API host', 'http://localhost:4000')
    .option('--token <token>', 'Bearer token', process.env['ORCHESTRON_TOKEN'])
    .action(async (opts: { host: string; token?: string }) => {
      try {
        const { schedules } = await apiFetch<{ schedules: ScheduleEntry[] }>(
          `${opts.host}/api/schedules`,
          'GET',
          undefined,
          opts.token,
        )

        if (schedules.length === 0) {
          process.stdout.write(pc.dim('No schedules found.\n'))
          return
        }

        const table = new Table({ head: ['ID', 'Cron', 'Project', 'Enabled', 'Trigger'] })
        for (const s of schedules) {
          table.push([
            s.id.slice(0, 8),
            s.cron,
            s.projectId,
            s.enabled ? pc.green('yes') : pc.red('no'),
            s.template ? `template:${s.template}` : (s.prompt?.slice(0, 30) ?? '—'),
          ])
        }
        process.stdout.write(table.toString() + '\n')
      } catch (err) {
        process.stderr.write(pc.red(`Error: ${(err as Error).message}\n`))
        process.exit(1)
      }
    })

  schedule
    .command('run <id>')
    .description('Trigger a scheduled task immediately')
    .option('--host <host>', 'API host', 'http://localhost:4000')
    .option('--token <token>', 'Bearer token', process.env['ORCHESTRON_TOKEN'])
    .action(async (id: string, opts: { host: string; token?: string }) => {
      try {
        await apiFetch(`${opts.host}/api/schedules/${id}/run`, 'POST', undefined, opts.token)
        process.stdout.write(pc.green(`Schedule ${id} triggered.\n`))
      } catch (err) {
        process.stderr.write(pc.red(`Error: ${(err as Error).message}\n`))
        process.exit(1)
      }
    })

  schedule
    .command('daemon')
    .description('Start the scheduler daemon (runs alongside the API server)')
    .option('--host <host>', 'API host', 'http://localhost:4000')
    .action((opts: { host: string }) => {
      process.stdout.write(
        pc.yellow(`The scheduler daemon runs inside the API server (orchestron serve).\n`) +
          pc.dim(`API: ${opts.host}/api/schedules\n`),
      )
    })
}
