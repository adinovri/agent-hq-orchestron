import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import multipart from '@fastify/multipart'
import { z } from 'zod'
import path from 'node:path'
import os from 'node:os'
import { mkdir, writeFile, chmod } from 'node:fs/promises'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { SpawnSessionBodySchema } from '@agent-hq-orchestron/shared'
import { SessionManager } from '../domain/session-manager.js'

const UPLOAD_ROOT = '/tmp/orchestron/uploads'
const MAX_FILE_BYTES = 20 * 1024 * 1024   // 20MB per file
const MAX_FILES_PER_REQ = 10

function sanitizeFilename(name: string): string {
  // Strip path separators; keep letters, digits, dots, dashes, underscores.
  const base = name.split(/[/\\]/).pop() ?? 'file'
  return base.replace(/[^\w.\-]/g, '_').slice(0, 120) || 'file'
}
import { HookRunner } from '../domain/hook-runner.js'
import { TemplateResolver, TemplateValidationError } from '../domain/template-resolver.js'
import { DelegationTracker } from '../domain/delegation-tracker.js'
import { ProjectRegistry, ProjectNotFoundError } from '../domain/project-registry.js'

// ── Rollout parsers (per-adapter) ────────────────────────────────

interface RolloutEntry {
  seq: number
  timestamp: string
  kind: 'user' | 'assistant' | 'tool_use' | 'tool_result'
  toolName?: string
  content: string
}

interface RolloutStats {
  lastInputTokens: number
  lastCacheReadTokens: number
  lastCacheCreationTokens: number
  lastOutputTokens: number
  lastEffectiveContext: number
  assistantTurns: number
  compactionCount: number
  lastCompactedAt?: string
  contextWindow?: number
}

interface RolloutParsed {
  entries: RolloutEntry[]
  lastTurnEndTs: string
  lastUserTs: string
  lastAssistantText: string
  contextStats: RolloutStats | null
}

/** Parse Claude JSONL rollout. */
/** Model-derived context window for Claude sessions. JSONL doesn't emit
 *  a native context_window (codex does), so we infer from the model
 *  string carried on the session record.
 *
 *  - Any model with a `[1m]` suffix (Claude Code's opt-in 1M-tier tag,
 *    e.g. `opus[1m]`, `sonnet[1m]`) → 1_000_000
 *  - Opus 5 (native 1M tier by default) → 1_000_000
 *  - Everything else (Sonnet/Haiku/older Opus without [1m]) → 200_000
 *
 *  Falls back to 200K when the model is unknown / undefined so the UI
 *  never renders an unbounded bar. */
function claudeContextWindowForModel(model?: string): number {
  if (!model) return 200_000
  const m = model.toLowerCase()
  if (/\[1m\]$/.test(m)) return 1_000_000
  if (/(^|[^0-9])opus[- ]?5(\b|[^0-9])/.test(m)) return 1_000_000
  return 200_000
}

function parseClaudeRollout(raw: string): RolloutParsed {
  const entries: RolloutEntry[] = []
  let lastTurnEndTs = ''
  let lastUserTs = ''
  let lastAssistantText = ''
  let assistantTurns = 0
  let compactionCount = 0
  let lastCompactedAt: string | undefined
  let lastUsage: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  } | undefined
  let seq = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let ev: {
      type?: string
      subtype?: string
      timestamp?: string
      message?: {
        content?: string | Array<{ type?: string; text?: string; name?: string; input?: unknown; content?: string | Array<{ text?: string }> }>
        usage?: {
          input_tokens?: number
          output_tokens?: number
          cache_read_input_tokens?: number
          cache_creation_input_tokens?: number
        }
      }
    }
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'system' && ev.subtype === 'turn_duration' && ev.timestamp) lastTurnEndTs = ev.timestamp
    if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
      compactionCount += 1
      if (ev.timestamp) lastCompactedAt = ev.timestamp
    }
    if (ev.type === 'user' && typeof ev.message?.content === 'string' && ev.timestamp) lastUserTs = ev.timestamp
    if (ev.type === 'assistant' && ev.message?.usage) {
      assistantTurns += 1
      lastUsage = ev.message.usage
    }
    const ts = ev.timestamp ?? ''
    const t = ev.type
    const content = ev.message?.content
    if (t === 'user' && typeof content === 'string') {
      entries.push({ seq: seq++, timestamp: ts, kind: 'user', content })
    } else if (t === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text) {
          entries.push({ seq: seq++, timestamp: ts, kind: 'assistant', content: b.text })
          lastAssistantText = b.text
        } else if (b.type === 'tool_use') {
          const inputStr = JSON.stringify(b.input ?? {}, null, 2).slice(0, 4000)
          entries.push({ seq: seq++, timestamp: ts, kind: 'tool_use', toolName: b.name, content: inputStr })
        }
      }
    } else if (t === 'user' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'tool_result') {
          const c = b.content
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x.text ?? '').join('') : ''
          if (text) entries.push({ seq: seq++, timestamp: ts, kind: 'tool_result', content: text.slice(0, 4000) })
        }
      }
    }
  }
  const contextStats: RolloutStats | null = lastUsage
    ? {
        lastInputTokens: lastUsage.input_tokens ?? 0,
        lastCacheReadTokens: lastUsage.cache_read_input_tokens ?? 0,
        lastCacheCreationTokens: lastUsage.cache_creation_input_tokens ?? 0,
        lastOutputTokens: lastUsage.output_tokens ?? 0,
        lastEffectiveContext:
          (lastUsage.input_tokens ?? 0) +
          (lastUsage.cache_read_input_tokens ?? 0) +
          (lastUsage.cache_creation_input_tokens ?? 0),
        assistantTurns,
        compactionCount,
        lastCompactedAt,
      }
    : null
  return { entries, lastTurnEndTs, lastUserTs, lastAssistantText, contextStats }
}

/** Parse Codex JSONL rollout. Event schema differs from Claude:
 *    { timestamp, ordinal, type, payload }
 *  types: session_meta | turn_context | world_state | event_msg |
 *         response_item | token_usage_record
 *  event_msg.type: task_started | task_complete | token_count | item_completed
 *  response_item.type: message (with role + content parts) | tool-use etc.
 */
