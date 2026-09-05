import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import multipart from '@fastify/multipart'
import { z } from 'zod'
import path from 'node:path'
import { mkdir, writeFile, chmod } from 'node:fs/promises'
import crypto from 'node:crypto'
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

      const configDir = project.agentConfig?.env?.['CLAUDE_CONFIG_DIR']

      const session = await manager.spawn({
        projectId,
        agentType: body.data.agentType ?? project.agentType,
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

      const { readFile } = await import('node:fs/promises')
      let raw = ''
      try {
        raw = await readFile(session.jsonlPath, 'utf8')
      } catch {
        return { entries: [], size: 0 }
      }

      const entries: Array<{
        seq: number
        timestamp: string
        kind: 'user' | 'assistant' | 'tool_use' | 'tool_result'
        toolName?: string
        content: string
      }> = []
      let seq = 0
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        let ev: {
          type?: string
          timestamp?: string
          message?: { content?: string | Array<{ type?: string; text?: string; name?: string; input?: unknown; content?: string | Array<{ text?: string }> }> }
        }
        try { ev = JSON.parse(line) } catch { continue }
        const ts = ev.timestamp ?? ''
        const t = ev.type
        const content = ev.message?.content
        if (t === 'user' && typeof content === 'string') {
          entries.push({ seq: seq++, timestamp: ts, kind: 'user', content })
        } else if (t === 'assistant' && Array.isArray(content)) {
          for (const b of content) {
            if (b.type === 'text' && b.text) {
              entries.push({ seq: seq++, timestamp: ts, kind: 'assistant', content: b.text })
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

      return { entries, size: raw.length }
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
    app.post('/api/sessions/:uuid/reopen', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }
      const sessions = await manager.list()
      const existing = sessions.find(s => s.id === uuid)
      if (!existing) return reply.code(404).send({ error: `Session not found: ${uuid}` })
      let project
      try { project = await registry.get(existing.projectId) } catch {
        return reply.code(404).send({ error: `Project not found: ${existing.projectId}` })
      }
      const configDir = project.agentConfig?.env?.['CLAUDE_CONFIG_DIR']
      try {
        const updated = await manager.reopen(uuid, project.path, configDir, project.defaultModel, project.defaultEffort)
        return updated
      } catch (err: unknown) {
        const msg = (err as Error).message ?? ''
        if (msg.includes('Cannot reopen')) return reply.code(409).send({ error: msg })
        throw err
      }
    })

    // Clone/fork — new orchestron session, inherits the source's Claude
    // conversation via --resume. Optional { prompt } to seed the fork with
    // a new user turn (else just re-enters the shared context idle).
    app.post('/api/sessions/:uuid/clone', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }
      const body = z.object({ prompt: z.string().optional() }).safeParse(req.body ?? {})
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

      const sessions = await manager.list()
      const existing = sessions.find(s => s.id === uuid)
      if (!existing) return reply.code(404).send({ error: `Session not found: ${uuid}` })
      let project
      try { project = await registry.get(existing.projectId) } catch {
        return reply.code(404).send({ error: `Project not found: ${existing.projectId}` })
      }
      const configDir = project.agentConfig?.env?.['CLAUDE_CONFIG_DIR']

      try {
        const cloned = await manager.clone(uuid, {
          workspace: project.path,
          configDir,
        }, body.data.prompt, project.defaultModel, project.defaultEffort)
        return reply.code(201).send(cloned)
      } catch (err: unknown) {
        const msg = (err as Error).message ?? ''
        if (msg.includes('Session pool is full')) return reply.code(429).send({ error: msg })
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
