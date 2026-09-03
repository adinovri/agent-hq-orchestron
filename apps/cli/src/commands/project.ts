import type { Command } from 'commander'
import pc from 'picocolors'
import Table from 'cli-table3'
import { jsonOut } from '../helpers/defineCommand.js'

function apiUrl(base: string, path: string) {
  return `${base}${path}`
}

async function get<T>(url: string, token?: string): Promise<T> {
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function post<T>(url: string, body: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function del(url: string, token?: string): Promise<void> {
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, { method: 'DELETE', headers })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

interface Project {
  id: string
  name: string
  path: string
  agentType: string
  group?: string | null
  tags?: string[]
}

export function registerProject(program: Command): void {
  const project = program.command('project').description('Manage projects')

  project
    .command('list')
    .description('List all projects')
    .option('--url <url>', 'API URL', 'http://localhost:8080')
    .option('--token <token>', 'Auth token')
    .option('--json', 'Machine-readable output')
    .action(async (opts: { url: string; token?: string; json?: boolean }) => {
      const projects = await get<Project[]>(apiUrl(opts.url, '/api/projects'), opts.token)
      if (opts.json) {
        jsonOut(projects)
      } else {
        const t = new Table({ head: ['ID', 'Name', 'Path', 'Agent', 'Group'] })
        for (const p of projects) {
          t.push([
            pc.gray(p.id.slice(0, 8)),
            pc.bold(p.name),
            p.path,
            pc.cyan(p.agentType),
            p.group ?? '—',
          ])
        }
        process.stdout.write(t.toString() + '\n')
      }
    })

  project
    .command('add')
    .description('Register a new project')
    .requiredOption('--name <name>', 'Project name')
    .requiredOption('--path <path>', 'Project path')
    .option('--agent <agent>', 'Agent type', 'claude')
    .option('--group <group>', 'Group')
    .option('--url <url>', 'API URL', 'http://localhost:8080')
    .option('--token <token>', 'Auth token')
    .option('--json', 'Machine-readable output')
    .action(async (opts: { name: string; path: string; agent: string; group?: string; url: string; token?: string; json?: boolean }) => {
      const result = await post<Project>(apiUrl(opts.url, '/api/projects'), {
        name: opts.name,
        path: opts.path,
        agentType: opts.agent,
        group: opts.group ?? null,
      }, opts.token)
      if (opts.json) {
        jsonOut(result)
      } else {
        process.stdout.write(pc.green('Project registered: ') + result.id + '\n')
      }
    })

  project
    .command('rm <id>')
    .description('Remove a project')
    .option('--url <url>', 'API URL', 'http://localhost:8080')
    .option('--token <token>', 'Auth token')
    .action(async (id: string, opts: { url: string; token?: string }) => {
      await del(apiUrl(opts.url, `/api/projects/${id}`), opts.token)
      process.stdout.write(pc.green('Removed: ') + id + '\n')
    })

  project
    .command('edit <id>')
    .description('Edit a project (stub — use the API directly)')
    .action((id: string) => {
      process.stdout.write(pc.yellow(`Use PATCH /api/projects/${id} to edit.\n`))
    })
}