function parseCodexRollout(raw: string): RolloutParsed {
  const entries: RolloutEntry[] = []
  let lastTurnEndTs = ''
  let lastUserTs = ''
  let lastAssistantText = ''
  let assistantTurns = 0
  let lastTokenInfo: {
    input_tokens?: number
    cached_input_tokens?: number
    cache_write_input_tokens?: number
    output_tokens?: number
  } | undefined
  let modelContextWindow: number | undefined
  let seq = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let ev: {
      timestamp?: string
      type?: string
      payload?: {
        type?: string
        role?: string
        content?: unknown
        info?: {
          last_token_usage?: {
            input_tokens?: number
            cached_input_tokens?: number
            cache_write_input_tokens?: number
            output_tokens?: number
          }
          model_context_window?: number
        }
      }
    }
    try { ev = JSON.parse(line) } catch { continue }
    const ts = ev.timestamp ?? ''
    const p = ev.payload ?? {}

    if (ev.type === 'event_msg' && p.type === 'task_started' && ts) lastUserTs = ts
    if (ev.type === 'event_msg' && p.type === 'task_complete' && ts) {
      lastTurnEndTs = ts
      assistantTurns += 1
    }
    if (ev.type === 'event_msg' && p.type === 'token_count' && p.info) {
      if (p.info.last_token_usage) lastTokenInfo = p.info.last_token_usage
      if (typeof p.info.model_context_window === 'number') modelContextWindow = p.info.model_context_window
    }

    // response_item.message with role user/assistant. content is an array of parts.
    if (ev.type === 'response_item' && p.type === 'message') {
      const role = p.role === 'assistant' ? 'assistant' : 'user'
      const parts = Array.isArray(p.content) ? p.content as Array<{ type?: string; text?: string }> : []
      const text = parts.map((x) => (typeof x.text === 'string' ? x.text : '')).join('').trim()
      if (text) {
        entries.push({ seq: seq++, timestamp: ts, kind: role, content: text })
        if (role === 'assistant') lastAssistantText = text
      }
    }
    // TODO(probe): codex tool_use / tool_result shapes when real session hits them
  }
  const contextStats: RolloutStats | null = lastTokenInfo
    ? {
        lastInputTokens: (lastTokenInfo.input_tokens ?? 0) - (lastTokenInfo.cached_input_tokens ?? 0),
        lastCacheReadTokens: lastTokenInfo.cached_input_tokens ?? 0,
        lastCacheCreationTokens: lastTokenInfo.cache_write_input_tokens ?? 0,
        lastOutputTokens: lastTokenInfo.output_tokens ?? 0,
        lastEffectiveContext: lastTokenInfo.input_tokens ?? 0,
        assistantTurns,
        compactionCount: 0,   // TODO(probe): does codex compact? no signal seen yet
        contextWindow: modelContextWindow,
      }
    : null
  return { entries, lastTurnEndTs, lastUserTs, lastAssistantText, contextStats }
}

function expandCodexHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  if (p === '~') return os.homedir()
  return p
}

/**
 * Parse codex interactive TUI sessions from SQLite (thread_history_1.sqlite).
 * Used when jsonlPath is empty (interactive TUI never writes rollout JSONL).
 */
function parseCodexSqlite(codexHome: string, threadId: string): RolloutParsed {
  const entries: RolloutEntry[] = []
  let lastTurnEndTs = ''
  let lastUserTs = ''
  let lastAssistantText = ''
  let assistantTurns = 0

  if (!threadId) return { entries, lastTurnEndTs, lastUserTs, lastAssistantText, contextStats: null }

  const dbPath = path.join(expandCodexHome(codexHome), 'thread_history_1.sqlite')
  let db: Database.Database | undefined
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    db.pragma('journal_mode = WAL')

    const itemRows = db.prepare(
      'SELECT item_type, item_json, created_at_ms FROM thread_items WHERE thread_id = ? ORDER BY updated_at_ordinal ASC'
    ).all(threadId) as Array<{ item_type: string; item_json: string; created_at_ms: number }>

    let seq = 0
    for (const row of itemRows) {
      let parsed: {
        type?: string
        text?: string
        content?: Array<{ type?: string; text?: string }>
      }
      try { parsed = JSON.parse(row.item_json) } catch { continue }

      const ts = new Date(row.created_at_ms).toISOString()

      if (row.item_type === 'userMessage') {
        const parts = Array.isArray(parsed.content) ? parsed.content : []
        const text = parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('').trim()
          || (typeof parsed.text === 'string' ? parsed.text : '')
        if (text) {
          entries.push({ seq: seq++, timestamp: ts, kind: 'user', content: text })
          if (!lastUserTs || ts > lastUserTs) lastUserTs = ts
        }
      } else if (row.item_type === 'agentMessage') {
        const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
        if (text) {
          entries.push({ seq: seq++, timestamp: ts, kind: 'assistant', content: text })
          lastAssistantText = text
        }
      }
    }

    const turnRows = db.prepare(
      'SELECT completed_at, started_at FROM thread_turns WHERE thread_id = ? AND status = ? AND completed_at IS NOT NULL'
    ).all(threadId, 'completed') as Array<{ completed_at: number; started_at: number }>

    assistantTurns = turnRows.length
    for (const t of turnRows) {
      // thread_turns.completed_at is in SECONDS (not ms); thread_items.created_at_ms is in ms
      const ts = new Date(t.completed_at * 1000).toISOString()
      if (!lastTurnEndTs || ts > lastTurnEndTs) lastTurnEndTs = ts
    }
  } catch {
    // DB not yet written or schema mismatch — return empty gracefully
  } finally {
    db?.close()
  }

  return { entries, lastTurnEndTs, lastUserTs, lastAssistantText, contextStats: null }
}

