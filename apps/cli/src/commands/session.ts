import type { Command } from 'commander'
import pc from 'picocolors'
import Table from 'cli-table3'
import { jsonOut } from '../helpers/defineCommand.js'

async function apiFetch<T>(url: string, method: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (method === 'DELETE') return undefined as T
  return res.json() as Promise<T>
}

interface Session {
  id: string
  projectId: string
  agentType: string
  status: string
  tmuxName: string
  costUsd: number | null
  startedAt: string
}

const STATUS_COLOR: Record<string, (s: string) => string> = {
  running: pc.green,
  completed: pc.blue,
  failed: pc.red,
  killed: pc.gray,
  spawning: pc.yellow,
  waiting: pc.yellow,
  completing: pc.cyan,
}

export function registerSession(program: Command): void {
  const session = program.command('session').description('Manage sessions')

  session
    .command('list')
    .description('List sessions')
    .option('--url <url>', 'API URL', 'http://localhost:8080')
    .option('--token <token>', 'Auth token')
    .option('--project <projectId>', 'Filter by project ID')
    .option('--json', 'Machine-readable output')
    .action(async (opts: { url: string; token?: string; project?: string; json?: boolean }) => {
      let path = '/api/sessions'
      if (opts.project) path += `?projectId=${opts.project}`
      const sessions = await apiFetch<Session[]>(`${opts.url}${path}`, 'GET', undefined, opts.token)
      if (opts.json) {
        jsonOut(sessions)
      } else {
        const t = new Table({ head: ['ID', 'Name', 'Status', 'Agent', 'Cost', 'Started'] })
        for (const s of sessions) {
          const colorFn = STATUS_COLOR[s.status] ?? ((x: string) => x)
          t.push([
            pc.gray(s.id.slice(0, 8)),
            s.tmuxName.slice(0, 20),
            colorFn(s.status),
            s.agentType,
            s.costUsd != null ? `$${s.costUsd.toFixed(4)}` : '—',
            s.startedAt.slice(0, 16),
          ])
        }
        process.stdout.write(t.toString() + '\n')
      }
    })

  session
    .command('spawn')
    .description('Spawn a new session')
    .requiredOption('--project <projectId>', 'Project ID')
    .option('--prompt <prompt>', 'Initial prompt')
    .option('--agent <agent>', 'Agent type override')
    .option('--url <url>', 'API URL', 'http://localhost:8080')
    .option('--token <token>', 'Auth token')
    .option('--json', 'Machine-readable output')
    .action(async (opts: { project: string; prompt?: string; agent?: string; url: string; token?: string; json?: boolean }) => {
      const result = await apiFetch<Session>(`${opts.url}/api/sessions`, 'POST', {
        projectId: opts.project,
        prompt: opts.prompt,
        agentType: opts.agent,
      }, opts.token)
      if (opts.json) {
        jsonOut(result)
      } else {
        process.stdout.write(pc.green('Session spawned: ') + result.id + '\n')
      }
    })

  session
    .command('kill <id>')
    .description('Kill a session')
    .option('--url <url>', 'API URL', 'http://localhost:8080')
    .option('--token <token>', 'Auth token')
    .action(async (id: string, opts: { url: string; token?: string }) => {
      await apiFetch<undefined>(`${opts.url}/api/sessions/${id}`, 'DELETE', undefined, opts.token)
      process.stdout.write(pc.red('Session killed: ') + id + '\n')
    })

  session
    .command('logs <id>')
    .description('Tail SSE transcript for a session')
    .option('--url <url>', 'API URL', 'http://localhost:8080')
    .option('--token <token>', 'Auth token')
    .action(async (id: string, opts: { url: string; token?: string }) => {
      const { EventSource } = await import('eventsource')
      const url = `${opts.url}/api/sessions/${id}/transcript`
      const headers: Record<string, string> = {}
      if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`
      const es = new EventSource(url, { headers } as ConstructorParameters<typeof EventSource>[1])
      process.stdout.write(pc.cyan(`Tailing transcript for ${id}...\n`))
      es.addEventListener('message', (e: MessageEvent) => {
        process.stdout.write(String(e.data) + '\n')
      })
      es.addEventListener('error', () => {
        process.stdout.write(pc.gray('\n[Stream ended]\n'))
        es.close()
        process.exit(0)
      })
    })
}
