import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY = path.join(__dirname, '../src/index.ts')
/** The local binary, not `npx tsx` — `npx` re-resolves the package on every
 *  one of the ~40 spawns in this file, which is most of its wall clock. */
const TSX = path.join(__dirname, '../../../node_modules/.bin/tsx')

/**
 * Wire-level tests: run the real CLI against a stub API and assert on the
 * HTTP request it produced.
 *
 * The point of this batch is that the TUI and the Phase 3 executor can drive
 * orchestron without the web UI, so what matters is the request — the method,
 * the path, and every field of the body. A mocked `fetch` inside the process
 * would not catch a command registered under the wrong name, a flag Commander
 * never parsed, or a `--json` envelope that is not parseable; spawning the
 * binary does.
 */

interface Captured {
  method: string
  url: string
  auth: string | undefined
  contentType: string | undefined
  body: string
}

let server: Server
let base: string
let captured: Captured[] = []
let dataDir: string
/** Route key (`METHOD /path`) -> [status, body]. Query strings are stripped. */
let routes: Record<string, [number, unknown, Record<string, string>?]> = {}

const SESSION = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  agentType: 'claude',
  status: 'idle',
  model: 'claude-haiku-4-5',
  effort: 'low',
  useTmux: false,
  tmuxName: 'orch-test',
  claudeSessionUuid: '33333333-3333-4333-8333-333333333333',
  costUsd: 0.1234,
  startedAt: '2026-09-11T00:00:00.000Z',
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wire-'))
  // Hermetic: never let the CLI fall through to the operator's real
  // ~/.orchestron/config.json for a host or a bearer.
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{}')

  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      captured.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        body,
      })
      const pathOnly = (req.url ?? '').split('?')[0]
      const entry = routes[`${req.method} ${pathOnly}`]
      if (!entry) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `stub has no route for ${req.method} ${pathOnly}` }))
        return
      }
      const [status, payload, headers] = entry
      if (status === 204) {
        res.writeHead(204)
        res.end()
        return
      }
      if (typeof payload === 'string') {
        res.writeHead(status, { 'content-type': 'text/plain', ...(headers ?? {}) })
        res.end(payload)
        return
      }
      res.writeHead(status, { 'content-type': 'application/json', ...(headers ?? {}) })
      res.end(JSON.stringify(payload))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(dataDir, { recursive: true, force: true })
})

interface Run {
  stdout: string
  stderr: string
  code: number
  json: Record<string, unknown>
  requests: Captured[]
}

async function cli(args: string[], opts: { input?: string } = {}): Promise<Run> {
  captured = []
  const full = [CLI_ENTRY, ...args, '--url', base, '--token', 'wire-test-token', '--json']
  let stdout = ''
  let stderr = ''
  let code = 0
  try {
    const child = execFileAsync(TSX, full, {
      env: { ...process.env, ORCHESTRON_DATA_DIR: dataDir, NO_COLOR: '1' },
    })
    if (opts.input !== undefined) {
      child.child.stdin?.end(opts.input)
    }
    const r = await child
    stdout = r.stdout
    stderr = r.stderr
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; code?: number }
    stdout = err.stdout ?? ''
    stderr = err.stderr ?? ''
    code = err.code ?? 1
  }
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    /* asserted on by the caller when it matters */
  }
  return { stdout, stderr, code, json, requests: captured }
}

function bodyOf(req: Captured): Record<string, unknown> {
  return JSON.parse(req.body) as Record<string, unknown>
}

const S = SESSION.id

