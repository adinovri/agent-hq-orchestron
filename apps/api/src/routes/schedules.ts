import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { z } from 'zod'
import { Scheduler, ScheduleNotFoundError } from '../domain/scheduler.js'

const CreateScheduleSchema = z.object({
  cron: z.string().min(1),
  projectId: z.string().min(1),
  template: z.string().optional(),
  prompt: z.string().optional(),
  vars: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
})

type CreateScheduleInput = z.infer<typeof CreateScheduleSchema>

export function schedulesPlugin(scheduler: Scheduler) {
  return fp(async (app: FastifyInstance) => {
    app.get('/api/schedules', async () => {
      const entries = await scheduler.list()
      return { schedules: entries }
    })

    app.get('/api/schedules/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      try {
        return await scheduler.get(id)
      } catch (err) {
        if (err instanceof ScheduleNotFoundError) return reply.code(404).send({ error: err.message })
        throw err
      }
    })

    app.post('/api/schedules', async (req, reply) => {
      const body = CreateScheduleSchema.safeParse(req.body)
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

      if (!body.data.template && !body.data.prompt) {
        return reply.code(422).send({ error: 'prompt or template required' })
      }

      const entry = await scheduler.create({
        id: crypto.randomUUID(),
        cron: body.data.cron,
        projectId: body.data.projectId,
        template: body.data.template,
        prompt: body.data.prompt,
        vars: body.data.vars,
        enabled: body.data.enabled,
        createdAt: new Date().toISOString(),
      })

      return reply.code(201).send(entry)
    })

    app.patch('/api/schedules/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      try {
        const updated = await scheduler.update(id, req.body as Partial<CreateScheduleInput>)
        return updated
      } catch (err) {
        if (err instanceof ScheduleNotFoundError) return reply.code(404).send({ error: err.message })
        throw err
      }
    })

    app.delete('/api/schedules/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      try {
        await scheduler.delete(id)
        return reply.code(204).send()
      } catch (err) {
        if (err instanceof ScheduleNotFoundError) return reply.code(404).send({ error: err.message })
        throw err
      }
    })

    app.post('/api/schedules/:id/run', async (req, reply) => {
      const { id } = req.params as { id: string }
      try {
        await scheduler.run(id)
        return { ok: true }
      } catch (err) {
        if (err instanceof ScheduleNotFoundError) return reply.code(404).send({ error: err.message })
        throw err
      }
    })
  })
}
