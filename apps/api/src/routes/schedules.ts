import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { z } from 'zod'
import YAML from 'yaml'
import { CronExpressionParser } from 'cron-parser'
import { Scheduler, ScheduleNotFoundError, type ScheduleEntry } from '../domain/scheduler.js'

// Reject cron expressions that don't parse. Pass-2 finding #6: without
// this, POST /api/schedules with a newline-containing cron passes
// (`min(1)` doesn't care about newlines), the Scheduler tries to fire
// it, cron-parser throws, and the raw multi-line value gets echoed
// through `console.warn` — a log-injection primitive.
function isValidCron(expr: string): boolean {
  try { CronExpressionParser.parse(expr); return true } catch { return false }
}

const CreateScheduleSchema = z.object({
  cron: z.string().min(1).refine(isValidCron, { message: 'invalid cron expression' }),
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

    // Export all schedules as YAML — for git-versioning / backup / migration.
    // Strips runtime state (lastRunAt, nextRunAt) — schedule config only.
    app.get('/api/schedules/export', async (_req, reply) => {
      const entries = await scheduler.list()
      const cleaned = entries.map((e) => ({
        id: e.id,
        cron: e.cron,
        projectId: e.projectId,
        template: e.template,
        prompt: e.prompt,
        vars: e.vars,
        enabled: e.enabled,
        createdAt: e.createdAt,
      }))
      const yaml = YAML.stringify({ schedules: cleaned })
      return reply
        .header('Content-Type', 'application/x-yaml; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="orchestron-schedules.yml"')
        .send(yaml)
    })

    // Import schedules from YAML. Accepts either `application/x-yaml` body
    // or `application/json` `{ yaml: "..." }`. Modes:
    //   ?mode=merge (default): add new (skip existing IDs), update if same ID
    //   ?mode=replace: delete all existing schedules first, then import
    app.post('/api/schedules/import', async (req, reply) => {
      const mode = ((req.query as Record<string, string>).mode ?? 'merge') as 'merge' | 'replace'
      if (mode !== 'merge' && mode !== 'replace') {
        return reply.code(400).send({ error: `mode must be merge|replace, got ${mode}` })
      }

      let yamlText = ''
      const ct = req.headers['content-type'] ?? ''
      if (ct.includes('yaml') || ct.includes('text/plain')) {
        yamlText = typeof req.body === 'string' ? req.body : String(req.body)
      } else if (ct.includes('json')) {
        const body = req.body as { yaml?: string }
        if (typeof body?.yaml !== 'string') {
          return reply.code(400).send({ error: 'body must have { yaml: "..." } for application/json' })
        }
        yamlText = body.yaml
      } else {
        return reply.code(415).send({ error: 'send application/x-yaml or application/json with {yaml}' })
      }

      let parsed: unknown
      try { parsed = YAML.parse(yamlText) } catch (err) {
        return reply.code(400).send({ error: `YAML parse: ${(err as Error).message}` })
      }
      const doc = parsed as { schedules?: ScheduleEntry[] } | null
      const items = Array.isArray(doc?.schedules) ? doc!.schedules : []
      if (items.length === 0) {
        return reply.code(400).send({ error: 'no schedules found in YAML (expected top-level `schedules:` list)' })
      }

      if (mode === 'replace') {
        const existing = await scheduler.list()
        for (const s of existing) {
          try { await scheduler.delete(s.id) } catch { /* ignore */ }
        }
      }

      let created = 0
      let updated = 0
      let skipped = 0
      const errors: Array<{ id?: string; error: string }> = []

      // Schedule ids flow into Scheduler.schedulePath() which does
      // path.join(dir, `${id}.json`). Anything with slashes, dots, or
      // control chars can escape the schedules dir — validate strictly
      // here (import is the only path where the id is externally supplied;
      // scheduler.create() also generates its own UUID for missing ids).
      const SCHEDULE_ID_RE = /^[\w-]{1,64}$/
      for (const raw of items) {
        try {
          if (!raw.cron || !raw.projectId) {
            errors.push({ id: raw.id, error: 'missing cron or projectId' })
            continue
          }
          if (!raw.template && !raw.prompt) {
            errors.push({ id: raw.id, error: 'missing prompt or template' })
            continue
          }
          if (raw.id !== undefined && !SCHEDULE_ID_RE.test(raw.id)) {
            errors.push({ id: raw.id, error: `invalid id ${JSON.stringify(raw.id)} — must match ${SCHEDULE_ID_RE.source}` })
            continue
          }
          if (!isValidCron(raw.cron)) {
            errors.push({ id: raw.id, error: `invalid cron expression ${JSON.stringify(raw.cron)}` })
            continue
          }

          if (raw.id) {
            // Try update if exists; else create with given ID
            try {
              await scheduler.get(raw.id)
              await scheduler.update(raw.id, {
                cron: raw.cron,
                projectId: raw.projectId,
                template: raw.template,
                prompt: raw.prompt,
                vars: raw.vars,
                enabled: raw.enabled ?? true,
              })
              updated += 1
            } catch (err) {
              if (err instanceof ScheduleNotFoundError) {
                await scheduler.create({
                  id: raw.id,
                  cron: raw.cron,
                  projectId: raw.projectId,
                  template: raw.template,
                  prompt: raw.prompt,
                  vars: raw.vars,
                  enabled: raw.enabled ?? true,
                  createdAt: raw.createdAt ?? new Date().toISOString(),
                })
                created += 1
              } else {
                throw err
              }
            }
          } else {
            await scheduler.create({
              id: crypto.randomUUID(),
              cron: raw.cron,
              projectId: raw.projectId,
              template: raw.template,
              prompt: raw.prompt,
              vars: raw.vars,
              enabled: raw.enabled ?? true,
              createdAt: new Date().toISOString(),
            })
            created += 1
          }
        } catch (err) {
          errors.push({ id: raw.id, error: (err as Error).message })
          skipped += 1
        }
      }

      return { mode, total: items.length, created, updated, skipped, errors }
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
