/**
 * Wire tests for `orchestron watch` and `orchestron batch`.
 *
 * Both spawn the real CLI binary against a stub HTTP server so we catch:
 * - command registration under the wrong name
 * - flags Commander never parses
 * - actual HTTP requests (method, path, body)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { writeFileSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY = path.join(__dirname, '../src/index.ts')
const TSX = path.join(__dirname, '../../../node_modules/.bin/tsx')

// ─── Stub server ─────────────────────────────────────────────────────────────

interface Captured {
  method: string
  url: string
  auth: string | undefined
}

let server: Server
let base: string
let captured: Captured[] = []
let dataDir: string

// Per-test request handler — set this in each test instead of modifying listeners.
let requestHandler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(os.tmpdir(), 'orch-wb-'))
  server = createServer((req, res) => {
    let _body = ''
    req.on('data', (c: Buffer) => { _body += c })
    req.on('end', () => {
      captured.push({ method: req.method ?? 'GET', url: req.url ?? '/', auth: req.headers.authorization })
      if (requestHandler) {
        requestHandler(req, res)
      } else {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'no handler set' }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => server.close())

beforeEach(() => {
  captured = []
  requestHandler = null
})

// ─── CLI runner ──────────────────────────────────────────────────────────────

interface Run {
  stdout: string
  stderr: string
  code: number
}

function cli(args: string[], opts: { timeout?: number } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const env = { ...process.env, ORCHESTRON_URL: base, ORCHESTRON_DATA_DIR: dataDir }
    const proc = spawn(TSX, [CLI_ENTRY, ...args], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    const timeout = opts.timeout ?? 10_000
    const timer = setTimeout(() => {
      proc.kill('SIGINT')
    }, timeout)
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code: code ?? 1 })
    })
  })
}

function jsonReply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// ─── watch tests ─────────────────────────────────────────────────────────────

const SESSION_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const ENTRIES_PHASE1 = [
  { seq: 0, timestamp: '2026-09-12T10:00:00.000Z', kind: 'user', content: 'Hello' },
  { seq: 1, timestamp: '2026-09-12T10:00:01.000Z', kind: 'assistant', content: 'Hi there' },
]
const ENTRIES_PHASE2 = [
  ...ENTRIES_PHASE1,
  { seq: 2, timestamp: '2026-09-12T10:00:02.000Z', kind: 'tool_use', toolName: 'bash', content: 'ls /' },
  { seq: 3, timestamp: '2026-09-12T10:00:03.000Z', kind: 'tool_result', content: 'bin etc home' },
]

describe('orchestron watch', () => {
  it('prints new transcript entries incrementally then exits on terminal status', async () => {
    let callCount = 0
    requestHandler = (req, res) => {
      callCount++
      const url = req.url ?? '/'
      if (url.includes('/transcript')) {
        const entries = callCount <= 2 ? ENTRIES_PHASE1 : ENTRIES_PHASE2
        jsonReply(res, 200, { entries, size: 0 })
      } else if (url.includes(`/sessions/${SESSION_UUID}`)) {
        const status = callCount >= 4 ? 'succeeded' : 'running'
        jsonReply(res, 200, { id: SESSION_UUID, status })
      } else {
        jsonReply(res, 404, { error: 'not found' })
      }
    }

    const run = await cli(
      ['watch', SESSION_UUID, '--interval', '100'],
      { timeout: 8_000 },
    )

    expect(run.stdout).toContain('Hello')
    expect(run.stdout).toContain('Hi there')
    // New entries from phase 2 also appear
    expect(run.stdout).toContain('ls /')
    // Footer in stderr about terminal
    expect(run.stderr).toMatch(/succeeded|terminal/)
    expect(run.code).toBe(0)
  })

  it('exits gracefully on 404 (session not found)', async () => {
    requestHandler = (_req, res) => {
      jsonReply(res, 404, { error: 'Session not found' })
    }

    const run = await cli(
      ['watch', SESSION_UUID, '--interval', '100'],
      { timeout: 5_000 },
    )

    expect(run.code).toBe(0)
    expect(run.stderr).toMatch(/not found|archived/)
  })

  it('--raw flag emits JSON lines without ANSI color codes', async () => {
    let callCount = 0
    requestHandler = (req, res) => {
      callCount++
      const url = req.url ?? '/'
      if (url.includes('/transcript')) {
        jsonReply(res, 200, { entries: ENTRIES_PHASE1, size: 0 })
      } else {
        jsonReply(res, 200, { id: SESSION_UUID, status: callCount >= 2 ? 'succeeded' : 'running' })
      }
    }

    const run = await cli(
      ['watch', SESSION_UUID, '--interval', '100', '--raw'],
      { timeout: 5_000 },
    )

    // Each non-empty line should be valid JSON
    const lines = run.stdout.split('\n').filter((l) => l.trim())
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    // stdout must be free of ANSI escape codes
    expect(run.stdout).not.toMatch(/\x1b\[/)
    // stderr is silent in raw mode
    expect(run.stderr).toBe('')
  })

  it('polls GET /api/sessions/:uuid/transcript (not SSE endpoint)', async () => {
    let callCount = 0
    requestHandler = (req, res) => {
      callCount++
      const url = req.url ?? '/'
      if (url.includes('/transcript')) {
        jsonReply(res, 200, { entries: ENTRIES_PHASE1, size: 0 })
      } else {
        // terminal on first status call so watch exits quickly
        jsonReply(res, 200, { id: SESSION_UUID, status: 'succeeded' })
      }
    }

    await cli(['watch', SESSION_UUID, '--interval', '100'], { timeout: 5_000 })

    const transcriptCalls = captured.filter((c) => c.url.includes('/transcript'))
    expect(transcriptCalls.length).toBeGreaterThanOrEqual(1)
    for (const c of transcriptCalls) {
      expect(c.method).toBe('GET')
    }
  })
})

// ─── batch tests ─────────────────────────────────────────────────────────────

describe('orchestron batch', () => {
  it('runs all steps and prints summary on success', async () => {
    requestHandler = (req, res) => {
      const url = req.url ?? '/'
      if (url.includes('/sessions')) {
        jsonReply(res, 200, { sessions: [] })
      } else if (url.includes('/projects')) {
        jsonReply(res, 200, { projects: [] })
      } else {
        jsonReply(res, 404, { error: 'not found' })
      }
    }

    const batchFile = path.join(dataDir, 'test-batch.yaml')
    writeFileSync(
      batchFile,
      `steps:
  - name: list sessions
    cmd: session
    args:
      - list
      - --json
  - name: list projects
    cmd: project
    args:
      - list
      - --json
`,
    )

    const run = await cli(['batch', batchFile], { timeout: 30_000 })

    expect(run.stdout).toContain('list sessions')
    expect(run.stdout).toContain('list projects')
    expect(run.stdout).toContain('Batch summary')
    expect(run.code).toBe(0)
  })

  it('skips step when if_prev_success is true and prior step failed', async () => {
    requestHandler = (_req, res) => {
      jsonReply(res, 500, { error: 'server error' })
    }

    const batchFile = path.join(dataDir, 'test-batch-skip.yaml')
    writeFileSync(
      batchFile,
      `steps:
  - name: failing step
    cmd: session
    args:
      - list
      - --json
  - name: skipped step
    cmd: session
    args:
      - list
      - --json
    if_prev_success: true
`,
    )

    const run = await cli(['batch', batchFile], { timeout: 30_000 })

    expect(run.stdout).toContain('skipped step')
    expect(run.stdout).toContain('skip')
    expect(run.code).toBe(1)
  })

  it('--continue-on-error runs all steps even on failure', async () => {
    let callCount = 0
    requestHandler = (req, res) => {
      callCount++
      const url = req.url ?? '/'
      if (callCount <= 2 || url.includes('/sessions')) {
        jsonReply(res, 500, { error: 'server error' })
      } else {
        jsonReply(res, 200, { projects: [] })
      }
    }

    const batchFile = path.join(dataDir, 'test-batch-continue.yaml')
    writeFileSync(
      batchFile,
      `steps:
  - name: failing step
    cmd: session
    args:
      - list
      - --json
  - name: continues anyway
    cmd: project
    args:
      - list
      - --json
`,
    )

    const run = await cli(['batch', batchFile, '--continue-on-error'], { timeout: 30_000 })

    // Both step names appear in output
    expect(run.stdout).toContain('failing step')
    expect(run.stdout).toContain('continues anyway')
    expect(run.code).toBe(1)
  })

  it('--dry-run prints steps without making any HTTP requests', async () => {
    const batchFile = path.join(dataDir, 'test-batch-dry.yaml')
    writeFileSync(
      batchFile,
      `steps:
  - name: step one
    cmd: session
    args:
      - list
`,
    )

    const run = await cli(['batch', batchFile, '--dry-run'], { timeout: 5_000 })

    expect(run.stdout).toContain('step one')
    // No HTTP requests made
    expect(captured.length).toBe(0)
    expect(run.code).toBe(0)
  })

  it('rejects missing file gracefully', async () => {
    const run = await cli(['batch', '/nonexistent/batch.yaml'], { timeout: 5_000 })
    expect(run.stderr).toMatch(/Cannot read|Error/)
    expect(run.code).toBe(1)
  })

  it('rejects invalid YAML schema gracefully', async () => {
    const batchFile = path.join(dataDir, 'test-batch-bad.yaml')
    writeFileSync(batchFile, 'not_steps:\n  - name: x\n')

    const run = await cli(['batch', batchFile], { timeout: 5_000 })
    expect(run.stderr).toMatch(/Invalid batch|Error/)
    expect(run.code).toBe(1)
  })
})
