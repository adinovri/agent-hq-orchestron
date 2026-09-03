import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd })
    return stdout.trimEnd()
  } catch {
    return ''
  }
}

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd })
    return true
  } catch {
    return false
  }
}

export interface GitContext {
  branch: string
  status: string
  diff: string
  log: (n: number) => Promise<string>
}

export async function resolveGitContext(cwd: string): Promise<GitContext> {
  if (!(await isGitRepo(cwd))) {
    return {
      branch: '',
      status: '',
      diff: '',
      log: async () => '',
    }
  }

  const [branch, status, diff] = await Promise.all([
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['status', '--short']),
    git(cwd, ['diff', 'HEAD']),
  ])

  return {
    branch,
    status,
    diff,
    log: (n: number) => git(cwd, ['log', `--oneline`, `-${n}`]),
  }
}