export function sessionsPlugin(
  manager: SessionManager,
  hookRunner: HookRunner,
  templateResolver: TemplateResolver,
  tracker: DelegationTracker,
  registry: ProjectRegistry,
) {
  return fp(async (app: FastifyInstance) => {
    await app.register(multipart, {
      limits: {
        fileSize: MAX_FILE_BYTES,
        files: MAX_FILES_PER_REQ,
      },
    })

    app.post('/api/sessions', async (req, reply) => {
      // Accept either JSON or multipart (multipart lets the client attach
      // files at spawn time — same behaviour as follow-up /input's file
      // upload). Files are staged to /tmp/orchestron/uploads/pending/<random>
      // and moved to uploads/<session-id>/ once the session is created; their
      // absolute paths get appended to initialPrompt so Claude's Read tool
      // can consume them.
      let parsedBody: unknown
      const pendingFiles: Array<{ srcPath: string; name: string; size: number; mime: string }> = []
      const ct = req.headers['content-type'] ?? ''

      if (ct.includes('multipart/form-data')) {
        const fields: Record<string, string> = {}
        try {
          const pendingDir = path.join(UPLOAD_ROOT, 'pending', crypto.randomBytes(8).toString('hex'))
          await mkdir(pendingDir, { recursive: true, mode: 0o700 })
          for await (const part of req.parts()) {
            if (part.type === 'file') {
              const orig = sanitizeFilename(part.filename ?? 'file')
              const stamp = crypto.randomBytes(4).toString('hex')
              const target = path.join(pendingDir, `${stamp}-${orig}`)
              const buf = await part.toBuffer()
              await writeFile(target, buf, { mode: 0o600 })
              pendingFiles.push({ srcPath: target, name: orig, size: buf.length, mime: part.mimetype ?? 'application/octet-stream' })
            } else {
              // JSON-encoded fields: `body` (whole spawn payload) OR individual keys
              fields[part.fieldname] = part.value as string
            }
          }
        } catch (err: unknown) {
          return reply.code(400).send({ error: (err as Error).message ?? 'multipart parse failed' })
        }
        if (fields.body) {
          try { parsedBody = JSON.parse(fields.body) } catch { return reply.code(400).send({ error: 'body field is not valid JSON' }) }
        } else {
          parsedBody = {
            projectId: fields.projectId,
            prompt: fields.prompt || undefined,
            template: fields.template || undefined,
            vars: fields.vars ? JSON.parse(fields.vars) : undefined,
            parentSessionId: fields.parentSessionId || undefined,
            detached: fields.detached === 'true' ? true : undefined,
          }
        }
      } else {
        parsedBody = req.body
      }

      const body = SpawnSessionBodySchema.safeParse(parsedBody)
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

      const { projectId, prompt, template, vars, parentSessionId, detached } = body.data

      // Resolve project
      let project
      try {
        project = await registry.get(projectId)
      } catch (err) {
        if (err instanceof ProjectNotFoundError) return reply.code(404).send({ error: err.message })
        throw err
      }

      // pre-spawn hook
      try {
        await hookRunner.fire('pre-spawn', { event: 'pre-spawn', projectId, parentSessionId })
      } catch (err: unknown) {
        return reply.code(422).send({ error: (err as Error).message })
      }

      // Resolve template or use raw prompt
      let initialPrompt = prompt ?? ''
      if (template) {
        try {
          initialPrompt = await templateResolver.resolve(template, { project, vars })
        } catch (err) {
          if (err instanceof TemplateValidationError) {
            return reply.code(422).send({ error: err.message })
          }
          throw err
        }
      }

      if (!initialPrompt && pendingFiles.length === 0) {
        return reply.code(422).send({ error: 'prompt or template required' })
      }
      if (!initialPrompt) initialPrompt = '(see attached files)'

      // Append file references to the prompt BEFORE spawn — that way the
      // pasted initialPrompt includes them and Claude can Read them
      // immediately in its first turn.
      if (pendingFiles.length > 0) {
        const list = pendingFiles.map(f => `- ${f.srcPath}  (${f.name}, ${f.size}B, ${f.mime})`).join('\n')
        initialPrompt = `${initialPrompt}\n\nAttached files (saved on server, use Read tool to inspect):\n${list}`
      }

      const configDir = project.agentType === 'codex'
        ? project.agentConfig?.env?.['CODEX_HOME']
        : project.agentConfig?.env?.['CLAUDE_CONFIG_DIR']

      // Enforce 1-project-1-harness rule: a project's agentType is
      // authoritative. Body agentType (if any) must match, else reject —
      // avoids cross-harness mismatches like spawning codex against a
      // project whose defaults are Claude-flavored.
      if (body.data.agentType && body.data.agentType !== project.agentType) {
        return reply.code(409).send({
          error: `Project agentType is '${project.agentType}' — cannot spawn '${body.data.agentType}' session against it. One project = one harness.`,
        })
      }
      const agentType = project.agentType

      const session = await manager.spawn({
        projectId,
        agentType,
        initialPrompt,
        parentSessionId,
        workspace: project.path,
        detached,
        configDir,
        // Body values override project defaults; empty falls back to project.
        model: body.data.model ?? project.defaultModel,
        effort: body.data.effort ?? project.defaultEffort,
      })

      // Record delegation edge if parent session provided
      if (parentSessionId) {
        await tracker.recordEdge(parentSessionId, session.id, initialPrompt, detached ?? false)
      }

      // Async post-spawn notification
      hookRunner.fire('post-transcript-chunk', { event: 'post-transcript-chunk', sessionUuid: session.id }).catch(() => {})

      return reply.code(201).send(session)
    })

    app.get('/api/sessions', async (req) => {
      const query = req.query as Record<string, string>
      const statusFilter = query['status']
      const projectIdFilter = query['projectId']
      const tagFilter = query['tag'] ? query['tag']!.split(',').filter(Boolean) : undefined
      const fromFilter = query['from']
      const toFilter = query['to']

      let sessions = await manager.list({
        status: statusFilter,
        projectId: projectIdFilter,
        from: fromFilter,
        to: toFilter,
      })

      if (tagFilter && tagFilter.length > 0) {
        const tagSet = new Set(tagFilter)
        const projectCache = new Map<string, string[]>()
        sessions = (await Promise.all(sessions.map(async s => {
          if (!projectCache.has(s.projectId)) {
            try {
              const proj = await registry.get(s.projectId)
              projectCache.set(s.projectId, proj.tags ?? [])
            } catch {
              projectCache.set(s.projectId, [])
            }
          }
          const projTags = projectCache.get(s.projectId) ?? []
          return projTags.some(t => tagSet.has(t)) ? s : null
        }))).filter((s): s is NonNullable<typeof s> => s !== null)
      }

      return { sessions }
    })

    app.get('/api/sessions/:uuid', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }
      const sessions = await manager.list()
      const session = sessions.find(s => s.id === uuid)
      if (!session) return reply.code(404).send({ error: `Session not found: ${uuid}` })
      return session
    })

    // Poll-based transcript — client-friendly alternative to SSE. Returns
    // the full JSONL parsed into user/assistant/tool_use/tool_result entries
    // with a stable seq. Client uses React Query polling; no SSE, no dedupe,
    // no reconnect logic needed.
    app.get('/api/sessions/:uuid/transcript', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }
      const sessions = await manager.list()
      const session = sessions.find(s => s.id === uuid)
      if (!session) return reply.code(404).send({ error: `Session not found: ${uuid}` })

      // Codex interactive TUI: no JSONL rollout — read from SQLite instead.
      if (session.agentType === 'codex' && !session.jsonlPath) {
        const codexHome = session.configDir
          ?? process.env['CODEX_HOME']
          ?? path.join(os.homedir(), '.codex')
        const parsed = parseCodexSqlite(codexHome, session.claudeSessionUuid)
        const turnEndedAfterUser = parsed.lastTurnEndTs && (!parsed.lastUserTs || parsed.lastTurnEndTs > parsed.lastUserTs)
        if (turnEndedAfterUser && session.status === 'running') {
          manager.reconcileTurnEnd(session.id, parsed.lastAssistantText).catch(() => {})
        }
        return { entries: parsed.entries, size: 0, contextStats: parsed.contextStats }
      }

      const { readFile } = await import('node:fs/promises')
      let raw = ''
      try {
        raw = await readFile(session.jsonlPath, 'utf8')
      } catch {
        return { entries: [], size: 0 }
      }

      type Entry = {
        seq: number
        timestamp: string
        kind: 'user' | 'assistant' | 'tool_use' | 'tool_result'
        toolName?: string
        content: string
      }
      type Parsed = {
        entries: Entry[]
        lastTurnEndTs: string
        lastUserTs: string
        lastAssistantText: string
        contextStats: {
          lastInputTokens: number
          lastCacheReadTokens: number
          lastCacheCreationTokens: number
          lastOutputTokens: number
          lastEffectiveContext: number
          assistantTurns: number
          compactionCount: number
          lastCompactedAt?: string
          contextWindow?: number   // codex reports this natively; claude fixed 200K client-side
        } | null
      }

      // Adapter-specific rollout parsers. Both produce the same Parsed shape.
      const parsed = session.agentType === 'codex' ? parseCodexRollout(raw) : parseClaudeRollout(raw)

      // Safety net: reconcile stuck status. Only if the latest turn-end
      // marker is AFTER the latest user prompt — otherwise the marker is
      // from a previous turn and the current one is still running.
      const turnEndedAfterUser = parsed.lastTurnEndTs && (!parsed.lastUserTs || parsed.lastTurnEndTs > parsed.lastUserTs)
      if (turnEndedAfterUser && session.status === 'running') {
        manager.reconcileTurnEnd(session.id, parsed.lastAssistantText).catch(() => {})
      } else if (session.status === 'running') {
        // AskUserQuestion special-case: Claude shows an interactive selector
        // modal in the TUI and does NOT emit `turn_duration` until the user
        // answers. Without this the session sits at `running` in the list
        // view even though it's actually blocked on input. Detect a pending
        // AskUserQuestion (tool_use with no matching later tool_result) and
        // flip to `needs_input` so the dashboard surfaces it.
        const hasPendingAskUser = parsed.entries.some((e, i) =>
          e.kind === 'tool_use' &&
          e.toolName === 'AskUserQuestion' &&
          !parsed.entries.slice(i + 1).some(later => later.kind === 'tool_result'),
        )
        if (hasPendingAskUser) {
          manager.reconcilePendingUserQuestion(session.id).catch(() => {})
        }
      }

      // Claude JSONL doesn't emit a native context_window field the way
      // codex rollout does — enrich contextStats with a model-derived
      // window so the UI indicator matches what the user actually has
      // (Opus 5 native = 1M, `<model>[1m]` suffix opts the 200K-native
      // families onto the 1M tier).
      const withWindow =
        session.agentType === 'claude' && parsed.contextStats && !parsed.contextStats.contextWindow
          ? { ...parsed.contextStats, contextWindow: claudeContextWindowForModel(session.model) }
          : parsed.contextStats
      return { entries: parsed.entries, size: raw.length, contextStats: withWindow }
    })

    app.post('/api/sessions/:uuid/input', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }
      const body = z.object({ prompt: z.string().min(1) }).safeParse(req.body)
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

      try {
        const session = await manager.sendInput(uuid, body.data.prompt)
        return session
      } catch (err: unknown) {
        const msg = (err as Error).message ?? ''
        if (msg.includes('not found')) return reply.code(404).send({ error: msg })
        if (msg.includes('Cannot send input')) return reply.code(409).send({ error: msg })
        throw err
      }
    })

    // Adopt an existing harness session (started outside orchestron) into a
    // new orchestron session record. Body: { projectId, harnessSessionId }.
    // See SessionManager.adopt() for validation rules.
    app.post('/api/sessions/adopt', async (req, reply) => {
      const body = z.object({
        projectId: z.string().min(1),
        harnessSessionId: z.string().min(8),
        model: z.string().optional(),
        effort: z.enum(['low', 'medium', 'high', 'ultra']).optional(),
      }).safeParse(req.body)
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

      let project
      try {
        project = await registry.get(body.data.projectId)
      } catch (err) {
        if (err instanceof ProjectNotFoundError) return reply.code(404).send({ error: err.message })
        throw err
      }

      try {
        const session = await manager.adopt({
          projectId: project.id,
          agentType: project.agentType,
          workspace: project.path,
          configDir: (project.agentType === 'codex' ? project.agentConfig?.env?.['CODEX_HOME'] : project.agentConfig?.env?.['CLAUDE_CONFIG_DIR']) ?? undefined,
          model: body.data.model ?? project.defaultModel,
          effort: body.data.effort ?? project.defaultEffort,
          harnessSessionId: body.data.harnessSessionId,
        })
        return reply.code(201).send(session)
      } catch (err: unknown) {
        const msg = (err as Error).message ?? 'adopt failed'
        if (msg.includes('not supported')) return reply.code(400).send({ error: msg })
        if (msg.includes('Invalid harness')) return reply.code(400).send({ error: msg })
        if (msg.includes('already adopted')) return reply.code(409).send({ error: msg })
        if (msg.includes('not found')) return reply.code(404).send({ error: msg })
        if ((err as Error).name === 'PoolFullError') return reply.code(503).send({ error: msg })
        throw err
      }
    })

    // Dry-run adopt: run the same validations without spawning anything.
    // Frontend calls this on UUID input blur to give live feedback before
    // the user hits Create.
    app.post('/api/sessions/adopt/validate', async (req, reply) => {
      const body = z.object({
        projectId: z.string().min(1),
        harnessSessionId: z.string().min(1),
      }).safeParse(req.body)
      if (!body.success) return { ok: false, error: 'Invalid input' }

      let project
      try {
        project = await registry.get(body.data.projectId)
      } catch {
        return { ok: false, error: `Project not found: ${body.data.projectId}` }
      }
      if (project.agentType !== 'claude' && project.agentType !== 'codex') {
        return { ok: false, error: `Adopt not supported for agent type '${project.agentType}'` }
      }
      if (!/^[0-9a-fA-F-]{8,}$/.test(body.data.harnessSessionId)) {
        return { ok: false, error: `Invalid harness session id format` }
      }

      const all = await manager.list()
      const ACTIVE = ['spawning', 'waiting', 'running', 'idle', 'needs_input', 'sleeping']
      const dup = all.find((s) => s.claudeSessionUuid === body.data.harnessSessionId && ACTIVE.includes(s.status))
      if (dup) {
        return { ok: false, error: `Already adopted by orchestron session ${dup.id.slice(0, 8)} (status: ${dup.status}). Archive/kill it first.` }
      }

      // Cross-process check: a bg agent or terminal session may already hold
      // this UUID open. Reading /proc/*/cmdline is cheap.
      const liveProc = await manager.findLiveHarnessProcessPublic(body.data.harnessSessionId)
      if (liveProc) {
        return { ok: false, error: `PID ${liveProc.pid} is currently running this session (cmd: ${liveProc.cmd.slice(0, 100)}…). Stop it before adopting to avoid transcript corruption.` }
      }

      const configDir = (project.agentType === 'codex'
        ? project.agentConfig?.env?.['CODEX_HOME']
        : project.agentConfig?.env?.['CLAUDE_CONFIG_DIR']) ?? undefined
      if (project.agentType === 'claude') {
        const { claudeTranscriptPath, effectiveClaudeConfigDir } = await import('../adapters/claude.js')
        const effCfg = effectiveClaudeConfigDir(configDir)
        const jsonlPath = claudeTranscriptPath(project.path, effCfg, body.data.harnessSessionId)
        const { existsSync } = await import('node:fs')
        if (!existsSync(jsonlPath)) {
          return { ok: false, error: `Transcript not found at ${jsonlPath}. Check the UUID + that the session was started in this workspace.` }
        }
        return { ok: true, agent: project.agentType, workspace: project.path, jsonlPath }
      } else {
        const { findCodexRolloutPath, effectiveCodexHome } = await import('../adapters/codex.js')
        const rolloutPath = await findCodexRolloutPath(configDir, body.data.harnessSessionId)
        const codexHome = effectiveCodexHome(configDir)
        if (rolloutPath) {
          return { ok: true, agent: project.agentType, workspace: project.path, jsonlPath: rolloutPath }
        }
        // No rollout — verify SQLite thread_history_1.sqlite has the thread.
        // TUI-only sessions never write rollout jsonl; SQLite is authoritative.
        const dbPath = path.join(codexHome, 'thread_history_1.sqlite')
        try {
          const Database = (await import('better-sqlite3')).default
          const db = new Database(dbPath, { readonly: true, fileMustExist: true })
          const row = db.prepare('SELECT 1 FROM thread_items WHERE thread_id = ? LIMIT 1').get(body.data.harnessSessionId) as { '1': number } | undefined
          db.close()
          if (row) {
            return { ok: true, agent: project.agentType, workspace: project.path, jsonlPath: `${dbPath} (SQLite thread_history, TUI-only session — no rollout on disk)` }
          }
          return { ok: false, error: `Codex thread ${body.data.harnessSessionId} not found in ${codexHome}/sessions/YYYY/MM/DD/rollout-*.jsonl nor SQLite thread_history_1.sqlite. Check the UUID.` }
        } catch (err) {
          return { ok: false, error: `Codex rollout not found and SQLite unreadable at ${dbPath}: ${(err as Error).message}` }
        }
      }
    })

    // Answer a pending TUI selector modal (permission approval, AskUserQuestion
    // fallback) by option index. Sends Down×(index-1) + Enter into the tmux
    // pane and clears session.pendingPrompt so the UI banner disappears.
    app.post('/api/sessions/:uuid/answer-prompt', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }
      const body = z.object({ index: z.number().int().min(1) }).safeParse(req.body)
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })
      try {
        const session = await manager.answerPendingPrompt(uuid, body.data.index)
        return session
      } catch (err: unknown) {
        const msg = (err as Error).message ?? ''
        if (msg.includes('not found')) return reply.code(404).send({ error: msg })
        if (msg.includes('No pending prompt')) return reply.code(409).send({ error: msg })
        if (msg.includes('Invalid choice')) return reply.code(400).send({ error: msg })
        throw err
      }
    })

    // Upload files (images, code, PDFs) to a session's temp dir. Returns
    // the saved paths so the caller can reference them in a follow-up prompt
    // (Claude's Read/vision tools consume by absolute path).
    app.post('/api/sessions/:uuid/upload', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }
      const sessions = await manager.list()
      const session = sessions.find(s => s.id === uuid)
      if (!session) return reply.code(404).send({ error: `Session not found: ${uuid}` })

      const dir = path.join(UPLOAD_ROOT, uuid)
      await mkdir(dir, { recursive: true, mode: 0o700 })

      interface SavedFile { path: string; name: string; size: number; mime: string }
      const saved: SavedFile[] = []

      try {
        const parts = req.parts()
        for await (const part of parts) {
          if (part.type !== 'file') continue
          const orig = sanitizeFilename(part.filename ?? 'file')
          const stamp = crypto.randomBytes(4).toString('hex')
          const finalName = `${stamp}-${orig}`
          const target = path.join(dir, finalName)
          const buf = await part.toBuffer()
          await writeFile(target, buf, { mode: 0o600 })
          await chmod(target, 0o600)
          saved.push({
            path: target,
            name: orig,
            size: buf.length,
            mime: part.mimetype ?? 'application/octet-stream',
          })
        }
      } catch (err: unknown) {
        return reply.code(400).send({ error: (err as Error).message ?? 'upload failed' })
      }

      if (saved.length === 0) {
        return reply.code(400).send({ error: 'no files uploaded' })
      }
      return { files: saved }
    })

    // Interrupt the current turn — sends Escape to Claude TUI to abort
    // the in-flight API call. Session stays alive, transitions to idle
    // once the tailer picks up turn_duration.
    app.post('/api/sessions/:uuid/interrupt', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }
      try {
        const session = await manager.interrupt(uuid)
        return session
      } catch (err: unknown) {
        const msg = (err as Error).message ?? ''
        if (msg.includes('not found')) return reply.code(404).send({ error: msg })
        if (msg.includes('Cannot interrupt')) return reply.code(409).send({ error: msg })
        throw err
      }
    })

    // Reopen a terminal session — same UUID + same Claude session, fresh tmux.
    // Session comes back to `idle` after Claude TUI boots with --resume.
    // Body { model?, effort? } lets the user override for this reopen.
    app.post('/api/sessions/:uuid/reopen', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }
      const body = z.object({
        model: z.string().optional(),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
      }).safeParse(req.body ?? {})
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

      const sessions = await manager.list()
      const existing = sessions.find(s => s.id === uuid)
      if (!existing) return reply.code(404).send({ error: `Session not found: ${uuid}` })
      let project
      try { project = await registry.get(existing.projectId) } catch {
        return reply.code(404).send({ error: `Project not found: ${existing.projectId}` })
      }
      if (existing.agentType !== project.agentType) {
        return reply.code(409).send({ error: `Cross-harness session — this session runs as '${existing.agentType}' but project '${project.name}' is '${project.agentType}'. Legacy ghost session (predates 1-project-1-harness enforcement). Archive it and spawn fresh instead.` })
      }
      const configDir = project.agentType === 'codex'
        ? project.agentConfig?.env?.['CODEX_HOME']
        : project.agentConfig?.env?.['CLAUDE_CONFIG_DIR']
      try {
        const updated = await manager.reopen(
          uuid, project.path, configDir,
          project.defaultModel, project.defaultEffort,
          { model: body.data.model, effort: body.data.effort },
        )
        return updated
      } catch (err: unknown) {
        const msg = (err as Error).message ?? ''
        if (msg.includes('Cannot reopen')) return reply.code(409).send({ error: msg })
        if (msg.includes('no transcript on disk')) return reply.code(409).send({ error: msg })
        throw err
      }
    })

    // Respawn — fresh orchestron session inheriting the original's project +
    // initialPrompt + model + effort. Fresh Claude conversation UUID.
    // Use for terminal sessions whose Claude conversation is missing on disk
    // or when you just want to start over from the same prompt.
    app.post('/api/sessions/:uuid/respawn', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }
      const body = z.object({
        model: z.string().optional(),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
      }).safeParse(req.body ?? {})
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

      const sessions = await manager.list()
      const existing = sessions.find(s => s.id === uuid)
      if (!existing) return reply.code(404).send({ error: `Session not found: ${uuid}` })
      let project
      try { project = await registry.get(existing.projectId) } catch {
        return reply.code(404).send({ error: `Project not found: ${existing.projectId}` })
      }
      if (existing.agentType !== project.agentType) {
        return reply.code(409).send({ error: `Cross-harness session — this session runs as '${existing.agentType}' but project '${project.name}' is '${project.agentType}'. Legacy ghost session (predates 1-project-1-harness enforcement). Archive it and spawn fresh instead.` })
      }
      const configDir = project.agentType === 'codex'
        ? project.agentConfig?.env?.['CODEX_HOME']
        : project.agentConfig?.env?.['CLAUDE_CONFIG_DIR']
      try {
        // In-place respawn — returns the SAME session id, updated record.
        // 200 OK (not 201) since no new resource was created.
        const fresh = await manager.respawn(
          uuid, project.path, configDir,
          project.defaultModel, project.defaultEffort,
          { model: body.data.model, effort: body.data.effort },
        )
        return fresh
      } catch (err: unknown) {
        const msg = (err as Error).message ?? ''
        if (msg.includes('Cannot respawn')) return reply.code(409).send({ error: msg })
        if (msg.includes('Session pool is full')) return reply.code(429).send({ error: msg })
        throw err
      }
    })

    // Clone/fork — new orchestron session, inherits the source's Claude
    // conversation via --resume. Optional { prompt } to seed the fork with
    // a new user turn (else just re-enters the shared context idle).
    app.post('/api/sessions/:uuid/clone', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }
      const body = z.object({
        prompt: z.string().optional(),
        model: z.string().optional(),
        effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
      }).safeParse(req.body ?? {})
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

      const sessions = await manager.list()
      const existing = sessions.find(s => s.id === uuid)
      if (!existing) return reply.code(404).send({ error: `Session not found: ${uuid}` })
      let project
      try { project = await registry.get(existing.projectId) } catch {
        return reply.code(404).send({ error: `Project not found: ${existing.projectId}` })
      }
      if (existing.agentType !== project.agentType) {
        return reply.code(409).send({ error: `Cross-harness session — this session runs as '${existing.agentType}' but project '${project.name}' is '${project.agentType}'. Legacy ghost session (predates 1-project-1-harness enforcement). Archive it and spawn fresh instead.` })
      }
      const configDir = project.agentType === 'codex'
        ? project.agentConfig?.env?.['CODEX_HOME']
        : project.agentConfig?.env?.['CLAUDE_CONFIG_DIR']

      try {
        const cloned = await manager.clone(
          uuid,
          { workspace: project.path, configDir },
          body.data.prompt,
          project.defaultModel, project.defaultEffort,
          { model: body.data.model, effort: body.data.effort },
        )
        return reply.code(201).send(cloned)
      } catch (err: unknown) {
        const msg = (err as Error).message ?? ''
        if (msg.includes('Session pool is full')) return reply.code(429).send({ error: msg })
        if (msg.includes('Cannot fork') || msg.includes('no transcript on disk')) {
          return reply.code(409).send({ error: msg })
        }
        throw err
      }
    })

    // Mark session as done (tycho-style archive). Kills tmux + transitions
    // through completing → succeeded. Idempotent per allowed-state guard.
    app.post('/api/sessions/:uuid/archive', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }
      try {
        const session = await manager.archive(uuid)
        return session
      } catch (err: unknown) {
        const msg = (err as Error).message ?? ''
        if (msg.includes('not found')) return reply.code(404).send({ error: msg })
        if (msg.includes('Cannot archive')) return reply.code(409).send({ error: msg })
        throw err
      }
    })

    app.delete('/api/sessions/:uuid', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }
      try {
        // Kill cascade (descendants first)
        await tracker.killCascade(uuid, manager)
        const session = await manager.kill(uuid)
        return session
      } catch (err: unknown) {
        if ((err as Error).message?.includes('not found')) {
          return reply.code(404).send({ error: (err as Error).message })
        }
        throw err
      }
    })

    // Permanently remove the orchestron session record (JSON + .bak + per-
    // session MCP config). Distinct from DELETE /api/sessions/:uuid which
    // kills the tmux and keeps the record in `killed` state for review.
    // Only allowed for terminal / sleeping states — active must be killed
    // first. Harness transcript stays put so the same session can be Adopt'd
    // back later.
    app.delete('/api/sessions/:uuid/record', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }
      try {
        const result = await manager.deleteRecord(uuid)
        return reply.code(200).send(result)
      } catch (err: unknown) {
        const msg = (err as Error).message ?? ''
        if (msg.includes('not found')) return reply.code(404).send({ error: msg })
        if (msg.includes('Cannot delete')) return reply.code(409).send({ error: msg })
        throw err
      }
    })

    // ------------------------------------------------------------------
    // Export / import — move a harness session between orchestron hosts.
    // Bundle format:
    //   • claude, codex (with rollout .jsonl on disk) → single raw .jsonl
    //   • codex TUI-only (SQLite thread_history) → .tar.gz with
    //     metadata.json + dump.jsonl (thread_turns/items/projection rows)
    // UUID collision at destination is auto-resolved by regenerating the
    // session UUID via crypto.randomUUID() and rewriting the transcript
    // content before adopting.
    // ------------------------------------------------------------------

    app.get('/api/sessions/:uuid/export', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }
      const sessions = await manager.list()
      const session = sessions.find(s => s.id === uuid)
      if (!session) return reply.code(404).send({ error: `Session not found: ${uuid}` })
      const project = await registry.get(session.projectId).catch(() => null)
      const configDir = project?.agentType === 'codex'
        ? project?.agentConfig?.env?.['CODEX_HOME']
        : project?.agentConfig?.env?.['CLAUDE_CONFIG_DIR']

      const harnessUuid = session.claudeSessionUuid
      if (!harnessUuid) {
        return reply.code(409).send({ error: 'Session has no harness UUID yet — spawn likely still pending' })
      }

      const { existsSync } = await import('node:fs')
      const { readFile, rm } = await import('node:fs/promises')

      // Case A — raw .jsonl on disk (claude, or codex with rollout).
      if (session.jsonlPath && existsSync(session.jsonlPath)) {
        const buf = await readFile(session.jsonlPath)
        const fileName = `orchestron-${session.agentType}-${harnessUuid}.jsonl`
        reply
          .header('content-type', 'application/x-ndjson; charset=utf-8')
          .header('content-disposition', `attachment; filename="${fileName}"`)
          .header('x-orchestron-agent-type', session.agentType)
          .header('x-orchestron-source-uuid', harnessUuid)
        return reply.send(buf)
      }

      // Case B — codex TUI-only, dump SQLite rows for this thread.
      if (session.agentType === 'codex') {
        const { effectiveCodexHome } = await import('../adapters/codex.js')
        const codexHome = effectiveCodexHome(configDir)
        const dbPath = path.join(codexHome, 'thread_history_1.sqlite')
        if (!existsSync(dbPath)) {
          return reply.code(404).send({ error: `codex thread_history not found at ${dbPath}` })
        }
        let turns: Record<string, unknown>[] = []
        let items: Record<string, unknown>[] = []
        let projection: Record<string, unknown> | null = null
        try {
          const db = new Database(dbPath, { readonly: true, fileMustExist: true })
          turns = db.prepare('SELECT * FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal').all(harnessUuid) as Record<string, unknown>[]
          items = db.prepare('SELECT * FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal').all(harnessUuid) as Record<string, unknown>[]
          const proj = db.prepare('SELECT * FROM thread_history_projection_state WHERE thread_id = ?').get(harnessUuid) as Record<string, unknown> | undefined
          projection = proj ?? null
          db.close()
        } catch (err) {
          return reply.code(500).send({ error: `SQLite read failed: ${(err as Error).message}` })
        }
        if (turns.length === 0 && items.length === 0) {
          return reply.code(404).send({ error: `no rows for thread ${harnessUuid} in ${dbPath}` })
        }
        const stage = path.join('/tmp', `orchestron-export-${crypto.randomBytes(6).toString('hex')}`)
        await mkdir(stage, { recursive: true, mode: 0o700 })
        try {
          const metadata = {
            kind: 'orchestron-session-bundle',
            version: 1,
            agentType: 'codex',
            transcriptFormat: 'codex-tui-sqlite',
            sourceUuid: harnessUuid,
            sourceWorkspace: project?.path ?? null,
            exportedAt: new Date().toISOString(),
          }
          await writeFile(path.join(stage, 'metadata.json'), JSON.stringify(metadata, null, 2))
          const lines: string[] = []
          for (const row of turns) lines.push(JSON.stringify({ kind: 'thread_turn', data: row }))
          for (const row of items) lines.push(JSON.stringify({ kind: 'thread_item', data: row }))
          if (projection) lines.push(JSON.stringify({ kind: 'projection_state', data: projection }))
          await writeFile(path.join(stage, 'dump.jsonl'), lines.join('\n') + '\n')

          const { spawnSync } = await import('node:child_process')
          const tar = spawnSync('tar', ['-czf', '-', '-C', stage, 'metadata.json', 'dump.jsonl'], {
            maxBuffer: 256 * 1024 * 1024,
          })
          if (tar.status !== 0) {
            return reply.code(500).send({ error: `tar failed: ${tar.stderr?.toString('utf8') ?? ''}` })
          }
          const fileName = `orchestron-codex-tui-${harnessUuid}.tar.gz`
          reply
            .header('content-type', 'application/gzip')
            .header('content-disposition', `attachment; filename="${fileName}"`)
            .header('x-orchestron-agent-type', 'codex')
            .header('x-orchestron-source-uuid', harnessUuid)
            .header('x-orchestron-transcript-format', 'codex-tui-sqlite')
          return reply.send(tar.stdout)
        } finally {
          await rm(stage, { recursive: true, force: true }).catch(() => {})
        }
      }

      return reply.code(500).send({ error: `no transcript available for session ${uuid} (agent: ${session.agentType})` })
    })

    // Import a harness session bundle from another host.
    // Multipart fields: file (required), projectId (required).
    // Auto-detects .jsonl vs .tar.gz by filename extension / mime.
    // On UUID collision at destination, regenerates via crypto.randomUUID()
    // and rewrites the transcript content before persisting, then adopts.
    app.post('/api/sessions/import', async (req, reply) => {
      let projectIdField = ''
      let fileBuf: Buffer | null = null
      let fileName = ''
      let fileMime = ''
      try {
        const parts = req.parts()
        for await (const part of parts) {
          if (part.type === 'file') {
            if (fileBuf) continue
            fileName = sanitizeFilename(part.filename ?? 'session-bundle')
            fileMime = part.mimetype ?? 'application/octet-stream'
            fileBuf = await part.toBuffer()
          } else if (part.type === 'field' && part.fieldname === 'projectId') {
            projectIdField = String(part.value ?? '')
          }
        }
      } catch (err: unknown) {
        return reply.code(400).send({ error: `multipart parse failed: ${(err as Error).message}` })
      }
      if (!fileBuf) return reply.code(400).send({ error: 'no file uploaded' })
      if (!projectIdField) return reply.code(400).send({ error: 'projectId field required' })

      let project
      try {
        project = await registry.get(projectIdField)
      } catch (err) {
        if (err instanceof ProjectNotFoundError) return reply.code(404).send({ error: err.message })
        throw err
      }
      if (project.agentType !== 'claude' && project.agentType !== 'codex') {
        return reply.code(400).send({ error: `import not supported for agent type '${project.agentType}'` })
      }
      const configDir = project.agentType === 'codex'
        ? project.agentConfig?.env?.['CODEX_HOME']
        : project.agentConfig?.env?.['CLAUDE_CONFIG_DIR']

      const isTarGz = fileName.endsWith('.tar.gz')
        || fileName.endsWith('.tgz')
        || fileMime === 'application/gzip'
        || fileMime === 'application/x-gzip'

      const { existsSync } = await import('node:fs')
      const { readFile, rm } = await import('node:fs/promises')

      // ----- Branch A: raw .jsonl (claude or codex rollout) -----
      if (!isTarGz) {
        const raw = fileBuf.toString('utf8')
        if (!raw.trim()) return reply.code(400).send({ error: 'empty jsonl' })

        // Detect harness by scanning first few non-empty JSON lines.
        let detected: 'claude' | 'codex' | 'unknown' = 'unknown'
        let sourceUuid = ''
        const firstLines = raw.split(/\r?\n/).filter(l => l.trim().length > 0).slice(0, 10)
        for (const line of firstLines) {
          let entry: Record<string, unknown>
          try { entry = JSON.parse(line) as Record<string, unknown> } catch { continue }
          if (detected === 'unknown') {
            if (typeof entry.sessionId === 'string') detected = 'claude'
            else if ('payload' in entry || 'record_type' in entry || 'session_id' in entry) detected = 'codex'
          }
          if (!sourceUuid) {
            if (detected === 'claude' && typeof entry.sessionId === 'string') sourceUuid = entry.sessionId
            else if (detected === 'codex') {
              const p = entry.payload as Record<string, unknown> | undefined
              if (p && typeof p.id === 'string' && /^[0-9a-fA-F-]{8,}$/.test(p.id)) sourceUuid = p.id
              else if (typeof entry.session_id === 'string') sourceUuid = entry.session_id
            }
          }
          if (detected !== 'unknown' && sourceUuid) break
        }
        // Filename hint fallback for harness detection.
        if (detected === 'unknown') {
          if (fileName.includes('orchestron-claude-')) detected = 'claude'
          else if (fileName.includes('orchestron-codex-')) detected = 'codex'
        }
        // Filename hint fallback for uuid.
        if (!sourceUuid) {
          const m = fileName.match(/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/)
          if (m) sourceUuid = m[1]
        }
        if (detected === 'unknown') {
          return reply.code(400).send({ error: 'unrecognized JSONL format — not a claude transcript nor a codex rollout' })
        }
        if (detected !== project.agentType) {
          return reply.code(409).send({ error: `bundle is a ${detected} transcript but selected project is ${project.agentType}` })
        }
        if (!sourceUuid) {
          return reply.code(400).send({ error: 'could not extract session UUID from bundle (checked first 10 JSONL lines + filename)' })
        }

        let destUuid = sourceUuid
        let destPath = ''
        let content = raw
        let collided = false

        if (detected === 'claude') {
          const { claudeTranscriptPath, effectiveClaudeConfigDir } = await import('../adapters/claude.js')
          const effCfg = effectiveClaudeConfigDir(configDir)
          destPath = claudeTranscriptPath(project.path, effCfg, sourceUuid)
          if (existsSync(destPath)) {
            destUuid = crypto.randomUUID()
            destPath = claudeTranscriptPath(project.path, effCfg, destUuid)
            content = raw.replaceAll(sourceUuid, destUuid)
            collided = true
          }
        } else {
          const { findCodexRolloutPath, effectiveCodexHome } = await import('../adapters/codex.js')
          const existing = await findCodexRolloutPath(configDir, sourceUuid)
          if (existing) {
            destUuid = crypto.randomUUID()
            content = raw.replaceAll(sourceUuid, destUuid)
            collided = true
          }
          const codexHome = effectiveCodexHome(configDir)
          const now = new Date()
          const yyyy = String(now.getUTCFullYear())
          const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
          const dd = String(now.getUTCDate()).padStart(2, '0')
          const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
          destPath = path.join(codexHome, 'sessions', yyyy, mm, dd, `rollout-${ts}-${destUuid}.jsonl`)
        }

        await mkdir(path.dirname(destPath), { recursive: true })
        await writeFile(destPath, content, { mode: 0o600 })

        try {
          const session = await manager.adopt({
            projectId: project.id,
            agentType: project.agentType,
            workspace: project.path,
            configDir: configDir ?? undefined,
            model: project.defaultModel,
            effort: project.defaultEffort,
            harnessSessionId: destUuid,
          })
          return reply.code(201).send({
            ...session,
            importedFromUuid: sourceUuid,
            regeneratedUuid: collided,
            transcriptPath: destPath,
          })
        } catch (err: unknown) {
          return reply.code(500).send({ error: `bundle written to ${destPath} but adopt failed: ${(err as Error).message}` })
        }
      }

      // ----- Branch B: .tar.gz (codex TUI SQLite bundle) -----
      if (project.agentType !== 'codex') {
        return reply.code(409).send({ error: 'tar.gz bundle is codex TUI only; select a codex project' })
      }
      const stage = path.join('/tmp', `orchestron-import-${crypto.randomBytes(6).toString('hex')}`)
      await mkdir(stage, { recursive: true, mode: 0o700 })
      try {
        const tarInput = path.join(stage, 'bundle.tar.gz')
        await writeFile(tarInput, fileBuf, { mode: 0o600 })
        const { spawnSync } = await import('node:child_process')
        const untar = spawnSync('tar', ['-xzf', tarInput, '-C', stage], { encoding: 'utf8' })
        if (untar.status !== 0) {
          return reply.code(400).send({ error: `tar extract failed: ${untar.stderr ?? ''}` })
        }
        let meta: Record<string, unknown>
        try {
          meta = JSON.parse(await readFile(path.join(stage, 'metadata.json'), 'utf8')) as Record<string, unknown>
        } catch (err) {
          return reply.code(400).send({ error: `bundle missing/invalid metadata.json: ${(err as Error).message}` })
        }
        if (meta.kind !== 'orchestron-session-bundle' || meta.transcriptFormat !== 'codex-tui-sqlite') {
          return reply.code(400).send({ error: 'not a codex TUI bundle (metadata.kind / transcriptFormat mismatch)' })
        }
        const sourceUuid = String(meta.sourceUuid ?? '')
        if (!sourceUuid) return reply.code(400).send({ error: 'metadata missing sourceUuid' })

        let dumpRaw: string
        try {
          dumpRaw = await readFile(path.join(stage, 'dump.jsonl'), 'utf8')
        } catch (err) {
          return reply.code(400).send({ error: `bundle missing dump.jsonl: ${(err as Error).message}` })
        }

        const { effectiveCodexHome } = await import('../adapters/codex.js')
        const codexHome = effectiveCodexHome(configDir)
        const dbPath = path.join(codexHome, 'thread_history_1.sqlite')
        if (!existsSync(dbPath)) {
          return reply.code(409).send({ error: `destination codex SQLite not found at ${dbPath} — run codex CLI once so it initializes the DB, then retry` })
        }

        let destUuid = sourceUuid
        let payload = dumpRaw
        let collided = false
        try {
          const dbRO = new Database(dbPath, { readonly: true })
          const row = dbRO.prepare('SELECT 1 FROM thread_items WHERE thread_id = ? LIMIT 1').get(sourceUuid) as { '1': number } | undefined
          dbRO.close()
          if (row) {
            destUuid = crypto.randomUUID()
            payload = dumpRaw.replaceAll(sourceUuid, destUuid)
            collided = true
          }
        } catch (err) {
          return reply.code(500).send({ error: `collision check failed: ${(err as Error).message}` })
        }

        // Whitelist of accepted table kinds — bundle-controlled but we
        // never let the string reach SQL directly; only pick columns from
        // the row object as parameter names.
        const kindToTable: Record<string, string> = {
          thread_turn: 'thread_turns',
          thread_item: 'thread_items',
          projection_state: 'thread_history_projection_state',
        }
        try {
          const db = new Database(dbPath)
          const preparedByKey = new Map<string, Database.Statement>()
          const tx = db.transaction((lines: string[]) => {
            for (const line of lines) {
              if (!line.trim()) continue
              const entry = JSON.parse(line) as { kind: string; data: Record<string, unknown> }
              const table = kindToTable[entry.kind]
              if (!table) continue
              const cols = Object.keys(entry.data)
              if (cols.length === 0) continue
              const key = `${table}:${cols.join(',')}`
              let stmt = preparedByKey.get(key)
              if (!stmt) {
                stmt = db.prepare(
                  `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')})`,
                )
                preparedByKey.set(key, stmt)
              }
              stmt.run(entry.data)
            }
          })
          tx(payload.split(/\r?\n/))
          db.close()
        } catch (err) {
          return reply.code(500).send({ error: `SQLite insert failed: ${(err as Error).message}` })
        }

        try {
          const session = await manager.adopt({
            projectId: project.id,
            agentType: 'codex',
            workspace: project.path,
            configDir: configDir ?? undefined,
            model: project.defaultModel,
            effort: project.defaultEffort,
            harnessSessionId: destUuid,
          })
          return reply.code(201).send({
            ...session,
            importedFromUuid: sourceUuid,
            regeneratedUuid: collided,
            transcriptPath: dbPath,
          })
        } catch (err) {
          return reply.code(500).send({ error: `bundle imported to SQLite but adopt failed: ${(err as Error).message}` })
        }
      } finally {
        await rm(stage, { recursive: true, force: true }).catch(() => {})
      }
    })
  })
}
