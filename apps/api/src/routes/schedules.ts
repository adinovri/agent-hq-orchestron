import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { z } from 'zod'
import YAML from 'yaml'
import { CronExpressionParser } from 'cron-parser'
import {
  applyHeadlessSwitch,
  headlessCoercion,
  DEFAULT_ENABLE_HEADLESS_MODE,
  HEADLESS_COERCED_REASON,
  type EffortLevel,
} from '@agent-hq-orchestron/shared'
import { Scheduler, ScheduleNotFoundError, type ScheduleEntry } from '../domain/scheduler.js'

// Reject cron expressions that don't parse. Pass-2 finding #6: without
// this, POST /api/schedules with a newline-containing cron passes
// (`min(1)` doesn't care about newlines), the Scheduler tries to fire
// it, cron-parser throws, and the raw multi-line value gets echoed
// through `console.warn` — a log-injection primitive.
function isValidCron(expr: string): boolean {
  try { CronExpressionParser.parse(expr); return true } catch { return false }
}

/**
 * The three per-schedule spawn overrides, in the shape a request body carries
 * them.
 *
 * Every field is three-valued rather than two: present with a value pins it,
 * *absent* leaves whatever is stored alone, and the empty string (or `null`
 * for the boolean, which has no empty string) clears the override so the
 * schedule goes back to following its project. Without that third state an
 * edit dialog could set an override but never take one back off — an absent
 * key and a cleared key would look identical on the wire.
 *
 * `clearableToUndefined` folds the clear forms to `undefined`; storage writes
 * JSON, and `JSON.stringify` drops an `undefined` value, so "cleared" lands on
 * disk as a genuinely absent field. The web dialog builds the same spellings —
 * it cannot import this helper, because a runtime import from `shared` drags
 * that package's config module (and `node:fs`) into the client bundle.
 */
