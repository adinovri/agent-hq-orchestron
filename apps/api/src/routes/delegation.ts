import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { DelegationTracker } from '../domain/delegation-tracker.js'
import { SessionManager } from '../domain/session-manager.js'

export function delegationPlugin(tracker: DelegationTracker, manager: SessionManager) {
  return fp(async (app: FastifyInstance) => {
    app.get('/api/delegation/:rootUuid', async (req, reply) => {
      const { rootUuid } = req.params as { rootUuid: string }

      const sessions = await manager.list()
      const sessionMap = new Map(sessions.map(s => [s.id, s]))

      const root = sessionMap.get(rootUuid)
      if (!root) return reply.code(404).send({ error: `Session not found: ${rootUuid}` })

      const descendantUuids = await tracker.getDescendants(rootUuid)
      const allUuids = [rootUuid, ...descendantUuids]

      const nodes = allUuids.flatMap(uuid => {
        const s = sessionMap.get(uuid)
        return s ? [s] : []
      })

      // Build edges for React Flow
      const edges: { id: string; source: string; target: string; label?: string }[] = []
      for (const uuid of allUuids) {
        const children = await tracker.getChildren(uuid)
        for (const child of children) {
          edges.push({
            id: `${uuid}-${child.childUuid}`,
            source: uuid,
            target: child.childUuid,
            label: child.spawnPrompt?.slice(0, 60),
          })
        }
      }

      return { nodes, edges }
    })
  })
}
