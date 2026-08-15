import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { writeJson, readJson, appendJsonl, readJsonlFrom } from '../src/index.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-store-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('writeJson / readJson', () => {
  it('writes and reads back JSON', async () => {
    const filePath = path.join(tmpDir, 'test.json')
    const data = { id: '123', name: 'Alice', count: 42 }

    await writeJson(filePath, data)
    const result = await readJson(filePath, null)

    expect(result).toEqual(data)
  })

  it('creates .bak on second write', async () => {
    const filePath = path.join(tmpDir, 'test.json')

    await writeJson(filePath, { v: 1 })
    await writeJson(filePath, { v: 2 })

    expect(fs.existsSync(`${filePath}.bak`)).toBe(true)

    const bak = await readJson(`${filePath}.bak`, null)
    expect(bak).toEqual({ v: 1 })
  })

  it('recovers from .bak when main is corrupt', async () => {
    const filePath = path.join(tmpDir, 'test.json')

    await writeJson(filePath, { v: 1 })
    await writeJson(filePath, { v: 2 })

    // corrupt main file
    fs.writeFileSync(filePath, 'INVALID JSON!!!')

    const result = await readJson(filePath, null)
    expect(result).toEqual({ v: 1 })
  })

  it('returns fallback when file does not exist', async () => {
    const filePath = path.join(tmpDir, 'nonexistent.json')
    const result = await readJson(filePath, { default: true })
    expect(result).toEqual({ default: true })
  })
})

describe('appendJsonl / readJsonlFrom', () => {
  it('appends and reads JSONL events', async () => {
    const filePath = path.join(tmpDir, 'events.jsonl')

    await appendJsonl(filePath, { type: 'start', ts: 1 })
    await appendJsonl(filePath, { type: 'message', ts: 2 })
    await appendJsonl(filePath, { type: 'end', ts: 3 })

    const { lines } = await readJsonlFrom(filePath, 0)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toEqual({ type: 'start', ts: 1 })
    expect(lines[2]).toEqual({ type: 'end', ts: 3 })
  })

  it('reads from offset (incremental tail)', async () => {
    const filePath = path.join(tmpDir, 'events.jsonl')

    await appendJsonl(filePath, { seq: 1 })
    const { newOffset } = await readJsonlFrom(filePath, 0)

    await appendJsonl(filePath, { seq: 2 })
    const { lines } = await readJsonlFrom(filePath, newOffset)

    expect(lines).toHaveLength(1)
    expect(lines[0]).toEqual({ seq: 2 })
  })

  it('returns empty when at EOF', async () => {
    const filePath = path.join(tmpDir, 'events.jsonl')
    await appendJsonl(filePath, { seq: 1 })
    const { newOffset } = await readJsonlFrom(filePath, 0)
    const { lines } = await readJsonlFrom(filePath, newOffset)
    expect(lines).toHaveLength(0)
  })
})
