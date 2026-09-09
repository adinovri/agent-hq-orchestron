#!/usr/bin/env node
/**
 * Orchestron MCP stdio server — exposes agent-to-agent tools to Claude Code
 * sessions. Wraps our own REST API; guardrails (depth, rate, per-parent
 * children cap) are enforced server-side in SessionManager.spawn().
 *
 * Env:
 *   ORCHESTRON_API_URL   default http://127.0.0.1:8412
 *   ORCHESTRON_TOKEN     bearer token (required if API auth enabled)
 *   ORCHESTRON_SESSION_ID  optional; when set, spawn_session sets parentSessionId
 *
 * Connect from Claude Code by adding to your .mcp.json:
 *   {
 *     "mcpServers": {
 *       "orchestron": {
 *         "command": "node",
 *         "args": ["/path/to/apps/api/dist/mcp-server.js"],
 *         "env": {
 *           "ORCHESTRON_API_URL": "http://127.0.0.1:8412",
 *           "ORCHESTRON_TOKEN": "…"
 *         }
 *       }
 *     }
 *   }
 */

import readline from 'node:readline'

const API_URL = process.env['ORCHESTRON_API_URL'] || 'http://127.0.0.1:8412'
const TOKEN = process.env['ORCHESTRON_TOKEN'] || ''
const PARENT_SESSION_ID = process.env['ORCHESTRON_SESSION_ID'] || ''

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_NAME = 'orchestron'
const SERVER_VERSION = '0.1.0'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number | string | null
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: number | string | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

function reply(res: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(res) + '\n')
}

function log(...args: unknown[]): void {
  // stdio MCP uses stdout for protocol → logs go to stderr
  console.error('[orchestron-mcp]', ...args)
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (TOKEN) headers['authorization'] = `Bearer ${TOKEN}`
  const resp = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await resp.text()
  if (!resp.ok) {
    throw new Error(`API ${method} ${path} → ${resp.status}: ${text.slice(0, 500)}`)
  }
  try { return JSON.parse(text) as T } catch { return text as unknown as T }
}

/**
 * The parent session's run mode, for a child being spawned into the parent's
 * OWN project — `undefined` for anything else, which leaves the API's normal
 * project-default cascade in charge.
 *
 * Best-effort by design. A parent that cannot be read (deleted record, API
 * blip, a session id from an older orchestron) falls back to the project
 * default rather than failing the spawn: the caller asked for a child, not
 * for a mode, and refusing over an unreadable default would be a worse
 * answer than the configured one.
 */
async function inheritParentMode(childProjectId: string): Promise<boolean | undefined> {
  try {
    const parent = await api<{ projectId?: string; useTmux?: boolean }>(
      'GET', `/api/sessions/${encodeURIComponent(PARENT_SESSION_ID)}`,
    )
    if (!parent.projectId || parent.projectId !== childProjectId) return undefined
    // `?? true` — a parent record predating the toggle is a tmux session.
    return parent.useTmux ?? true
  } catch (err) {
    log(`spawn_session: could not read parent ${PARENT_SESSION_ID} for mode inheritance, using project default:`, (err as Error).message)
    return undefined
  }
}

// ── Tool schemas ─────────────────────────────────────────────────────

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