describe('list commands read the envelope the API actually sends', () => {
  it('session list unwraps { sessions } and pushes every filter to the query', async () => {
    // `GET /api/sessions` answers an object, not an array. The CLI used to
    // destructure it as an array, so every real `session list` died on
    // "sessions is not iterable" — invisible to a stub that returns whatever
    // shape the test author assumed.
    routes = { 'GET /api/sessions': [200, { sessions: [SESSION] }] }
    const r = await cli(['session', 'list', '--project', SESSION.projectId, '--status', 'idle', '--tag', 'a,b'])
    expect(r.code).toBe(0)
    const q = new URLSearchParams(r.requests[0]!.url.split('?')[1])
    expect(q.get('projectId')).toBe(SESSION.projectId)
    expect(q.get('status')).toBe('idle')
    expect(q.get('tag')).toBe('a,b')
    expect(r.json).toMatchObject({ ok: true, count: 1 })
  })

  it('session list with no filters sends no query string at all', async () => {
    routes = { 'GET /api/sessions': [200, { sessions: [] }] }
    const r = await cli(['session', 'list'])
    expect(r.requests[0]!.url).toBe('/api/sessions')
    expect(r.json).toMatchObject({ ok: true, count: 0 })
  })

  it('project list unwraps { projects }', async () => {
    routes = { 'GET /api/projects': [200, { projects: [{ id: 'p1', name: 'web', path: '/tmp', agentType: 'claude' }] }] }
    const r = await cli(['project', 'list', '--group', 'frontend'])
    expect(r.code).toBe(0)
    expect(new URLSearchParams(r.requests[0]!.url.split('?')[1]).get('group')).toBe('frontend')
    expect(r.json).toMatchObject({ ok: true, count: 1 })
  })

  it('session get returns the bare record — that route really is unwrapped', async () => {
    routes = { [`GET /api/sessions/${SESSION.id}`]: [200, SESSION] }
    const r = await cli(['session', 'get', SESSION.id])
    expect(r.json).toMatchObject({ ok: true, session: { id: SESSION.id } })
  })
})

