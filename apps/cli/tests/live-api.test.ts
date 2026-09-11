import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AddressInfo } from 'node:net'
import { SessionManager } from '../../api/src/domain/session-manager.js'
import { AdapterRegistry } from '../../api/src/adapters/registry.js'
import { ProjectRegistry } from '../../api/src/domain/project-registry.js'
import { DelegationTracker } from '../../api/src/domain/delegation-tracker.js'
import { HookRunner } from '../../api/src/domain/hook-runner.js'
import { TemplateResolver } from '../../api/src/domain/template-resolver.js'
import { Scheduler } from '../../api/src/domain/scheduler.js'
import { MetricsCollector } from '../../api/src/domain/metrics-collector.js'
import { sessionsPlugin } from '../../api/src/routes/sessions.js'
import { projectsPlugin } from '../../api/src/routes/projects.js'
import { schedulesPlugin } from '../../api/src/routes/schedules.js'
import { metricsPlugin } from '../../api/src/routes/metrics.js'
import type { AgentAdapter, TmuxHandle } from '@agent-hq-orchestron/shared'
import { EFFORT_BY_ENDPOINT } from '../src/helpers/effort.js'

/**
 * The CLI against the API's own route handlers, over a real socket.
 *
 * `wire.test.ts` runs the binary against a stub whose response bodies were
 * written by the same person who wrote the assertions, and that is exactly how
 * `session list` and `project list` shipped broken: both routes answer
 * `{ sessions: [...] }` / `{ projects: [...] }`, the CLI destructured the
 * reply as a bare array, and **every** invocation against the real server died
 * on "sessions is not iterable" while 42 wire tests stayed green.
 *
 * So this file imports the real plugins, `listen()`s them on a real port and
 * spawns the real binary at them. No response body is authored here: every
 * shape the CLI parses comes out of the handler that serves it in production,
 * which means a route that renames a field or re-wraps a list fails here
 * instead of at the operator's shell.
 *
 * Only the *adapter* is a mock — spawning tmux and a live harness is the one
 * thing a unit suite cannot do. Everything between the socket and the adapter
 * (routing, zod, the managers, serialisation) is the shipped code. The
 * complement to this file is the post-deploy sweep against the running
 * instance; see `docs/e2e-tests/cli.md`.
 */

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY = path.join(__dirname, '../src/index.ts')
const TSX = path.join(__dirname, '../../../node_modules/.bin/tsx')

/** Enough sessions that `session list --json` clears the 64 KiB pipe buffer.
 *  Below that a truncated stdout can still look complete. */
const BULK_SESSIONS = 160

let app: FastifyInstance
let base: string
let dataDir: string
let cliDataDir: string
let projectId: string
let projectPath: string
let firstSessionId: string

function makeMockAdapter(): AgentAdapter {
  const handle: TmuxHandle = {
    tmuxName: 'mock-tmux-session',
    claudeUuid: '00000000-0000-0000-0000-000000000099',
    jsonlPath: path.join(os.tmpdir(), 'orchestron-live-api-mock.jsonl'),
  }
  return {
    name: 'mock',
    spawn: vi.fn().mockResolvedValue(handle),
    resume: vi.fn().mockResolvedValue(handle),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitTuiReady: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
  }
}

interface Run {
  stdout: string
  stderr: string
  code: number
  json: Record<string, unknown>
}

/** Run the binary against the live server. `--json` is opt-out so the human
 *  table renderers get exercised too — a table column reading a field the API
 *  does not send throws, and that is a failure mode `--json` never sees. */
