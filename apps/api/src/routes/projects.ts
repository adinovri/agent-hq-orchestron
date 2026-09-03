import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { z } from 'zod'
import { RegisterProjectBodySchema } from '@agent-hq-orchestron/shared'
import { ProjectRegistry, ProjectNotFoundError, ProjectPathError } from '../domain/project-registry.js'

const PatchProjectBodySchema = RegisterProjectBodySchema.partial()

export function projectsPlugin(registry: ProjectRegistry) {
  return fp(async (app: FastifyInstance) => {
    app.post('/api/projects', async (req, reply) => {
      const body = RegisterProjectBodySchema.safeParse(req.body)
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })
      try {
        const project = await registry.create(body.data)
        return reply.code(201).send(project)
      } catch (err) {
        if (err instanceof ProjectPathError) return reply.code(422).send({ error: err.message })
        throw err
      }
    })

    app.get('/api/projects', async (req) => {
      const query = req.query as Record<string, string>
      const group = query['group']
      const tag = query['tag']
      const projects = await registry.filter({
        group,
        tags: tag ? [tag] : undefined,
      })
      return { projects }
    })

    app.get('/api/projects/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      try {
        const project = await registry.get(id)
        return project
      } catch (err) {
        if (err instanceof ProjectNotFoundError) return reply.code(404).send({ error: err.message })
        throw err
      }
    })

    app.patch('/api/projects/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      const body = PatchProjectBodySchema.safeParse(req.body)
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })
      try {
        const updated = await registry.update(id, body.data)
        return updated
      } catch (err) {
        if (err instanceof ProjectNotFoundError) return reply.code(404).send({ error: err.message })
        throw err
      }
    })

    app.delete('/api/projects/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      try {
        await registry.delete(id)
        return reply.code(204).send()
      } catch (err) {
        if (err instanceof ProjectNotFoundError) return reply.code(404).send({ error: err.message })
        throw err
      }
    })
  })
}
