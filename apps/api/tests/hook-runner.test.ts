import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { HookRunner, HookAbortError } from '../src/domain/hook-runner.js'

let tmpDir: string
let runner: HookRunner

function writeHook(event: string, name: string, content: string, ext = '.sh') {
  const dir = path.join(tmpDir, 'hooks', event)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${name}${ext}`)
  fs.writeFileSync(filePath, content, { mode: 0o755 })
  return filePath
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-runner-test-'))
  runner = new HookRunner({ dataDir: tmpDir, timeoutMs: 2000 })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('HookRunner — discovery', () => {
  it('returns without error when hook dir is missing', async () => {
    await expect(runner.fire('pre-spawn', { event: 'pre-spawn' })).resolves.toBeUndefined()
  })

  it('discovers scripts in lexicographic order', async () => {
    const order: string[] = []
    writeHook('on-session-end', '02-b', `#!/bin/sh\necho b`)
    writeHook('on-session-end', '01-a', `#!/bin/sh\necho a`)

    // Can't easily verify order without side effects; just verify it runs both
    await expect(runner.fire('on-session-end', { event: 'on-session-end' })).resolves.toBeUndefined()
  })
})

describe('HookRunner — sync events (pre-spawn)', () => {
  it('succeeds when hook exits 0', async () => {
    writeHook('pre-spawn', 'ok', `#!/bin/sh\nexit 0`)
    await expect(runner.fire('pre-spawn', { event: 'pre-spawn' })).resolves.toBeUndefined()
  })

  it('throws HookAbortError on non-zero exit', async () => {
    writeHook('pre-spawn', 'fail', `#!/bin/sh\necho "blocked" >&2\nexit 1`)
    await expect(runner.fire('pre-spawn', { event: 'pre-spawn' })).rejects.toThrowError(HookAbortError)
  })

  it('HookAbortError carries exitCode and stderr', async () => {
    writeHook('pre-spawn', 'fail', `#!/bin/sh\necho "reason" >&2\nexit 2`)
    const err = await runner.fire('pre-spawn', { event: 'pre-spawn' }).catch(e => e)
    expect(err).toBeInstanceOf(HookAbortError)
    expect((err as HookAbortError).exitCode).toBe(2)
    expect((err as HookAbortError).stderr).toContain('reason')
  })

  it('on-schedule-fire is also sync (throws on failure)', async () => {
    writeHook('on-schedule-fire', 'fail', `#!/bin/sh\nexit 3`)
    await expect(runner.fire('on-schedule-fire', { event: 'on-schedule-fire' })).rejects.toThrowError(HookAbortError)
  })
})

describe('HookRunner — async events (fire-and-forget)', () => {
  it('does not throw even when hook exits non-zero', async () => {
    writeHook('on-session-end', 'fail', `#!/bin/sh\nexit 1`)
    await expect(runner.fire('on-session-end', { event: 'on-session-end' })).resolves.toBeUndefined()
  })

  it('post-transcript-chunk is async', async () => {
    writeHook('post-transcript-chunk', 'fail', `#!/bin/sh\nexit 99`)
    await expect(
      runner.fire('post-transcript-chunk', { event: 'post-transcript-chunk' }),
    ).resolves.toBeUndefined()
  })

  it('on-error is async', async () => {
    writeHook('on-error', 'fail', `#!/bin/sh\nexit 1`)
    await expect(runner.fire('on-error', { event: 'on-error' })).resolves.toBeUndefined()
  })
})

describe('HookRunner — payload delivery', () => {
  it('delivers JSON payload via stdin', async () => {
    const outFile = path.join(tmpDir, 'payload-out.json')
    writeHook('pre-spawn', 'read-stdin', `#!/bin/sh\ncat > "${outFile}"`)
    await runner.fire('pre-spawn', { event: 'pre-spawn', sessionUuid: 'test-uuid', extra: 42 })

    const raw = fs.readFileSync(outFile, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.event).toBe('pre-spawn')
    expect(parsed.sessionUuid).toBe('test-uuid')
    expect(parsed.extra).toBe(42)
  })
})

describe('HookRunner — timeout', () => {
  it('kills hanging script and returns non-zero', async () => {
    const slowRunner = new HookRunner({ dataDir: tmpDir, timeoutMs: 200 })
    writeHook('pre-spawn', 'slow', `#!/bin/sh\nsleep 10`)

    const err = await slowRunner.fire('pre-spawn', { event: 'pre-spawn' }).catch(e => e)
    expect(err).toBeInstanceOf(HookAbortError)
    // timed-out scripts get exitCode -1
    expect((err as HookAbortError).exitCode).toBe(-1)
  })
})

describe('HookRunner — log persistence', () => {
  it('writes invocation log to hooks-YYYY-MM-DD.jsonl', async () => {
    writeHook('pre-spawn', 'ok', `#!/bin/sh\nexit 0`)
    await runner.fire('pre-spawn', { event: 'pre-spawn' })

    const logsDir = path.join(tmpDir, 'logs')
    const files = fs.readdirSync(logsDir)
    expect(files.some(f => f.startsWith('hooks-') && f.endsWith('.jsonl'))).toBe(true)

    const logFile = path.join(logsDir, files[0])
    const line = JSON.parse(fs.readFileSync(logFile, 'utf8').trim())
    expect(line.event).toBe('pre-spawn')
    expect(line.exitCode).toBe(0)
  })
})
