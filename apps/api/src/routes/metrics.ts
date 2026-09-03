import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { MetricsCollector, type GroupBy } from '../domain/metrics-collector.js'
import type { AgentType } from '@agent-hq-orchestron/shared'

const VALID_GROUP_BY = new Set<GroupBy>(['project', 'adapter', 'model', 'day'])
const VALID_ADAPTERS = new Set<AgentType>(['claude', 'codex', 'opencode'])
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function metricsPlugin(collector: MetricsCollector) {
  return fp(async (app: FastifyInstance) => {
    app.get('/api/metrics', async (req, reply) => {
      const q = req.query as Record<string, string>

      const groupBy = (q['groupBy'] ?? 'day') as GroupBy
      if (!VALID_GROUP_BY.has(groupBy)) {
        return reply.code(400).send({ error: `Invalid groupBy: must be one of ${[...VALID_GROUP_BY].join(', ')}` })
      }

      const from = q['from']
      const to = q['to']

      if (from && !DATE_RE.test(from)) {
        return reply.code(400).send({ error: 'Invalid from date: expected YYYY-MM-DD' })
      }
      if (to && !DATE_RE.test(to)) {
        return reply.code(400).send({ error: 'Invalid to date: expected YYYY-MM-DD' })
      }
      if (from && to && from > to) {
        return reply.code(400).send({ error: '"from" must not be after "to"' })
      }

      const adapter = q['adapter'] as AgentType | undefined
      if (adapter && !VALID_ADAPTERS.has(adapter)) {
        return reply.code(400).send({ error: `Invalid adapter: must be one of ${[...VALID_ADAPTERS].join(', ')}` })
      }

      const result = await collector.query({
        groupBy,
        from,
        to,
        projectId: q['projectId'],
        adapter,
      })

      return result
    })
  })
}