describe('session mutations hit the right endpoint with the right body', () => {
  it('spawn sends every override and reports the new id', async () => {
    routes = { 'POST /api/sessions': [201, SESSION] }
    const r = await cli([
      'session', 'spawn',
      '--project', SESSION.projectId,
      '--prompt', 'do the thing',
      '--model', 'claude-haiku-4-5',
      '--effort', 'low',
      '--headless',
      '--var', 'env=stg',
    ])
    expect(r.code).toBe(0)
    const req = r.requests[0]!
    expect(`${req.method} ${req.url}`).toBe('POST /api/sessions')
    expect(req.auth).toBe('Bearer wire-test-token')
    expect(bodyOf(req)).toEqual({
      projectId: SESSION.projectId,
      prompt: 'do the thing',
      vars: { env: 'stg' },
      model: 'claude-haiku-4-5',
      effort: 'low',
      useTmux: false,
    })
    expect(r.json).toMatchObject({ ok: true, id: S, useTmux: false })
  })

  it('spawn reads a long prompt from stdin when --prompt is absent', async () => {
    routes = { 'POST /api/sessions': [201, SESSION] }
    const r = await cli(['session', 'spawn', '--project', SESSION.projectId], { input: 'line one\nline two\n' })
    expect(r.code).toBe(0)
    expect(bodyOf(r.requests[0]!)['prompt']).toBe('line one\nline two')
  })

  it('spawn with an attachment switches to multipart and keeps the payload in one JSON field', async () => {
    routes = { 'POST /api/sessions': [201, SESSION] }
    const file = path.join(dataDir, 'attach.txt')
    fs.writeFileSync(file, 'hello from a file')
    const r = await cli(['session', 'spawn', '--project', SESSION.projectId, '--prompt', 'p', '--attachment', file])
    expect(r.code).toBe(0)
    const req = r.requests[0]!
    expect(req.contentType).toMatch(/multipart\/form-data/)
    expect(req.body).toContain('name="body"')
    expect(req.body).toContain('name="file"; filename="attach.txt"')
    expect(req.body).toContain('hello from a file')
    expect(r.json).toMatchObject({ ok: true, attachments: 1 })
  })

  it('spawn fails before any request when the attachment does not exist', async () => {
    routes = { 'POST /api/sessions': [201, SESSION] }
    const r = await cli(['session', 'spawn', '--project', SESSION.projectId, '--prompt', 'p', '--attachment', '/no/such/file'])
    expect(r.code).not.toBe(0)
    expect(r.requests).toHaveLength(0)
    expect(r.json).toMatchObject({ ok: false })
    expect(String(r.json['error'])).toMatch(/attachment not found/)
  })

  it('reopen sends only what was asked for — an untouched mode stays absent', async () => {
    routes = { [`POST /api/sessions/${S}/reopen`]: [200, SESSION] }
    const r = await cli(['session', 'reopen', S, '--model', 'claude-opus-5'])
    expect(r.code).toBe(0)
    // No useTmux key at all: the route reads absent as "keep this session's
    // mode", and sending `true` would migrate a headless session to tmux.
    expect(bodyOf(r.requests[0]!)).toEqual({ model: 'claude-opus-5' })
  })

  it('reopen --tmux does send the explicit override', async () => {
    routes = { [`POST /api/sessions/${S}/reopen`]: [200, SESSION] }
    const r = await cli(['session', 'reopen', S, '--tmux'])
    expect(bodyOf(r.requests[0]!)).toEqual({ useTmux: true })
  })

  it('fork posts to /clone and can seed a new turn', async () => {
    routes = { [`POST /api/sessions/${S}/clone`]: [201, { ...SESSION, id: 'forked-id' }] }
    const r = await cli(['session', 'fork', S, '--prompt', 'try another way', '--effort', 'high'])
    expect(r.requests[0]!.url).toBe(`/api/sessions/${S}/clone`)
    expect(bodyOf(r.requests[0]!)).toEqual({ effort: 'high', prompt: 'try another way' })
    expect(r.json).toMatchObject({ ok: true, forkedFrom: S })
  })

  it('respawn posts to /respawn', async () => {
    routes = { [`POST /api/sessions/${S}/respawn`]: [200, SESSION] }
    const r = await cli(['session', 'respawn', S, '--headless'])
    expect(r.requests[0]!.url).toBe(`/api/sessions/${S}/respawn`)
    expect(bodyOf(r.requests[0]!)).toEqual({ useTmux: false })
  })

  it('archive and its mark-success alias hit the same endpoint', async () => {
    routes = { [`POST /api/sessions/${S}/archive`]: [200, { ...SESSION, status: 'succeeded' }] }
    const a = await cli(['session', 'archive', S])
    const b = await cli(['session', 'mark-success', S])
    expect(a.requests[0]!.url).toBe(`/api/sessions/${S}/archive`)
    expect(b.requests[0]!.url).toBe(`/api/sessions/${S}/archive`)
    expect(a.json).toMatchObject({ ok: true, status: 'succeeded' })
  })

  it('interrupt posts to /interrupt', async () => {
    routes = { [`POST /api/sessions/${S}/interrupt`]: [200, SESSION] }
    const r = await cli(['session', 'interrupt', S])
    expect(r.requests[0]!.method).toBe('POST')
    expect(r.requests[0]!.url).toBe(`/api/sessions/${S}/interrupt`)
  })

  it('metadata PATCHes only the named fields', async () => {
    routes = { [`PATCH /api/sessions/${S}`]: [200, SESSION] }
    const r = await cli(['session', 'metadata', S, '--model', 'claude-haiku-4-5', '--use-tmux', 'false'])
    expect(r.requests[0]!.method).toBe('PATCH')
    expect(bodyOf(r.requests[0]!)).toEqual({ model: 'claude-haiku-4-5', useTmux: false })
    expect(r.json).toMatchObject({ ok: true, changed: ['model', 'useTmux'] })
  })

  it('metadata refuses a no-op edit before sending anything', async () => {
    routes = {}
    const r = await cli(['session', 'metadata', S])
    expect(r.code).not.toBe(0)
    expect(r.requests).toHaveLength(0)
    expect(String(r.json['error'])).toMatch(/nothing to change/)
  })

  it('send posts the prompt to /input', async () => {
    routes = { [`POST /api/sessions/${S}/input`]: [200, SESSION] }
    const r = await cli(['session', 'send', S, '--prompt', 'next turn please'])
    expect(bodyOf(r.requests[0]!)).toEqual({ prompt: 'next turn please' })
    expect(r.json).toMatchObject({ ok: true, promptChars: 16 })
  })

  it('send reads the prompt from stdin', async () => {
    routes = { [`POST /api/sessions/${S}/input`]: [200, SESSION] }
    const r = await cli(['session', 'send', S], { input: 'piped body\n' })
    expect(bodyOf(r.requests[0]!)).toEqual({ prompt: 'piped body' })
  })

  it('kill DELETEs the session', async () => {
    routes = { [`DELETE /api/sessions/${S}`]: [200, { ...SESSION, status: 'killed' }] }
    const r = await cli(['session', 'kill', S])
    expect(r.requests[0]!.method).toBe('DELETE')
    expect(r.json).toMatchObject({ ok: true, status: 'killed' })
  })

  it('rm DELETEs the record, not the session', async () => {
    routes = { [`DELETE /api/sessions/${S}/record`]: [200, { deleted: true }] }
    const r = await cli(['session', 'rm', S])
    expect(r.requests[0]!.url).toBe(`/api/sessions/${S}/record`)
  })
})

