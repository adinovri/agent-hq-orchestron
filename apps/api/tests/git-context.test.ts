import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { resolveGitContext } from '../src/domain/git-context.js'

describe('resolveGitContext — non-git directory', () => {
  it('returns empty strings without throwing', async () => {
    const ctx = await resolveGitContext(os.tmpdir())
    expect(ctx.branch).toBe('')
    expect(ctx.status).toBe('')
    expect(ctx.diff).toBe('')
  })

  it('log() returns empty string in non-git dir', async () => {
    const ctx = await resolveGitContext(os.tmpdir())
    const log = await ctx.log(5)
    expect(log).toBe('')
  })
})

describe('resolveGitContext — git directory', () => {
  it('returns non-empty branch in a real git repo', async () => {
    // The project root is a git repo
    const repoDir = path.resolve(process.cwd())
    const ctx = await resolveGitContext(repoDir)
    expect(typeof ctx.branch).toBe('string')
    expect(ctx.branch.length).toBeGreaterThan(0)
  })

  it('log(N) returns string output', async () => {
    const repoDir = path.resolve(process.cwd())
    const ctx = await resolveGitContext(repoDir)
    const log = await ctx.log(3)
    expect(typeof log).toBe('string')
  })
})
