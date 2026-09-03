import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { GhAdapter, ghAdapterOrNull } from './gh.js'
import { BbAdapter, bbAdapterOrNull } from './bb.js'

const execFileAsync = promisify(execFile)

export interface PrData {
  number: number
  title: string
  body: string
  author: string
  baseRef: string
  headRef: string
  diff: string
  reviewers: string[]
  comments: Array<{ body: string; author: string }>
  status: string
}

export interface IssueData {
  number: number
  title: string
  body: string
  labels: string[]
  assignees: string[]
  comments: Array<{ body: string; author: string }>
}

export interface GitHostAdapter {
  readonly name: 'gh' | 'bb'
  detect(projectPath: string): Promise<boolean>
  pr(id: number): Promise<PrData>
  issue(id: number): Promise<IssueData>
}

export async function resolveGitHostAdapter(projectPath: string): Promise<GitHostAdapter | null> {
  let remoteUrl = ''
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd: projectPath })
    remoteUrl = stdout.trim()
  } catch {
    return null
  }

  if (remoteUrl.includes('github.com')) {
    return ghAdapterOrNull()
  }

  if (remoteUrl.includes('bitbucket.org')) {
    return bbAdapterOrNull(projectPath)
  }

  return null
}

export type { GhAdapter, BbAdapter }