describe('session answer picks the mechanism off the record', () => {
  it('a tmux selector is answered by index', async () => {
    routes = {
      [`GET /api/sessions/${S}`]: [
        200,
        { ...SESSION, status: 'needs_input', pendingPrompt: { kind: 'permission', title: 'Bash', options: ['Yes', 'Yes, and don\'t ask again', 'No'], capturedAt: '2026-09-11T00:00:00.000Z' } },
      ],
      [`POST /api/sessions/${S}/answer-prompt`]: [200, SESSION],
    }
    const r = await cli(['session', 'answer', S, '--choice', 'No'])
    expect(r.code).toBe(0)
    expect(r.requests.map((q) => `${q.method} ${q.url}`)).toEqual([
      `GET /api/sessions/${S}`,
      `POST /api/sessions/${S}/answer-prompt`,
    ])
    expect(bodyOf(r.requests[1]!)).toEqual({ index: 3 })
    expect(r.json).toMatchObject({ ok: true, answered: 'prompt', index: 3, option: 'No' })
  })

  it('a headless inquiry is answered by a text turn on /input', async () => {
    routes = {
      [`GET /api/sessions/${S}`]: [
        200,
        {
          ...SESSION,
          status: 'needs_input',
          pendingInquiry: {
            message: 'Which environment and which ref?',
            fields: [
              { name: 'env', label: 'Environment', type: 'choice', options: ['staging', 'production'] },
              { name: 'ref', label: 'Git ref', type: 'text', options: null },
            ],
          },
        },
      ],
      [`POST /api/sessions/${S}/input`]: [200, SESSION],
    }
    const r = await cli(['session', 'answer', S, '--field', 'env=production', '--field', 'ref=main'])
    expect(r.code).toBe(0)
    expect(r.requests[1]!.url).toBe(`/api/sessions/${S}/input`)
    expect(bodyOf(r.requests[1]!)).toEqual({ prompt: 'Environment: production\nGit ref: main' })
    expect(r.json).toMatchObject({ ok: true, answered: 'inquiry' })
  })

  it('an ambiguous --choice sends no answer at all', async () => {
    routes = {
      [`GET /api/sessions/${S}`]: [
        200,
        { ...SESSION, pendingPrompt: { kind: 'permission', title: 'x', options: ['Yes, once', 'Yes, always'], capturedAt: 'now' } },
      ],
    }
    const r = await cli(['session', 'answer', S, '--choice', 'Yes'])
    expect(r.code).not.toBe(0)
    // The GET happened; the answer did not.
    expect(r.requests).toHaveLength(1)
    expect(String(r.json['error'])).toMatch(/ambiguous/)
  })
})

describe('adopt / import / export', () => {
  const HARNESS = '44444444-4444-4444-8444-444444444444'

  it('adopt posts the harness uuid and the project', async () => {
    routes = { 'POST /api/sessions/adopt': [201, SESSION] }
    const r = await cli(['session', 'adopt', HARNESS, '--project', SESSION.projectId, '--headless'])
    expect(bodyOf(r.requests[0]!)).toEqual({
      projectId: SESSION.projectId,
      harnessSessionId: HARNESS,
      useTmux: false,
    })
    expect(r.json).toMatchObject({ ok: true, adoptedFrom: HARNESS })
  })

  it('adopt --dry-run uses the validate route and creates nothing', async () => {
    routes = { 'POST /api/sessions/adopt/validate': [200, { valid: true }] }
    const r = await cli(['session', 'adopt', HARNESS, '--project', SESSION.projectId, '--dry-run'])
    expect(r.requests[0]!.url).toBe('/api/sessions/adopt/validate')
    expect(r.json).toMatchObject({ ok: true, dryRun: true, valid: true })
  })

  it('import uploads the bundle as multipart with projectId alongside', async () => {
    routes = { 'POST /api/sessions/import': [201, { ...SESSION, uuidRegenerated: true }] }
    const bundle = path.join(dataDir, 'bundle.jsonl')
    fs.writeFileSync(bundle, '{"type":"user"}\n')
    const r = await cli(['session', 'import', bundle, '--project', SESSION.projectId, '--tmux'])
    const req = r.requests[0]!
    expect(req.contentType).toMatch(/multipart\/form-data/)
    expect(req.body).toContain('filename="bundle.jsonl"')
    expect(req.body).toContain(SESSION.projectId)
    expect(req.body).toContain('name="useTmux"')
    expect(r.json).toMatchObject({ ok: true, uuidRegenerated: true, importedFrom: 'bundle.jsonl' })
  })

  it('export streams the bundle to --out and reports what arrived', async () => {
    routes = {
      [`GET /api/sessions/${S}/export`]: [
        200,
        '{"type":"user"}\n{"type":"assistant"}\n',
        { 'content-type': 'application/x-ndjson', 'x-orchestron-source-uuid': SESSION.claudeSessionUuid },
      ],
    }
    const out = path.join(dataDir, 'exported.jsonl')
    const r = await cli(['session', 'export', S, '--out', out])
    expect(r.code).toBe(0)
    expect(fs.readFileSync(out, 'utf8')).toContain('"assistant"')
    expect(r.json).toMatchObject({ ok: true, format: 'jsonl', sourceUuid: SESSION.claudeSessionUuid })
  })

  it('export --format is an assertion, and it fails loudly when it is wrong', async () => {
    // The bundle format follows the session's harness and transcript; there
    // is no request parameter that changes it. Writing a jsonl into a file
    // the caller believes is a tarball is the failure this prevents.
    routes = {
      [`GET /api/sessions/${S}/export`]: [200, '{"type":"user"}\n', { 'content-type': 'application/x-ndjson' }],
    }
    const r = await cli(['session', 'export', S, '--out', path.join(dataDir, 'x.tgz'), '--format', 'tar.gz'])
    expect(r.code).not.toBe(0)
    expect(String(r.json['error'])).toMatch(/server exported jsonl/)
  })
})

