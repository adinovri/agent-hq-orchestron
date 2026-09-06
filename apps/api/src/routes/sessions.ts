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
      }

      return { entries: parsed.entries, size: raw.length, contextStats: parsed.contextStats }
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

    // Codex-only: scrape /status modal for context% + rate-limit numbers.
    // See docs/USAGE.md §3 and memory reference_orchestron_codex_adapter
    // for why this is on-demand rather than persistent.
    app.post('/api/sessions/:uuid/refresh-metrics', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }
      const sessions = await manager.list()
      const existing = sessions.find(s => s.id === uuid)
      if (!existing) return reply.code(404).send({ error: `Session not found: ${uuid}` })
      // Sessions without a live tmux pane can't be scraped.
      const BLOCKED: string[] = ['sleeping', 'succeeded', 'killed', 'failed', 'spawning']
      if (BLOCKED.includes(existing.status)) {
        return reply.code(409).send({ error: `Cannot refresh metrics in ${existing.status} state — no live TUI to scrape` })
      }
      try {
        return await manager.refreshCodexMetrics(uuid)
      } catch (err: unknown) {
        const msg = (err as Error).message ?? String(err)
        if (msg.includes('codex-only')) return reply.code(400).send({ error: msg })
        if (msg.includes('timeout')) return reply.code(504).send({ error: msg })
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
  })
}
