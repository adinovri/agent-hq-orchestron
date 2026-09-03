import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { GitHostAdapter, PrData, IssueData } from './registry.js'

const execFileAsync = promisify(execFile)

const CACHE_DIR = path.join(os.homedir(), '.orchestron', 'cache', 'gh')
const CACHE_TTL_MS = 5 * 60 * 1000

const BLOCKED_SUBCOMMANDS = new Set(['merge', 'close', 'delete'])

function cachePathFor(type: string, id: number): string {
  return path.join(CACHE_DIR, `${type}-${id}.json`)
}

async function readCache<T>(cachePath: string): Promise<T | null> {
  try {
    const stat = await fsPromises.stat(cachePath)
    if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      const raw = await fsPromises.readFile(cachePath, 'utf8')
      return JSON.parse(raw) as T
    }
  } catch {
    // cache miss
  }
  return null
}

async function writeCache(cachePath: string, data: unknown): Promise<void> {
  await fsPromises.mkdir(path.dirname(cachePath), { recursive: true })
  await fsPromises.writeFile(cachePath, JSON.stringify(data), 'utf8')
}

export class GhAdapter implements GitHostAdapter {
  readonly name = 'gh' as const

  async detect(projectPath: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: projectPath })
      const url = stdout.trim()
      return url.includes('github.com')
    } catch {
      return false
    }
  }

  async pr(id: number): Promise<PrData> {
    const cachePath = cachePathFor('pr', id)
    const cached = await readCache<PrData>(cachePath)
    if (cached) return cached

    const { stdout } = await execFileAsync('gh', [
      'pr', 'view', String(id),
      '--json', 'number,title,body,author,baseRefName,headRefName,reviewRequests,comments,state',
    ])

    const raw = JSON.parse(stdout)
    let diff = ''
    try {
      const { stdout: diffOut } = await execFileAsync('gh', ['pr', 'diff', String(id)])
      diff = diffOut
    } catch {
      // diff may fail for closed PRs
    }

    const result: PrData = {
      number: raw.number,
      title: raw.title,
      body: raw.body ?? '',
      author: raw.author?.login ?? '',
      baseRef: raw.baseRefName,
      headRef: raw.headRefName,
      diff,
      reviewers: (raw.reviewRequests ?? []).map((r: { login?: string }) => r.login ?? ''),
      comments: (raw.comments ?? []).map((c: { body: string; author?: { login?: string } }) => ({
        body: c.body,
        author: c.author?.login ?? '',
      })),
      status: raw.state?.toLowerCase() ?? 'unknown',
    }

    await writeCache(cachePath, result)
    return result
  }

  async issue(id: number): Promise<IssueData> {
    const cachePath = cachePathFor('issue', id)
    const cached = await readCache<IssueData>(cachePath)
    if (cached) return cached

    const { stdout } = await execFileAsync('gh', [
      'issue', 'view', String(id),
      '--json', 'number,title,body,labels,assignees,comments',
    ])
    const raw = JSON.parse(stdout)

    const result: IssueData = {
      number: raw.number,
      title: raw.title,
      body: raw.body ?? '',
      labels: (raw.labels ?? []).map((l: { name: string }) => l.name),
      assignees: (raw.assignees ?? []).map((a: { login: string }) => a.login),
      comments: (raw.comments ?? []).map((c: { body: string; author?: { login?: string } }) => ({
        body: c.body,
        author: c.author?.login ?? '',
      })),
    }

    await writeCache(cachePath, result)
    return result
  }

  // Whitelist guard — only read subcommands allowed
  static assertAllowed(subcommand: string): void {
    if (BLOCKED_SUBCOMMANDS.has(subcommand)) {
      throw new Error(`gh subcommand '${subcommand}' is not allowed (write operation blocked)`)
    }
  }
}

export function ghAdapterOrNull(): GhAdapter | null {
  try {
    // Verify gh is available synchronously via PATH check
    const PATH = process.env.PATH ?? ''
    const found = PATH.split(':').some((dir) => fs.existsSync(path.join(dir, 'gh')))
    return found ? new GhAdapter() : null
  } catch {
    return null
  }
}