describe('schedule CRUD', () => {
  const SCHED = {
    id: 'sched-1',
    cron: '0 9 * * 1',
    projectId: SESSION.projectId,
    enabled: true,
    prompt: 'weekly report',
    model: 'claude-haiku-4-5',
    useTmux: false,
    createdAt: '2026-09-11T00:00:00.000Z',
  }

  it('create posts the cron, the project and the overrides', async () => {
    routes = { 'POST /api/schedules': [201, SCHED] }
    const r = await cli([
      'schedule', 'create',
      '--cron', '0 9 * * 1',
      '--project', SESSION.projectId,
      '--prompt', 'weekly report',
      '--model', 'claude-haiku-4-5',
      '--headless',
    ])
    expect(bodyOf(r.requests[0]!)).toEqual({
      cron: '0 9 * * 1',
      projectId: SESSION.projectId,
      prompt: 'weekly report',
      model: 'claude-haiku-4-5',
      useTmux: false,
    })
    expect(r.json).toMatchObject({ ok: true, id: 'sched-1' })
  })

  it('create --disabled starts it paused', async () => {
    routes = { 'POST /api/schedules': [201, { ...SCHED, enabled: false }] }
    const r = await cli(['schedule', 'create', '--cron', '0 9 * * 1', '--project', SESSION.projectId, '--prompt', 'x', '--disabled'])
    expect(bodyOf(r.requests[0]!)['enabled']).toBe(false)
  })

  it('edit sends the clear spellings so an override can be taken back off', async () => {
    // Omission merges, so without an explicit clear a schedule pinned to an
    // expensive model could never be un-pinned from the CLI.
    routes = { 'PATCH /api/schedules/sched-1': [200, SCHED] }
    const r = await cli(['schedule', 'edit', 'sched-1', '--clear-model', '--follow-project-mode'])
    expect(bodyOf(r.requests[0]!)).toEqual({ model: '', useTmux: null })
  })

  it('edit refuses --model together with --clear-model', async () => {
    routes = {}
    const r = await cli(['schedule', 'edit', 'sched-1', '--model', 'x', '--clear-model'])
    expect(r.code).not.toBe(0)
    expect(r.requests).toHaveLength(0)
  })

  it('pause and resume are the enabled flag under honest names', async () => {
    routes = { 'PATCH /api/schedules/sched-1': [200, { ...SCHED, enabled: false }] }
    const p = await cli(['schedule', 'pause', 'sched-1'])
    expect(bodyOf(p.requests[0]!)).toEqual({ enabled: false })
    routes = { 'PATCH /api/schedules/sched-1': [200, SCHED] }
    const q = await cli(['schedule', 'resume', 'sched-1'])
    expect(bodyOf(q.requests[0]!)).toEqual({ enabled: true })
  })

  it('delete DELETEs and tolerates the 204', async () => {
    routes = { 'DELETE /api/schedules/sched-1': [204, null] }
    const r = await cli(['schedule', 'delete', 'sched-1'])
    expect(r.code).toBe(0)
    expect(r.json).toMatchObject({ ok: true, deleted: true })
  })

  it('run reports the session the fire produced', async () => {
    routes = { 'POST /api/schedules/sched-1/run': [200, { ok: true, sessionUuid: S }] }
    const r = await cli(['schedule', 'run', 'sched-1'])
    expect(r.json).toMatchObject({ ok: true, sessionUuid: S })
  })

  it('export writes the YAML to --out', async () => {
    routes = {
      'GET /api/schedules/export': [200, 'schedules:\n  - id: sched-1\n    cron: 0 9 * * 1\n', { 'content-type': 'application/x-yaml' }],
    }
    const out = path.join(dataDir, 'scheds.yml')
    const r = await cli(['schedule', 'export', '--out', out])
    expect(fs.readFileSync(out, 'utf8')).toContain('sched-1')
    expect(r.json).toMatchObject({ ok: true, count: 1 })
  })

  it('import posts the document as YAML with the mode in the query', async () => {
    routes = {
      'POST /api/schedules/import': [200, { mode: 'replace', total: 1, created: 1, updated: 0, skipped: 0, coerced: 0, errors: [] }],
    }
    const file = path.join(dataDir, 'in.yml')
    fs.writeFileSync(file, 'schedules:\n  - id: s1\n    cron: 0 9 * * 1\n    projectId: p\n    prompt: x\n')
    const r = await cli(['schedule', 'import', file, '--mode', 'replace'])
    const req = r.requests[0]!
    expect(req.url).toBe('/api/schedules/import?mode=replace')
    expect(req.contentType).toMatch(/yaml/)
    expect(req.body).toContain('cron: 0 9 * * 1')
    expect(r.json).toMatchObject({ ok: true, created: 1 })
  })

  it('import rejects a mode the API would 400 on, without sending the file', async () => {
    routes = {}
    const file = path.join(dataDir, 'in.yml')
    const r = await cli(['schedule', 'import', file, '--mode', 'clobber'])
    expect(r.code).not.toBe(0)
    expect(r.requests).toHaveLength(0)
  })
})