const TOOLS: ToolDef[] = [
  {
    name: 'list_projects',
    description:
      'List all registered projects. Returns id, name, workspace path, default agent/model/effort. ' +
      'Use this to discover which project to spawn a session under.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => api('GET', '/api/projects'),
  },
  {
    name: 'list_sessions',
    description:
      'List all sessions across every project. Optionally filter by projectId or status. ' +
      'Returns metadata (id, projectId, agentType, model, effort, status, parentSessionId). ' +
      'Use this to discover peer sessions to talk to via send_input.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Filter to one project' },
        status: {
          type: 'string',
          enum: ['spawning', 'waiting', 'running', 'needs_input', 'idle', 'sleeping',
                 'succeeded', 'failed', 'killed'],
        },
      },
    },
    handler: async (args) => {
      const q: string[] = []
      if (args['projectId']) q.push(`projectId=${encodeURIComponent(String(args['projectId']))}`)
      if (args['status']) q.push(`status=${encodeURIComponent(String(args['status']))}`)
      const qs = q.length ? `?${q.join('&')}` : ''
      return api('GET', `/api/sessions${qs}`)
    },
  },
  {
    name: 'spawn_session',
    description:
      'Spawn a new agent session as a child of the current session. Every dimension is ' +
      'independent — project, agent type, model, effort, and run mode can differ from the ' +
      'caller. Guardrails: max depth 5, max 10 children per parent, max 5 spawns/minute. ' +
      'Returns the new session uuid and the mode it actually runs in.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project uuid — use list_projects to discover' },
        initialPrompt: { type: 'string', description: 'Prompt to send after spawn' },
        agentType: {
          type: 'string',
          enum: ['claude', 'codex', 'opencode'],
          default: 'claude',
          description: 'Which agent harness to spawn — can differ from caller',
        },
        model: {
          type: 'string',
          description: 'Model id (e.g. claude-opus-5, claude-sonnet-5, claude-haiku-4-5). ' +
                       'Falls back to project default if omitted.',
        },
        effort: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'xhigh', 'max'],
          description: 'Reasoning effort. Falls back to project default if omitted.',
        },
        useTmux: {
          type: 'boolean',
          description:
            'Run the child in tmux (true — interactive, attachable, sleeps when idle) or ' +
            'headless (false — each turn is its own claude -p / codex exec process, no live ' +
            'TUI, no sleeping, and wait_for_idle still works). Omitted: inherits YOUR mode ' +
            'when the child stays in your own project, otherwise the target project default. ' +
            'A headless request is silently run as tmux when the server has headless disabled; ' +
            'the result says which mode you actually got.',
        },
      },
      required: ['projectId', 'initialPrompt'],
    },
    handler: async (args) => {
      // MCP tool arg names are `initialPrompt` (descriptive for LLM), but
      // the API accepts `prompt` per SpawnSessionBodySchema — map here.
      // The old code sent `initialPrompt` verbatim, which Zod stripped as
      // an unknown key, leaving `prompt` undefined and tripping the
      // "prompt or template required" 422 gate.
      const body: Record<string, unknown> = {
        projectId: args['projectId'],
        prompt: args['initialPrompt'],
        agentType: args['agentType'] ?? 'claude',
      }
      if (args['model']) body['model'] = args['model']
      if (args['effort']) body['effort'] = args['effort']
      if (PARENT_SESSION_ID) body['parentSessionId'] = PARENT_SESSION_ID

      // Run mode. An explicit boolean is the caller's decision and goes
      // straight through — `typeof` rather than truthiness, because `false`
      // is the whole point of the field.
      //
      // Omitted, the caller expressed no preference, and there are two
      // defaults competing to fill it: the parent's own mode and the target
      // project's `defaultUseTmux`. Inheriting wins only within the parent's
      // own project — a child sent somewhere else lands under that project's
      // configured policy, which an LLM tool call that never mentioned mode
      // has no business overriding.
      if (typeof args['useTmux'] === 'boolean') {
        body['useTmux'] = args['useTmux']
      } else if (PARENT_SESSION_ID) {
        const inherited = await inheritParentMode(String(args['projectId'] ?? ''))
        if (inherited !== undefined) body['useTmux'] = inherited
      }

      // The API masks rather than refuses: with headless disabled globally a
      // `useTmux: false` comes back as a tmux session plus a `coerced`
      // payload. Pass that on — a parent that asked for headless and got
      // tmux should be told, not left to infer it from behaviour.
      const session = await api<{
        id: string
        status: string
        useTmux?: boolean
        coerced?: { reason: string }
      }>('POST', '/api/sessions', body)
      if (session.coerced) log(`spawn_session: ${session.coerced.reason}, child ${session.id} runs in tmux`)
      return {
        sessionId: session.id,
        status: session.status,
        // `?? true` — a record with no field is a tmux session.
        useTmux: session.useTmux ?? true,
        ...(session.coerced ? { coerced: session.coerced } : {}),
      }
    },
  },
  {
    name: 'send_input',
    description:
      'Send a new user turn to an existing session. A tmux session accepts it whether it is ' +
      'idle, waiting for input, or actively running (the TUI queues it). A HEADLESS session ' +
      'accepts it only when idle or waiting on an inquiry — it has no input queue, so sending ' +
      'mid-turn fails; wait for the turn to end rather than retrying.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['sessionId', 'text'],
    },
    handler: async (args) => {
      // API /input schema is `{ prompt }`, not `{ text }`. Same field-name
      // mismatch as spawn_session — MCP arg key `text` is nice for the
      // LLM, but map to `prompt` here.
      await api('POST', `/api/sessions/${args['sessionId']}/input`, { prompt: args['text'] })
      return { ok: true }
    },
  },
  {
    name: 'get_status',
    description: 'Get the current metadata of a session (status, model, effort, timestamps).',
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string' } },
      required: ['sessionId'],
    },
    handler: async (args) => api('GET', `/api/sessions/${args['sessionId']}`),
  },
  {
    name: 'read_transcript',
    description:
      'Read the transcript entries for a session. Optionally slice by offset/limit; ' +
      'returns user prompts, assistant messages, tool_use/tool_result entries.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        offset: { type: 'number', description: 'Skip this many entries (default 0)' },
        limit: { type: 'number', description: 'Max entries to return (default 50)' },
      },
      required: ['sessionId'],
    },
    handler: async (args) => {
      const t = await api<{ entries: unknown[] }>('GET', `/api/sessions/${args['sessionId']}/transcript`)
      const offset = Number(args['offset'] ?? 0)
      const limit = Number(args['limit'] ?? 50)
      const slice = (t.entries ?? []).slice(offset, offset + limit)
      return { total: (t.entries ?? []).length, entries: slice }
    },
  },
  {
    name: 'wait_for_idle',
    description:
      'Poll a session until it reaches idle/needs_input/succeeded/failed/killed, or until ' +
      'timeoutSec elapses. Returns final status. Poll interval is 3s.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        timeoutSec: { type: 'number', default: 300, description: 'Max seconds to wait (default 300)' },
      },
      required: ['sessionId'],
    },
    handler: async (args) => {
      const timeoutMs = Number(args['timeoutSec'] ?? 300) * 1000
      const deadline = Date.now() + timeoutMs
      const DONE = new Set(['idle', 'needs_input', 'sleeping', 'succeeded', 'failed', 'killed'])
      let last: { status: string } | undefined
      while (Date.now() < deadline) {
        last = await api<{ status: string }>('GET', `/api/sessions/${args['sessionId']}`)
        if (DONE.has(last.status)) return { status: last.status, timedOut: false }
        await new Promise((r) => setTimeout(r, 3000))
      }
      return { status: last?.status ?? 'unknown', timedOut: true }
    },
  },
  {
    name: 'note_get',
    description:
      'Read a shared note by key. Notes are a shared key-value store visible to all sessions. ' +
      'Returns { value, updatedAt, updatedBy, tags } or null.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
    handler: async (args) => {
      try {
        return await api('GET', `/api/notes/${encodeURIComponent(String(args['key']))}`)
      } catch (err) {
        if ((err as Error).message.includes('404')) return null
        throw err
      }
    },
  },
  {
    name: 'note_set',
    description:
      'Set (or upsert) a shared note. Value can be any JSON-serializable structure. ' +
      'The current session id is recorded as updatedBy.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: {},
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['key', 'value'],
    },
    handler: async (args) => {
      const body: Record<string, unknown> = { value: args['value'] }
      if (PARENT_SESSION_ID) body['updatedBy'] = PARENT_SESSION_ID
      if (args['tags']) body['tags'] = args['tags']
      return api('PUT', `/api/notes/${encodeURIComponent(String(args['key']))}`, body)
    },
  },
  {
    name: 'note_list',
    description: 'List all shared notes, optionally filtered by key prefix.',
    inputSchema: {
      type: 'object',
      properties: { prefix: { type: 'string' } },
    },
    handler: async (args) => {
      const q = args['prefix'] ? `?prefix=${encodeURIComponent(String(args['prefix']))}` : ''
      return api('GET', `/api/notes${q}`)
    },
  },
]

// ── JSON-RPC dispatch ────────────────────────────────────────────────

async function handle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const id = req.id ?? null

  switch (req.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      }

    case 'notifications/initialized':
      return null // notification, no response

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      }

    case 'tools/call': {
      const p = req.params as { name?: string; arguments?: Record<string, unknown> }
      const tool = TOOLS.find((t) => t.name === p.name)
      if (!tool) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${p.name}` } }
      }
      try {
        const result = await tool.handler(p.arguments ?? {})
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        }
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          },
        }
      }
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }

    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${req.method}` } }
  }
}

// ── stdio loop ───────────────────────────────────────────────────────

log(`starting orchestron-mcp — API_URL=${API_URL} parentSession=${PARENT_SESSION_ID || '(none)'}`)

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let req: JsonRpcRequest
  try {
    req = JSON.parse(line) as JsonRpcRequest
  } catch (err) {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `Parse error: ${(err as Error).message}` } })
    return
  }
  try {
    const res = await handle(req)
    if (res) reply(res)
  } catch (err) {
    reply({
      jsonrpc: '2.0',
      id: req.id ?? null,
      error: { code: -32603, message: (err as Error).message },
    })
  }
})

rl.on('close', () => { log('stdio closed, exiting'); process.exit(0) })
