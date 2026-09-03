import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import type { GitHostAdapter, PrData, IssueData } from './registry.js'

const execFileAsync = promisify(execFile)

const BLOCKED_SUBCOMMANDS = new Set(['merge', 'close', 'delete'])

function getCredentials(): { workspace: string; repo: string } | null {
  return null // resolved per-call from remote URL
}

async function callBbCli(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('bb', args)
  return stdout
}

async function callBbApi(endpoint: string): Promise<unknown> {
  const appPassword = process.env.BITBUCKET_APP_PASSWORD
  const username = process.env.BITBUCKET_USERNAME
  if (!appPassword || !username) {
    throw new Error('BITBUCKET_APP_PASSWORD and BITBUCKET_USERNAME env vars required for Bitbucket API fallback')
  }

  const token = Buffer.from(`${username}:${appPassword}`).toString('base64')
  const url = `https://api.bitbucket.org/2.0${endpoint}`

  const { stdout } = await execFileAsync('curl', [
    '-s', '-H', `Authorization: Basic ${token}`, url,
  ])
  return JSON.parse(stdout)
}

async function parseRemoteForCoords(projectPath: string): Promise<{ workspace: string; repoSlug: string } | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: projectPath })
    const url = stdout.trim()
    // ssh: git@bitbucket.org:workspace/repo.git or https://bitbucket.org/workspace/repo.git
    const m = url.match(/bitbucket\.org[/:]([^/]+)\/([^/\s.]+)/)
    if (!m) return null
    return { workspace: m[1]!, repoSlug: m[2]!.replace(/\.git$/, '') }
  } catch {
    return null
  }
}

export class BbAdapter implements GitHostAdapter {
  readonly name = 'bb' as const
  private readonly _projectPath: string
  private _coords: { workspace: string; repoSlug: string } | null = null

  constructor(projectPath: string) {
    this._projectPath = projectPath
  }

  private async coords(): Promise<{ workspace: string; repoSlug: string }> {
    if (!this._coords) {
      this._coords = await parseRemoteForCoords(this._projectPath)
    }
    if (!this._coords) throw new Error('Cannot determine Bitbucket workspace/repo from git remote')
    return this._coords
  }

  async detect(projectPath: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: projectPath })
      const url = stdout.trim()
      return url.includes('bitbucket.org')
    } catch {
      return false
    }
  }

  async pr(id: number): Promise<PrData> {
    const c = await this.coords()

    // prefer bb-cli
    try {
      const raw = JSON.parse(await callBbCli(['pr', 'get', '--json', String(id)]))
      return normalizeBbPr(raw)
    } catch {
      // fallback to REST API
    }

    const raw = await callBbApi(`/repositories/${c.workspace}/${c.repoSlug}/pullrequests/${id}`)
    return normalizeBbPr(raw as Record<string, unknown>)
  }

  async issue(id: number): Promise<IssueData> {
    const c = await this.coords()

    try {
      const raw = JSON.parse(await callBbCli(['issue', 'get', '--json', String(id)]))
      return normalizeBbIssue(raw)
    } catch {
      // fallback
    }

    const raw = await callBbApi(`/repositories/${c.workspace}/${c.repoSlug}/issues/${id}`)
    return normalizeBbIssue(raw as Record<string, unknown>)
  }

  static assertAllowed(subcommand: string): void {
    if (BLOCKED_SUBCOMMANDS.has(subcommand)) {
      throw new Error(`bb subcommand '${subcommand}' is not allowed (write operation blocked)`)
    }
  }
}

function normalizeBbPr(raw: Record<string, unknown>): PrData {
  return {
    number: raw['id'] as number,
    title: (raw['title'] as string) ?? '',
    body: (raw['description'] as string) ?? '',
    author: ((raw['author'] as Record<string, unknown>)?.['display_name'] as string) ?? '',
    baseRef: ((raw['destination'] as Record<string, unknown>)?.['branch'] as Record<string, unknown>)?.['name'] as string ?? '',
    headRef: ((raw['source'] as Record<string, unknown>)?.['branch'] as Record<string, unknown>)?.['name'] as string ?? '',
    diff: '',
    reviewers: ((raw['reviewers'] as Array<Record<string, unknown>>) ?? []).map((r) => r['display_name'] as string),
    comments: [],
    status: ((raw['state'] as string) ?? '').toLowerCase(),
  }
}

function normalizeBbIssue(raw: Record<string, unknown>): IssueData {
  return {
    number: raw['id'] as number,
    title: (raw['title'] as string) ?? '',
    body: (raw['content'] as Record<string, unknown>)?.['raw'] as string ?? '',
    labels: [],
    assignees: raw['assignee']
      ? [((raw['assignee'] as Record<string, unknown>)?.['display_name'] as string) ?? '']
      : [],
    comments: [],
  }
}

export function bbAdapterOrNull(projectPath: string): BbAdapter | null {
  try {
    const PATH = process.env.PATH ?? ''
    const hasBbCli = PATH.split(':').some((dir) => fs.existsSync(path.join(dir, 'bb')))
    const hasCurl = PATH.split(':').some((dir) => fs.existsSync(path.join(dir, 'curl')))

    if (!hasBbCli && !hasCurl) return null
    return new BbAdapter(projectPath)
  } catch {
    return null
  }
}