async function cli(
  args: string[],
  opts: { json?: boolean; shell?: boolean; pipeTo?: string } = {},
): Promise<Run> {
  const withFlags = [...args, '--url', base, '--token', 'live-test-token']
  if (opts.json !== false) withFlags.push('--json')
  let stdout = ''
  let stderr = ''
  let code = 0
  const env = { ...process.env, ORCHESTRON_DATA_DIR: cliDataDir, NO_COLOR: '1' }
  try {
    const r = opts.shell
      // A genuine shell pipe, which is what `| jq` is. execFile already gives
      // the child a pipe for stdout, but routing through `cat` also proves the
      // downstream reader sees the whole document.
      // `pipefail` so the pipeline reports the CLI's status, not `cat`'s —
      // without it a command that exits 1 reads as a success here.
      ? await execFileAsync('bash', ['-c', `set -o pipefail; ${TSX} ${CLI_ENTRY} ${withFlags.map(a => JSON.stringify(a)).join(' ')} | ${opts.pipeTo ?? 'cat'}`], { env, maxBuffer: 64 * 1024 * 1024 })
      : await execFileAsync(TSX, [CLI_ENTRY, ...withFlags], { env, maxBuffer: 64 * 1024 * 1024 })
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
  return { stdout, stderr, code, json }
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-live-api-'))
  cliDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-live-cli-'))
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-live-proj-'))
  fs.writeFileSync(path.join(os.tmpdir(), 'orchestron-live-api-mock.jsonl'), '')

  const adapterRegistry = new AdapterRegistry()
  adapterRegistry.register('claude', makeMockAdapter())
  // The pool cap has to clear BULK_SESSIONS: the route 429s once it is full,
  // and this file is not testing the cap.
  const manager = new SessionManager({ dataDir, maxConcurrent: BULK_SESSIONS + 64 }, adapterRegistry)
  const registry = new ProjectRegistry(dataDir)
  const tracker = new DelegationTracker(dataDir)
  const hookRunner = new HookRunner({ dataDir })
  const templateResolver = new TemplateResolver(dataDir)
  const scheduler = new Scheduler(dataDir, 'http://127.0.0.1:1', null)
  const collector = new MetricsCollector(dataDir, manager)

  app = Fastify({ logger: false })
  await app.register(projectsPlugin(registry))
  await app.register(sessionsPlugin(manager, hookRunner, templateResolver, tracker, registry))
  await app.register(schedulesPlugin(scheduler))
  await app.register(metricsPlugin(collector))
  await app.listen({ port: 0, host: '127.0.0.1' })
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`

  // Seed through the same routes the CLI talks to — `inject` rather than the
  // binary so the bulk is cheap, but still the real handler and the real zod.
  const proj = await app.inject({
    method: 'POST',
    url: '/api/projects',
    payload: { name: 'live-api', path: projectPath, agentType: 'claude' },
  })
  if (proj.statusCode !== 201) throw new Error(`seed project failed ${proj.statusCode}: ${proj.body}`)
  projectId = (proj.json() as { id: string }).id

  for (let i = 0; i < BULK_SESSIONS; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { projectId, prompt: `seed ${i}`, useTmux: false },
    })
    if (res.statusCode !== 201) throw new Error(`seed session ${i} failed ${res.statusCode}: ${res.body}`)
    if (i === 0) firstSessionId = (res.json() as { id: string }).id
  }
}, 120_000)

afterAll(async () => {
  await app.close()
  for (const d of [dataDir, cliDataDir, projectPath]) fs.rmSync(d, { recursive: true, force: true })
})

describe('CLI against the real route handlers', () => {
  it('parses the list envelope `GET /api/sessions` actually sends', async () => {
    const r = await cli(['session', 'list'])
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(r.json['ok']).toBe(true)
    expect(r.json['count']).toBe(BULK_SESSIONS)
    expect((r.json['sessions'] as unknown[]).length).toBe(BULK_SESSIONS)
  })

  it('parses the list envelope `GET /api/projects` actually sends', async () => {
    const r = await cli(['project', 'list'])
    expect(r.code).toBe(0)
    expect(r.json['ok']).toBe(true)
    expect((r.json['projects'] as Array<{ id: string }>).map(p => p.id)).toContain(projectId)
  })

  it('parses the list envelope `GET /api/schedules` actually sends', async () => {
    const r = await cli(['schedule', 'list'])
    expect(r.code).toBe(0)
    expect(r.json['ok']).toBe(true)
    expect(Array.isArray(r.json['schedules'])).toBe(true)
  })

  it('renders the human session table from real records', async () => {
    // The table reads startedAt, tmuxName, status, useTmux and costUsd off
    // each record. A field the API stopped sending throws here; `--json`
    // would have echoed the gap silently.
    const r = await cli(['session', 'list'], { json: false })
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(r.stdout).toContain(firstSessionId.slice(0, 8))
  })

  it('reads one session record back', async () => {
    const r = await cli(['session', 'get', firstSessionId])
    expect(r.code).toBe(0)
    expect(r.json['ok']).toBe(true)
    const rec = r.json['session'] as { id: string; projectId: string }
    expect(rec.id).toBe(firstSessionId)
    expect(rec.projectId).toBe(projectId)
  })

  it('parses the metrics document `GET /api/metrics` actually sends', async () => {
    const r = await cli(['metrics', '--group-by', 'day'])
    expect(r.code).toBe(0)
    expect(r.json['ok']).toBe(true)
    expect(Array.isArray(r.json['buckets'])).toBe(true)
    expect(r.json['total']).toMatchObject({ sessions: expect.any(Number), cost_usd: expect.any(Number) })
  })

  it('delivers the whole document through a shell pipe', async () => {
    // The regression: stdout to a PIPE is asynchronous and `process.exit`
    // does not wait for it, so `session list --json | jq` read a truncated
    // document. BULK_SESSIONS puts this payload well past the 64 KiB pipe
    // buffer, which is where a lost flush stops being invisible.
    const r = await cli(['session', 'list'], { shell: true })
    expect(r.stdout.length).toBeGreaterThan(64 * 1024)
    expect(r.json['ok']).toBe(true)
    expect((r.json['sessions'] as unknown[]).length).toBe(BULK_SESSIONS)
  })

  it('survives a reader that closes the pipe early (NEW-1)', async () => {
    // `| head` is the other half of piping, and it was unhandled. A reader
    // that takes what it wants and closes leaves the CLI writing into a dead
    // pipe; with no `error` listener on stdout, node turns that EPIPE into an
    // unhandled `error` event and the process dies with a stack trace and a
    // non-zero status. Nothing in `apps/cli` handled it — pre-existing, and
    // invisible until `session list` grew past the 64 KiB the pipe buffers
    // for free.
    //
    // `head -c 1000` rather than `head -n`: a byte count guarantees the
    // reader closes mid-document instead of after a line boundary that a
    // small payload might never cross.
    const r = await cli(['session', 'list'], { shell: true, pipeTo: 'head -c 1000' })
    expect(r.code).toBe(0)
    expect(r.stderr).toBe('')
    expect(r.stdout).not.toContain('EPIPE')
    // The reader did get its bytes — this is a truncated read, not an empty
    // one, so the test cannot pass by the command failing to produce output.
    expect(r.stdout.length).toBe(1000)
  })

  it('delivers a failure envelope through a shell pipe, with exit 1', async () => {
    // Two regressions in one assertion. Commander calls a handler with
    // `(...positionals, options, command)` — the LAST argument is the Command,
    // not the options — so a wrapper reading `args[args.length - 1]` saw
    // `json: undefined` and printed a human line to stderr with an EMPTY
    // stdout. And `process.exit(1)` then cut the write to the pipe. A failing
    // command with a positional exercises both.
    const r = await cli(['session', 'get', '00000000-0000-4000-8000-000000000000'], { shell: true })
    expect(r.code).toBe(1)
    expect(r.json).toMatchObject({ ok: false, status: 404 })
    expect(r.stderr).toBe('')
  })

  it('delivers a failure envelope from a command with no positional', async () => {
    // Same wrapper, zero positionals: `(options, command)`. Worth its own
    // case — an `optionsOf` that indexed from the front would pass the test
    // above and fail this one.
    const ok = await cli(['session', 'list', '--status', 'not-a-status'], { shell: true })
    expect(ok.json['ok']).toBe(true)
    expect(ok.json['count']).toBe(0)

    const bad = await cli(['metrics', '--group-by', 'not-an-axis'], { shell: true })
    expect(bad.code).toBe(1)
    expect(bad.json['ok']).toBe(false)
    expect(String(bad.json['error'])).toContain('--group-by')
    expect(bad.stderr).toBe('')
  })
})

describe('effort enums, endpoint by endpoint', () => {
  // The CLI's per-endpoint whitelists are transcriptions of zod enums in the
  // API. This asserts the transcription: every level the CLI advertises is
  // taken by the route it is filed under, and a level the route rejects is
  // refused locally before any request goes out.
  it('accepts every level `session spawn` advertises', async () => {
    for (const level of EFFORT_BY_ENDPOINT.spawn) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: { projectId, prompt: 'effort probe', effort: level, useTmux: false },
      })
      expect(`${level}:${res.statusCode}`).toBe(`${level}:201`)
    }
  })

  it('accepts every level the revival routes advertise', async () => {
    for (const level of EFFORT_BY_ENDPOINT.revival) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/sessions/${firstSessionId}/reopen`,
        payload: { effort: level },
      })
      // 201 or a lifecycle refusal — anything but 400, which is what an
      // effort the route does not know produces.
      expect(`${level}:${res.statusCode}`).not.toBe(`${level}:400`)
    }
  })

  it('400s on the level the revival routes do not take, proving the whitelist is not paranoia', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/sessions/${firstSessionId}/reopen`,
      payload: { effort: 'ultra' },
    })
    expect(res.statusCode).toBe(400)
    expect(EFFORT_BY_ENDPOINT.revival).not.toContain('ultra')
  })

  it('refuses `--effort ultra` on reopen locally, sending nothing', async () => {
    const r = await cli(['session', 'reopen', firstSessionId, '--effort', 'ultra'])
    expect(r.code).toBe(1)
    expect(r.json['ok']).toBe(false)
    expect(String(r.json['error'])).toContain('not accepted by reopen / respawn / fork')
    // Local refusal: no HTTP status, because no request was made.
    expect(r.json['status']).toBeUndefined()
  })

  it('refuses `--effort xhigh` on adopt locally', async () => {
    const r = await cli(['session', 'adopt', '00000000-0000-4000-8000-0000000000aa', '--project', projectId, '--effort', 'xhigh'])
    expect(r.code).toBe(1)
    expect(String(r.json['error'])).toContain('not accepted by session adopt')
    expect(r.json['status']).toBeUndefined()
  })

  it('still takes `--effort ultra` on spawn, where the route does', async () => {
    const r = await cli(['session', 'spawn', '--project', projectId, '--prompt', 'ultra ok', '--effort', 'ultra', '--headless'])
    expect(r.code).toBe(0)
    expect(r.json['ok']).toBe(true)
    expect(r.json['effort']).toBe('ultra')
  })
})

describe('surface the API does not have', () => {
  it('has no --group on session spawn', async () => {
    // `group` lives on ProjectMetadata; `SpawnSessionBodySchema` has no such
    // field, and zod strips unknown keys — a `--group` here would have been
    // accepted by the CLI, dropped on the wire and silently done nothing.
    const r = await cli(['session', 'spawn', '--project', projectId, '--prompt', 'x', '--group', 'infra'])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("unknown option '--group'")
  })

  it('spawns without --group', async () => {
    const r = await cli(['session', 'spawn', '--project', projectId, '--prompt', 'no group', '--headless'])
    expect(r.code).toBe(0)
    expect(r.json['ok']).toBe(true)
  })

  it('groups at the project level, which is where the field is', async () => {
    const r = await cli(['project', 'edit', projectId, '--group', 'infra'])
    expect(r.code).toBe(0)
    const listed = await cli(['project', 'list', '--group', 'infra'])
    expect((listed.json['projects'] as Array<{ id: string }>).map(p => p.id)).toContain(projectId)
  })

  it('has no session mark-success verb', async () => {
    // `POST /api/sessions/:uuid/archive` takes no body: there is no success
    // flag and no second endpoint, so the CLI does not offer a second name.
    const r = await cli(['session', 'mark-success', firstSessionId])
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/unknown command/i)
  })

  it('archives through the endpoint that exists', async () => {
    const spawned = await cli(['session', 'spawn', '--project', projectId, '--prompt', 'to archive', '--headless'])
    const id = String(spawned.json['id'])
    const r = await cli(['session', 'archive', id])
    expect(r.code).toBe(0)
    expect(r.json['status']).toBe('succeeded')
  })
})
