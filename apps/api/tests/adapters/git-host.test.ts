import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock execFile and fs before imports
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}))
vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
  },
}))
vi.mock('node:fs/promises', () => ({
  default: {
    stat: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
  },
}))

import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { GhAdapter, ghAdapterOrNull } from '../../src/adapters/git-host/gh.js'
import { BbAdapter, bbAdapterOrNull } from '../../src/adapters/git-host/bb.js'
import { resolveGitHostAdapter } from '../../src/adapters/git-host/registry.js'

const mockExecFile = vi.mocked(execFile)

function makeExecResult(stdout: string) {
  return (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: null, result: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout, stderr: '' })
  }
}

function makeExecError(msg: string) {
  return (_cmd: unknown, _args: unknown, _opts: unknown, cb: (err: Error) => void) => {
    cb(new Error(msg))
  }
}

describe('GhAdapter - detection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('detects github.com remote URL', async () => {
    mockExecFile.mockImplementationOnce(makeExecResult('https://github.com/org/repo.git\n') as any)
    const adapter = new GhAdapter()
    expect(await adapter.detect('/some/path')).toBe(true)
  })

  it('returns false for bitbucket remote', async () => {
    mockExecFile.mockImplementationOnce(makeExecResult('https://bitbucket.org/org/repo.git\n') as any)
    const adapter = new GhAdapter()
    expect(await adapter.detect('/some/path')).toBe(false)
  })

  it('returns false when git command fails', async () => {
    mockExecFile.mockImplementationOnce(makeExecError('not a git repo') as any)
    const adapter = new GhAdapter()
    expect(await adapter.detect('/some/path')).toBe(false)
  })
})

describe('GhAdapter - whitelist', () => {
  it('throws on blocked subcommand merge', () => {
    expect(() => GhAdapter.assertAllowed('merge')).toThrow(/not allowed/)
  })

  it('throws on blocked subcommand close', () => {
    expect(() => GhAdapter.assertAllowed('close')).toThrow(/not allowed/)
  })

  it('does not throw on view', () => {
    expect(() => GhAdapter.assertAllowed('view')).not.toThrow()
  })
})

describe('GhAdapter - pr cache hit', () => {
  it('skips exec when cache is fresh', async () => {
    const { default: fsPromises } = await import('node:fs/promises')
    const mockStat = vi.mocked(fsPromises.stat)
    const mockReadFile = vi.mocked(fsPromises.readFile)

    const prData = {
      number: 42,
      title: 'test PR',
      body: 'body',
      author: 'alice',
      baseRef: 'main',
      headRef: 'feature',
      diff: '',
      reviewers: [],
      comments: [],
      status: 'open',
    }

    // cache is fresh (mtime is recent)
    mockStat.mockResolvedValueOnce({ mtimeMs: Date.now() - 1000 } as any)
    mockReadFile.mockResolvedValueOnce(JSON.stringify(prData) as any)

    const adapter = new GhAdapter()
    const result = await adapter.pr(42)
    expect(result.title).toBe('test PR')

    // execFile should NOT have been called for pr view
    expect(mockExecFile).not.toHaveBeenCalledWith('gh', expect.anything(), expect.anything())
  })
})

describe('BbAdapter - detection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('detects bitbucket.org remote URL', async () => {
    mockExecFile.mockImplementationOnce(makeExecResult('https://bitbucket.org/org/repo.git\n') as any)
    const adapter = new BbAdapter('/some/path')
    expect(await adapter.detect('/some/path')).toBe(true)
  })

  it('returns false for github remote', async () => {
    mockExecFile.mockImplementationOnce(makeExecResult('https://github.com/org/repo.git\n') as any)
    const adapter = new BbAdapter('/some/path')
    expect(await adapter.detect('/some/path')).toBe(false)
  })
})

describe('BbAdapter - whitelist', () => {
  it('throws on merge', () => {
    expect(() => BbAdapter.assertAllowed('merge')).toThrow(/not allowed/)
  })

  it('throws on delete', () => {
    expect(() => BbAdapter.assertAllowed('delete')).toThrow(/not allowed/)
  })

  it('allows view', () => {
    expect(() => BbAdapter.assertAllowed('view')).not.toThrow()
  })
})

describe('resolveGitHostAdapter - routing', () => {
  beforeEach(() => vi.clearAllMocks())

  it('routes github.com to gh adapter', async () => {
    mockExecFile.mockImplementationOnce(makeExecResult('https://github.com/org/repo.git\n') as any)
    const adapter = await resolveGitHostAdapter('/some/path')
    expect(adapter?.name).toBe('gh')
  })

  it('routes bitbucket.org to bb adapter', async () => {
    mockExecFile.mockImplementationOnce(makeExecResult('git@bitbucket.org:org/repo.git\n') as any)
    const adapter = await resolveGitHostAdapter('/some/path')
    expect(adapter?.name).toBe('bb')
  })

  it('returns null for unknown remote', async () => {
    mockExecFile.mockImplementationOnce(makeExecResult('https://gitlab.com/org/repo.git\n') as any)
    const adapter = await resolveGitHostAdapter('/some/path')
    expect(adapter).toBeNull()
  })

  it('returns null when git fails', async () => {
    mockExecFile.mockImplementationOnce(makeExecError('not a git repo') as any)
    const adapter = await resolveGitHostAdapter('/some/path')
    expect(adapter).toBeNull()
  })
})

describe('ghAdapterOrNull', () => {
  it('returns GhAdapter when gh binary found in PATH', async () => {
    const fs = (await import('node:fs')).default
    vi.mocked(fs.existsSync).mockReturnValue(true)
    const adapter = ghAdapterOrNull()
    expect(adapter).toBeInstanceOf(GhAdapter)
  })
})