const ScheduleOverridesShape = {
  model: z.union([z.string(), z.literal('')]).optional(),
  effort: z.union([z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']), z.literal('')]).optional(),
  useTmux: z.union([z.boolean(), z.null()]).optional(),
}

const ScheduleOverridesSchema = z.object(ScheduleOverridesShape)

/** The same three fields as they appear in an exported YAML document: no
 *  "clear" spellings there, because a document says what a schedule *is*
 *  rather than patching one. All optional — a file written before these
 *  fields existed imports unchanged, every schedule in it simply following
 *  its project. */
const YamlOverridesSchema = z.object({
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional(),
  useTmux: z.boolean().optional(),
})

/** `''` / `null` → `undefined`. Leaves a real value, `false` included. */
function clearableToUndefined<T>(value: T | '' | null | undefined): T | undefined {
  if (value === '' || value === null || value === undefined) return undefined
  return value
}

const CreateScheduleSchema = z.object({
  cron: z.string().min(1).refine(isValidCron, { message: 'invalid cron expression' }),
  projectId: z.string().min(1),
  template: z.string().optional(),
  prompt: z.string().optional(),
  vars: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
}).extend(ScheduleOverridesShape)

/** PATCH was previously handed `req.body` straight through to
 *  `scheduler.update()`, which spreads it over the stored record — any key at
 *  all landed in the JSON file. Validating here whitelists the editable
 *  fields; zod drops the absent ones, which is exactly patch semantics
 *  (absent = leave alone) once the "clear" spellings are handled separately. */
const PatchScheduleSchema = z.object({
  cron: z.string().min(1).refine(isValidCron, { message: 'invalid cron expression' }).optional(),
  projectId: z.string().min(1).optional(),
  template: z.string().optional(),
  prompt: z.string().optional(),
  vars: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
}).extend(ScheduleOverridesShape)

/** The stored shape of the three overrides, plus whether the global headless
 *  switch had to rewrite one on the way in. */
interface ResolvedOverrides {
  model: string | undefined
  effort: EffortLevel | undefined
  useTmux: boolean | undefined
  coerced: boolean
}

/**
 * Normalise the override triple out of a request body.
 *
 * The headless kill switch is applied the same way the session routes apply
 * it: only an *explicit* `useTmux: false` can be coerced, so a body that says
 * nothing about the mode is never quietly pinned to tmux. A schedule that
 * leaves the mode unset keeps following its project, and the coercion that
 * matters for it happens later at `POST /api/sessions` when the schedule
 * actually fires — this pass is the earlier of the two, not the only one.
 */
function resolveOverrides(
  input: z.infer<typeof ScheduleOverridesSchema>,
  headlessEnabled: boolean,
): ResolvedOverrides {
  const useTmux = clearableToUndefined(input.useTmux)
  if (useTmux === undefined) {
    return {
      model: clearableToUndefined(input.model),
      effort: clearableToUndefined(input.effort),
      useTmux: undefined,
      coerced: false,
    }
  }
  const applied = applyHeadlessSwitch(useTmux, headlessEnabled)
  return {
    model: clearableToUndefined(input.model),
    effort: clearableToUndefined(input.effort),
    useTmux: applied.useTmux,
    coerced: applied.coerced,
  }
}

export function schedulesPlugin(
  scheduler: Scheduler,
  serverConfig: { enableHeadlessMode?: boolean } = {},
) {
  const headlessEnabled = serverConfig.enableHeadlessMode ?? DEFAULT_ENABLE_HEADLESS_MODE
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

      const overrides = resolveOverrides(body.data, headlessEnabled)
      if (overrides.coerced) {
        req.log.info(
          { projectId: body.data.projectId, requestedUseTmux: false, effectiveUseTmux: true },
          `coerced useTmux=false to true (${HEADLESS_COERCED_REASON})`,
        )
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
        model: overrides.model,
        effort: overrides.effort,
        useTmux: overrides.useTmux,
      })

      // Rides along only when something was actually coerced, so a client can
      // treat its presence as "raise the notice" — same contract as the
      // session routes.
      const coerced = headlessCoercion(overrides.coerced)
      return reply.code(201).send(coerced ? { ...entry, coerced } : entry)
    })

    app.patch('/api/schedules/:id', async (req, reply) => {
      const { id } = req.params as { id: string }
      const body = PatchScheduleSchema.safeParse(req.body ?? {})
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

      // Copy across only the keys the caller actually sent. `undefined` is a
      // meaningful assignment for the three overrides — writeJson serialises
      // through JSON.stringify, which drops an undefined value, so the field
      // comes back off the record entirely and the schedule resumes following
      // its project.
      const patch: Partial<ScheduleEntry> = {}
      const data = body.data
      if (data.cron !== undefined) patch.cron = data.cron
      if (data.projectId !== undefined) patch.projectId = data.projectId
      if (data.template !== undefined) patch.template = data.template
      if (data.prompt !== undefined) patch.prompt = data.prompt
      if (data.vars !== undefined) patch.vars = data.vars
      if (data.enabled !== undefined) patch.enabled = data.enabled

      let patchCoerced = false
      if ('model' in data) patch.model = clearableToUndefined(data.model)
      if ('effort' in data) patch.effort = clearableToUndefined(data.effort)
      if ('useTmux' in data) {
        const resolved = resolveOverrides({ useTmux: data.useTmux }, headlessEnabled)
        patch.useTmux = resolved.useTmux
        patchCoerced = resolved.coerced
        if (patchCoerced) {
          req.log.info(
            { scheduleId: id, requestedUseTmux: false, effectiveUseTmux: true },
            `coerced useTmux=false to true (${HEADLESS_COERCED_REASON})`,
          )
        }
      }

      try {
        const updated = await scheduler.update(id, patch)
        const coerced = headlessCoercion(patchCoerced)
        return coerced ? { ...updated, coerced } : updated
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
        // Omitted from the document when unset — YAML.stringify drops an
        // undefined value — so a schedule that pins nothing exports exactly
        // as it did before these fields existed.
        model: e.model,
        effort: e.effort,
        useTmux: e.useTmux,
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
      // How many entries asked for headless and got tmux instead. Reported so
      // an operator restoring a backup on a switched-off server can see that
      // the document and the result differ.
      let coerced = 0
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
          const parsedOverrides = YamlOverridesSchema.safeParse({
            model: raw.model,
            effort: raw.effort,
            useTmux: raw.useTmux,
          })
          if (!parsedOverrides.success) {
            errors.push({ id: raw.id, error: `invalid model/effort/useTmux: ${parsedOverrides.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}` })
            continue
          }
          // A document can carry headless schedules from a host where the
          // switch was on. Run them through the same mask as a create, so an
          // import cannot reintroduce a mode this server has turned off.
          const overrides = resolveOverrides(parsedOverrides.data, headlessEnabled)
          if (overrides.coerced) coerced += 1

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
                model: overrides.model,
                effort: overrides.effort,
                useTmux: overrides.useTmux,
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
                  model: overrides.model,
                  effort: overrides.effort,
                  useTmux: overrides.useTmux,
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
              model: overrides.model,
              effort: overrides.effort,
              useTmux: overrides.useTmux,
            })
            created += 1
          }
        } catch (err) {
          errors.push({ id: raw.id, error: (err as Error).message })
          skipped += 1
        }
      }

      return { mode, total: items.length, created, updated, skipped, coerced, errors }
    })

    app.post('/api/schedules/:id/run', async (req, reply) => {
      const { id } = req.params as { id: string }
      try {
        const sessionUuid = await scheduler.run(id)
        // `sessionUuid` rides along only when the spawn response actually
        // carried one, same additive shape as `coerced` on POST /api/sessions.
        // Its presence is the client's signal that there is somewhere to
        // navigate; a bare `{ ok: true }` still means the run fired, so an
        // older client — or one talking to a spawn path that returns no id —
        // keeps working unchanged.
        return sessionUuid ? { ok: true, sessionUuid } : { ok: true }
      } catch (err) {
        if (err instanceof ScheduleNotFoundError) return reply.code(404).send({ error: err.message })
        throw err
      }
    })
  })
}
