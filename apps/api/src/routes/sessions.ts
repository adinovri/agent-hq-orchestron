import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { z } from 'zod'
import { SpawnSessionBodySchema } from '@agent-hq-orchestron/shared'
import { SessionManager } from '../domain/session-manager.js'
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
    app.post('/api/sessions', async (req, reply) => {
      const body = SpawnSessionBodySchema.safeParse(req.body)
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

      if (!initialPrompt) return reply.code(422).send({ error: 'prompt or template required' })

      const configDir = project.agentConfig?.env?.['CLAUDE_CONFIG_DIR']

      const session = await manager.spawn({
        projectId,
        agentType: body.data.agentType ?? project.agentType,
        initialPrompt,
        parentSessionId,
        workspace: project.path,
        detached,
        configDir,
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
