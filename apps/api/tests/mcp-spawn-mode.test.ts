import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * `useTmux` on the MCP `spawn_session` tool.
 *
 * Driven as a real stdio subprocess against a stub API rather than by
 * importing the module: `mcp-server.ts` reads its env into module-level
 * consts and opens a readline loop on import, so ORCHESTRON_SESSION_ID —
 * the whole subject of the inheritance rule — cannot be varied any other
 * way. What the tests assert is the BODY the server sends to /api/sessions,
 * because that is the only place the resolution is observable.
 */

const MCP_ENTRY = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp-server.ts',
)

const PARENT_ID = 'parent-session-uuid'
const PARENT_PROJECT = 'project-a'
const OTHER_PROJECT = 'project-b'

interface Stub {
  url: string
  /** Bodies POSTed to /api/sessions, in order. */
  spawns: Record<string, unknown>[]
  close(): Promise<void>
}

/** Stub API. `parent` is what GET /api/sessions/<id> returns; null 404s. */
async function startStub(opts: {
  parent?: { projectId: string; useTmux?: boolean } | null
  spawnResponse?: (body: Record<string, unknown>) => Record<string, unknown>
} = {}): Promise<Stub> {
  const spawns: Record<string, unknown>[] = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.method === 'GET' && req.url?.startsWith('/api/sessions/')) {
        if (opts.parent === null || opts.parent === undefined) return send(404, { error: 'not found' })
        return send(200, { id: PARENT_ID, ...opts.parent })
      }
      if (req.method === 'POST' && req.url === '/api/sessions') {
        const body = JSON.parse(raw || '{}') as Record<string, unknown>
        spawns.push(body)
        const custom = opts.spawnResponse?.(body)
        return send(201, custom ?? {
          id: 'child-uuid', status: 'spawning', useTmux: body['useTmux'] ?? true,
        })
      }
      send(404, { error: 'unexpected' })
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    spawns,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

let child: ChildProcessWithoutNullStreams | null = null
let stub: Stub | null = null

/** One `tools/call` round-trip, returning the parsed tool result. */
async function callSpawn(
  args: Record<string, unknown>,
  env: Record<string, string>,
): Promise<Record<string, unknown>> {
  child = spawn(process.execPath, [MCP_ENTRY], {
    env: { ...process.env, ORCHESTRON_API_URL: stub!.url, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const proc = child
  const done = new Promise<Record<string, unknown>>((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error(`mcp timed out; stdout=${buf}`)), 15_000)
    proc.stdout.on('data', (c: Buffer) => {
      buf += c.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        clearTimeout(timer)
        const msg = JSON.parse(line) as { result?: { content?: { text: string }[] } }
        const text = msg.result?.content?.[0]?.text ?? '{}'
        resolve(JSON.parse(text) as Record<string, unknown>)
        return
      }
    })
    proc.on('error', reject)
  })
  proc.stdin.write(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'spawn_session', arguments: args },
  }) + '\n')
  return done
}

/** The tool's advertised schema, straight off `tools/list`. */
async function toolSchema(): Promise<Record<string, unknown>> {
  child = spawn(process.execPath, [MCP_ENTRY], {
    env: { ...process.env, ORCHESTRON_API_URL: stub!.url },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const proc = child
  const done = new Promise<Record<string, unknown>>((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('tools/list timed out')), 15_000)
    proc.stdout.on('data', (c: Buffer) => {
      buf += c.toString()
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      clearTimeout(timer)
      const msg = JSON.parse(buf.slice(0, nl)) as {
        result: { tools: { name: string; inputSchema: Record<string, unknown> }[] }
      }
      resolve(msg.result.tools.find((t) => t.name === 'spawn_session')!)
    })
    proc.on('error', reject)
  })
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n')
  return done
}

beforeEach(() => { child = null; stub = null })

afterEach(async () => {
  child?.kill('SIGKILL')
  child = null
  await stub?.close()
  stub = null
})

describe('spawn_session — the schema', () => {
  it('advertises useTmux as an optional boolean', async () => {
    stub = await startStub()
    const tool = await toolSchema()
    const props = (tool.inputSchema as { properties: Record<string, { type: string }> }).properties
    expect(props['useTmux']?.type).toBe('boolean')
    // Optional: a parent that never thinks about run mode must still be
    // able to spawn, which was the pre-fix behaviour.
    expect((tool.inputSchema as { required: string[] }).required).not.toContain('useTmux')
  })
})

