import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { listDir } from '../src/index.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'list-dir-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('listDir', () => {
  it('returns empty array for empty dir', async () => {
    const result = await listDir(tmpDir)
    expect(result).toEqual([])
  })

  it('returns only .json files, skipping .bak', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.json'), '{}')
    fs.writeFileSync(path.join(tmpDir, 'b.json'), '{}')
    fs.writeFileSync(path.join(tmpDir, 'a.json.bak'), '{}')

    const result = await listDir(tmpDir)
    expect(result.sort()).toEqual(['a.json', 'b.json'])
  })

  it('skips hidden files (starting with .)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'visible.json'), '{}')
    fs.writeFileSync(path.join(tmpDir, '.hidden'), '{}')

    const result = await listDir(tmpDir)
    expect(result).toEqual(['visible.json'])
  })

  it('returns empty array for nonexistent dir', async () => {
    const result = await listDir(path.join(tmpDir, 'does-not-exist'))
    expect(result).toEqual([])
  })
})