describe('metrics', () => {
  it('builds the query string and totals the buckets', async () => {
    routes = {
      'GET /api/metrics': [
        200,
        {
          buckets: [{ key: 'claude-opus-5', sessions: 2, tokens: 1000, cost_usd: 0.5, avg_duration_ms: 4200 }],
          total: { sessions: 2, tokens: 1000, cost_usd: 0.5 },
        },
      ],
    }
    const r = await cli(['metrics', '--group-by', 'model', '--from', '2026-09-01T00:00:00.000Z', '--to', '2026-09-11', '--adapter', 'claude'])
    expect(r.code).toBe(0)
    const q = new URLSearchParams(r.requests[0]!.url.split('?')[1])
    expect(q.get('groupBy')).toBe('model')
    // A full ISO timestamp is truncated to the date the endpoint accepts
    // rather than 400ing.
    expect(q.get('from')).toBe('2026-09-01')
    expect(q.get('to')).toBe('2026-09-11')
    expect(q.get('adapter')).toBe('claude')
    expect(r.json).toMatchObject({ ok: true, groupBy: 'model' })
  })

  it('rejects an unknown --group-by before sending', async () => {
    routes = {}
    const r = await cli(['metrics', '--group-by', 'wizard'])
    expect(r.code).not.toBe(0)
    expect(r.requests).toHaveLength(0)
  })
})

describe('failure envelope', () => {
  it('an API error becomes ok:false with the status and the server message', async () => {
    routes = { [`POST /api/sessions/${S}/reopen`]: [409, { error: 'Cannot reopen from status running' }] }
    const r = await cli(['session', 'reopen', S])
    expect(r.code).toBe(1)
    expect(r.json).toEqual({ ok: false, error: expect.stringContaining('Cannot reopen from status running'), status: 409 })
  })

  it('a zod rejection is rendered on one line, not dumped raw', async () => {
    routes = { 'POST /api/schedules': [400, { error: { formErrors: [], fieldErrors: { cron: ['invalid cron expression'] } } }] }
    const r = await cli(['schedule', 'create', '--cron', 'nope', '--project', 'p', '--prompt', 'x'])
    expect(r.code).toBe(1)
    expect(String(r.json['error'])).toContain('invalid cron expression')
    expect(String(r.json['error']).split('\n')).toHaveLength(1)
  })
})
