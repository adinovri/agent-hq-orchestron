import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import type { GitHostAdapter } from '../adapters/git-host/registry.js'
import type { WorktreeLedger } from '@agent-hq-orchestron/shared'
import { writeJson, readJson, listDir } from '@agent-hq-orchestron/file-store'

const execFileAsync = promisify(execFile)

const WORKTREE_BASE = '/tmp/orchestron-worktree'
const CLAUDE_DIR_PATTERN = /\.claude\/?$/

export interface SnapshotResult {
  worktreePath: string
  readOnly: boolean
}

export class SnapshotService {
  private readonly _dataDir: string

  constructor(dataDir: string) {
    this._dataDir = dataDir
  }

  private ledgerPath(sessionUuid: string): string {
    return path.join(this._dataDir, 'worktrees', `${sessionUuid}.json`)
  }

  async create(opts: {
    sessionUuid: string
    prSource: string
    gitHostAdapter: GitHostAdapter
    projectPath: string
  }): Promise<SnapshotResult> {
    const { sessionUuid, prSource, gitHostAdapter, projectPath } = opts

    // Parse PR number from prSource (e.g. "42" or "pr/42" or "PR-42")
    const prNum = parseInt(prSource.replace(/\D/g, ''), 10)
    if (isNaN(prNum)) throw new Error(`Invalid prSource: ${prSource}`)

    const prData = await gitHostAdapter.pr(prNum)
    const baseRef = prData.baseRef

    const worktreePath = path.join(WORKTREE_BASE, sessionUuid)

    // git worktree add <path> origin/<baseRef>
    await execFileAsync('git', [
      'worktree', 'add', worktreePath, `origin/${baseRef}`,
    ], { cwd: projectPath })

    // chmod -R a-w <worktreePath> except .claude/
    await chmodReadOnly(worktreePath)

    const ledger: WorktreeLedger = {
      sessionUuid,
      worktreePath,
      createdAt: new Date().toISOString(),
    }
    await writeJson(this.ledgerPath(sessionUuid), ledger)

    return { worktreePath, readOnly: true }
  }

  async cleanup(sessionUuid: string): Promise<void> {
    const ledger = await readJson<WorktreeLedger | null>(this.ledgerPath(sessionUuid), null)
    if (!ledger) return

    try {
      await execFileAsync('git', ['worktree', 'remove', '--force', ledger.worktreePath])
    } catch {
      // best-effort
    }

    const fs = await import('node:fs/promises')
    try {
      await fs.unlink(this.ledgerPath(sessionUuid))
    } catch {
      // already gone
    }
  }

  async listLedgers(): Promise<WorktreeLedger[]> {
    const worktreesDir = path.join(this._dataDir, 'worktrees')
    const files = await listDir(worktreesDir)
    const ledgers: WorktreeLedger[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const ledger = await readJson<WorktreeLedger | null>(
        path.join(worktreesDir, file),
        null,
      )
      if (ledger) ledgers.push(ledger)
    }
    return ledgers
  }
}

async function chmodReadOnly(dirPath: string): Promise<void> {
  // chmod -R a-w <dir> but skip .claude/ subtree
  // We use a shell find command to apply permissions selectively
  await execFileAsync('find', [
    dirPath,
    '!', '-path', `${dirPath}/.claude/*`,
    '!', '-path', `${dirPath}/.claude`,
    '-exec', 'chmod', 'a-w', '{}', '+',
  ])
}