describe('spawn_session — an explicit mode', () => {
  it('sends headless through untouched', async () => {
    stub = await startStub({ parent: { projectId: PARENT_PROJECT, useTmux: true } })
    await callSpawn(
      { projectId: PARENT_PROJECT, initialPrompt: 'go', useTmux: false },
      { ORCHESTRON_SESSION_ID: PARENT_ID },
    )
    // `false` must survive: a truthiness check here would silently promote
    // every headless child back to tmux.
    expect(stub.spawns[0]!['useTmux']).toBe(false)
  })

  it('overrides an inherited mode in the other direction too', async () => {
    stub = await startStub({ parent: { projectId: PARENT_PROJECT, useTmux: false } })
    await callSpawn(
      { projectId: PARENT_PROJECT, initialPrompt: 'go', useTmux: true },
      { ORCHESTRON_SESSION_ID: PARENT_ID },
    )
    expect(stub.spawns[0]!['useTmux']).toBe(true)
  })
})

describe('spawn_session — an omitted mode', () => {
  it('inherits a headless parent within the parent project', async () => {
    stub = await startStub({ parent: { projectId: PARENT_PROJECT, useTmux: false } })
    await callSpawn(
      { projectId: PARENT_PROJECT, initialPrompt: 'go' },
      { ORCHESTRON_SESSION_ID: PARENT_ID },
    )
    expect(stub.spawns[0]!['useTmux']).toBe(false)
  })

  it('inherits a tmux parent within the parent project', async () => {
    stub = await startStub({ parent: { projectId: PARENT_PROJECT, useTmux: true } })
    await callSpawn(
      { projectId: PARENT_PROJECT, initialPrompt: 'go' },
      { ORCHESTRON_SESSION_ID: PARENT_ID },
    )
    expect(stub.spawns[0]!['useTmux']).toBe(true)
  })

  it('reads a parent with no useTmux field as tmux', async () => {
    stub = await startStub({ parent: { projectId: PARENT_PROJECT } })
    await callSpawn(
      { projectId: PARENT_PROJECT, initialPrompt: 'go' },
      { ORCHESTRON_SESSION_ID: PARENT_ID },
    )
    expect(stub.spawns[0]!['useTmux']).toBe(true)
  })

  it('defers to the target project when the child goes elsewhere', async () => {
    stub = await startStub({ parent: { projectId: PARENT_PROJECT, useTmux: false } })
    await callSpawn(
      { projectId: OTHER_PROJECT, initialPrompt: 'go' },
      { ORCHESTRON_SESSION_ID: PARENT_ID },
    )
    // Omitting the field is how the API is told to apply project policy.
    // Carrying the parent's mode across would let a tool call that never
    // mentioned mode override that project's configured default.
    expect(stub.spawns[0]!).not.toHaveProperty('useTmux')
  })

  it('omits the field entirely when there is no parent session', async () => {
    stub = await startStub({ parent: { projectId: PARENT_PROJECT, useTmux: false } })
    await callSpawn({ projectId: PARENT_PROJECT, initialPrompt: 'go' }, {})
    expect(stub.spawns[0]!).not.toHaveProperty('useTmux')
    expect(stub.spawns[0]!).not.toHaveProperty('parentSessionId')
  })

  it('falls back to the project default when the parent cannot be read', async () => {
    stub = await startStub({ parent: null })
    const out = await callSpawn(
      { projectId: PARENT_PROJECT, initialPrompt: 'go' },
      { ORCHESTRON_SESSION_ID: PARENT_ID },
    )
    // An unreadable parent must not fail the spawn — the caller asked for a
    // child, not for a mode.
    expect(stub.spawns[0]!).not.toHaveProperty('useTmux')
    expect(out['sessionId']).toBe('child-uuid')
  })
})

describe('spawn_session — the result', () => {
  it('reports the mode the child actually runs in', async () => {
    stub = await startStub({ parent: { projectId: PARENT_PROJECT, useTmux: true } })
    const out = await callSpawn(
      { projectId: PARENT_PROJECT, initialPrompt: 'go', useTmux: false },
      { ORCHESTRON_SESSION_ID: PARENT_ID },
    )
    expect(out['useTmux']).toBe(false)
  })

  it('passes a coercion on rather than letting the parent infer it', async () => {
    stub = await startStub({
      parent: { projectId: PARENT_PROJECT, useTmux: true },
      spawnResponse: () => ({
        id: 'child-uuid', status: 'spawning', useTmux: true,
        coerced: { useTmux: true, reason: 'headless disabled globally' },
      }),
    })
    const out = await callSpawn(
      { projectId: PARENT_PROJECT, initialPrompt: 'go', useTmux: false },
      { ORCHESTRON_SESSION_ID: PARENT_ID },
    )
    expect(out['useTmux']).toBe(true)
    expect(out['coerced']).toEqual({ useTmux: true, reason: 'headless disabled globally' })
  })

  it('says nothing about coercion when nothing was coerced', async () => {
    stub = await startStub({ parent: { projectId: PARENT_PROJECT, useTmux: true } })
    const out = await callSpawn(
      { projectId: PARENT_PROJECT, initialPrompt: 'go', useTmux: true },
      { ORCHESTRON_SESSION_ID: PARENT_ID },
    )
    expect(out).not.toHaveProperty('coerced')
  })
})
