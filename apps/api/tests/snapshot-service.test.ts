import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}))

vi.mock('@agent-hq-orchestron/file-store', () => {
  const store = new Map<string, unknown>()
  return {
    writeJson: vi.fn(async (p: string, v: unknown) => store.set(p, v)),
    readJson: vi.fn(async (p: string, fallback: unknown) => store.get(p) ?? fallback),
    listDir: vi.fn(async () => []),
    __store: store,
  }
})

import { execFile } from 'node:child_process'
import * as fileStore from '@agent-hq-orchestron/file-store'
import { SnapshotService } from '../src/domain/snapshot-service.js'
import { scanOrphans } from '../src/startup/orphan-scanner.js'
import type { GitHostAdapter } from '../src/adapters/git-host/registry.js'

const mockExecFile = vi.mocked(execFile)
const mockFileStore = fileStore as unknown as { __store: Map<string, unknown> }

function makeOkExec() {
  return (...args: unknown[]) => {
    // promisify(execFile) calls execFile(cmd, args, opts?, callback)
    const cb = args[args.length - 1] as (err: null, res: { stdout: string; stderr: string }) => void
    cb(null, { stdout: '', stderr: '' })
  }
}

function makeGitHostAdapter(baseRef = 'main'): GitHostAdapter {
  return {
    name: 'gh',
    detect: vi.fn().mockResolvedValue(true),
    pr: vi.fn().mockResolvedValue({
      number: 42,
      title: 'PR title',
      body: '',
      author: 'alice',
      baseRef,
      headRef: 'feature',
      diff: '',
      reviewers: [],
      comments: [],
      status: 'open',
    }),
    issue: vi.fn().mockResolvedValue({}),
  }
}

describe('SnapshotService - create + cleanup roundtrip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFileStore.__store.clear()
  })

  it('calls git worktree add and chmod, writes ledger', async () => {
    mockExecFile.mockImplementation(makeOkExec() as any)

    const svc = new SnapshotService('/data')
    const adapter = makeGitHostAdapter('main')

    const result = await svc.create({
      sessionUuid: 'uuid-123',
      prSource: '42',
      gitHostAdapter: adapter,
      projectPath: '/projects/myrepo',
    })

    expect(result.readOnly).toBe(true)
    expect(result.worktreePath).toContain('uuid-123')

    // git worktree add was called
    const worktreeAddCall = mockExecFile.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('worktree'),
    )
    expect(worktreeAddCall).toBeDefined()

    // chmod (find) was called
    const chmodCall = mockExecFile.mock.calls.find(
      (c) => c[0] === 'find',
    )
    expect(chmodCall).toBeDefined()

    // ledger written
    expect(vi.mocked(fileStore.writeJson)).toHaveBeenCalledOnce()
  })

  it('cleanup removes worktree and ledger', async () => {
    mockExecFile.mockImplementation(makeOkExec() as any)

    const svc = new SnapshotService('/data')
    const adapter = makeGitHostAdapter('main')

    await svc.create({
      sessionUuid: 'uuid-456',
      prSource: '10',
      gitHostAdapter: adapter,
      projectPath: '/projects/myrepo',
    })

    vi.clearAllMocks()
    mockExecFile.mockImplementation(makeOkExec() as any)

    const fsPromises = { unlink: vi.fn().mockResolvedValue(undefined) }
    vi.doMock('node:fs/promises', () => ({ default: fsPromises }))

    // Override readJson to return the ledger
    vi.mocked(fileStore.readJson).mockResolvedValueOnce({
      sessionUuid: 'uuid-456',
      worktreePath: '/tmp/orchestron-worktree/uuid-456',
      createdAt: '2026-09-01T00:00:00.000Z',
    })

    await svc.cleanup('uuid-456')

    // git worktree remove called
    const removeCall = mockExecFile.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('remove'),
    )
    expect(removeCall).toBeDefined()
  })
})

describe('scanOrphans', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFileStore.__store.clear()
  })

  it('cleans up worktrees for dead sessions', async () => {
    const ledger = {
      sessionUuid: 'dead-session',
      worktreePath: '/tmp/orchestron-worktree/dead-session',
      createdAt: '2026-09-01T00:00:00.000Z',
    }

    vi.mocked(fileStore.listDir).mockResolvedValueOnce(['dead-session.json'])
    vi.mocked(fileStore.readJson).mockResolvedValueOnce(ledger)

    const mockSvc = {
      listLedgers: vi.fn().mockResolvedValue([ledger]),
      cleanup: vi.fn().mockResolvedValue(undefined),
    } as unknown as SnapshotService

    const mockSessionManager = {
      list: vi.fn().mockResolvedValue([
        { id: 'active-session' },
      ]),
    } as any

    await scanOrphans(mockSvc, mockSessionManager)
    expect(mockSvc.cleanup).toHaveBeenCalledWith('dead-session')
  })

  it('does not clean up active sessions', async () => {
    const ledger = {
      sessionUuid: 'active-session',
      worktreePath: '/tmp/orchestron-worktree/active-session',
      createdAt: '2026-09-01T00:00:00.000Z',
    }

    const mockSvc = {
      listLedgers: vi.fn().mockResolvedValue([ledger]),
      cleanup: vi.fn().mockResolvedValue(undefined),
    } as unknown as SnapshotService

    const mockSessionManager = {
      list: vi.fn().mockResolvedValue([{ id: 'active-session' }]),
    } as any

    await scanOrphans(mockSvc, mockSessionManager)
    expect(mockSvc.cleanup).not.toHaveBeenCalled()
  })
})
