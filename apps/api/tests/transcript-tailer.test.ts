import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TranscriptTailer, type TailerEvent } from '../src/streaming/transcript-tailer.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tailer-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeLines(filePath: string, lines: unknown[]) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n'
  fs.writeFileSync(filePath, content, 'utf8')
}

function appendLine(filePath: string, line: unknown) {
  fs.appendFileSync(filePath, JSON.stringify(line) + '\n', 'utf8')
}

async function collectN(tailer: TranscriptTailer, n: number): Promise<TailerEvent[]> {
  return new Promise((resolve, reject) => {
    const events: TailerEvent[] = []
    const timer = setTimeout(() => {
      tailer.close()
      reject(new Error(`Timeout: only received ${events.length}/${n} events`))
    }, 5000)

    tailer.on('event', (ev: TailerEvent) => {
      events.push(ev)
      if (events.length >= n) {
        clearTimeout(timer)
        resolve(events)
      }
    })
  })
}

describe('TranscriptTailer — existing content', () => {
  it('emits lines from existing jsonl', async () => {
    const jsonlPath = path.join(tmpDir, 'test.jsonl')
    writeLines(jsonlPath, [{ a: 1 }, { b: 2 }])

    const tailer = new TranscriptTailer('test-uuid', jsonlPath, tmpDir)
    const [collect, start] = [collectN(tailer, 2), tailer.start()]
    const events = await collect
    await start
    tailer.close()

    expect(events).toHaveLength(2)
    expect((events[0].event as { a: number }).a).toBe(1)
    expect((events[1].event as { b: number }).b).toBe(2)
  })

  it('emits 100 lines correctly', async () => {
    const jsonlPath = path.join(tmpDir, 'hundred.jsonl')
    const lines = Array.from({ length: 100 }, (_, i) => ({ idx: i }))
    writeLines(jsonlPath, lines)

    const tailer = new TranscriptTailer('uuid-100', jsonlPath, tmpDir)
    const [collect, start] = [collectN(tailer, 100), tailer.start()]
    const events = await collect
    await start
    tailer.close()

    expect(events).toHaveLength(100)
    expect((events[99].event as { idx: number }).idx).toBe(99)
  })
})

describe('TranscriptTailer — offset persistence', () => {
  it('persists offset to sessions/<uuid>.offset file', async () => {
    const jsonlPath = path.join(tmpDir, 'off.jsonl')
    writeLines(jsonlPath, [{ x: 1 }])

    const tailer = new TranscriptTailer('offset-uuid', jsonlPath, tmpDir)
    const [collect, start] = [collectN(tailer, 1), tailer.start()]
    await collect
    await start
    tailer.close()

    // Wait briefly for the debounced offset write
    await new Promise(r => setTimeout(r, 100))

    const offsetFile = path.join(tmpDir, 'sessions', 'offset-uuid.offset')
    expect(fs.existsSync(offsetFile)).toBe(true)
    const offsetValue = parseInt(fs.readFileSync(offsetFile, 'utf8').trim(), 10)
    expect(offsetValue).toBeGreaterThan(0)
  })

  it('resumes from persisted offset without duplicate', async () => {
    const jsonlPath = path.join(tmpDir, 'resume.jsonl')
    const sessionsDir = path.join(tmpDir, 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })

    // Write line 1
    writeLines(jsonlPath, [{ seq: 1 }])
    const size = fs.statSync(jsonlPath).size

    // Persist offset at end of line 1
    fs.writeFileSync(path.join(sessionsDir, 'resume-uuid.offset'), String(size), 'utf8')

    // Append line 2
    appendLine(jsonlPath, { seq: 2 })

    // New tailer — should only emit line 2 (resume from saved offset)
    const tailer = new TranscriptTailer('resume-uuid', jsonlPath, tmpDir, 0)
    const [collect, start] = [collectN(tailer, 1), tailer.start()]
    const events = await collect
    await start
    tailer.close()

    expect(events).toHaveLength(1)
    expect((events[0].event as { seq: number }).seq).toBe(2)
  })
})

describe('TranscriptTailer — malformed lines', () => {
  it('skips malformed JSON lines and continues', async () => {
    const jsonlPath = path.join(tmpDir, 'malformed.jsonl')
    fs.mkdirSync(path.dirname(jsonlPath), { recursive: true })
    fs.writeFileSync(jsonlPath, '{"ok":1}\nnot-json\n{"ok":2}\n', 'utf8')

    const tailer = new TranscriptTailer('malform-uuid', jsonlPath, tmpDir)
    const [collect, start] = [collectN(tailer, 2), tailer.start()]
    const events = await collect
    await start
    tailer.close()

    expect(events).toHaveLength(2)
    expect((events[0].event as { ok: number }).ok).toBe(1)
    expect((events[1].event as { ok: number }).ok).toBe(2)
  })
})

describe('TranscriptTailer — watch for new content', () => {
  it('emits events when file is appended after start', async () => {
    const jsonlPath = path.join(tmpDir, 'watch.jsonl')
    fs.mkdirSync(path.dirname(jsonlPath), { recursive: true })
    fs.writeFileSync(jsonlPath, '', 'utf8')

    const tailer = new TranscriptTailer('watch-uuid', jsonlPath, tmpDir)
    const collect = collectN(tailer, 1)
    await tailer.start()

    // Append after start
    setTimeout(() => appendLine(jsonlPath, { new: true }), 50)

    const events = await collect
    tailer.close()

    expect(events[0].sessionUuid).toBe('watch-uuid')
    expect((events[0].event as { new: boolean }).new).toBe(true)
  })
})
