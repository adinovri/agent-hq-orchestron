import crypto from 'node:crypto'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import type { Config } from '@agent-hq-orchestron/shared'

const AUTH_WHITELIST = new Set(['/api/health', '/api/readiness', '/api/reset'])

function timingSafeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')
  if (aBuf.length !== bBuf.length) {
    // Still run comparison on equal-length buffers to avoid timing leak on length
    crypto.timingSafeEqual(aBuf, aBuf)
    return false
  }
  return crypto.timingSafeEqual(aBuf, bBuf)
}

async function authPlugin(fastify: FastifyInstance, opts: { config: Config }): Promise<void> {
  const { remoteToken } = opts.config
  if (!remoteToken) return

  // HTTP: global preHandler
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (AUTH_WHITELIST.has(request.url.split('?')[0])) return

    const authHeader = request.headers.authorization ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

    if (!token || !timingSafeCompare(token, remoteToken)) {
      await reply.code(401).send({ error: 'Unauthorized' })
    }
  })

  // WS/SSE: preValidation reads ?token= from query
  fastify.addHook('preValidation', async (request: FastifyRequest, reply: FastifyReply) => {
    const upgrade = request.headers.upgrade?.toLowerCase()
    const accept = request.headers.accept ?? ''
    if (upgrade !== 'websocket' && !accept.includes('text/event-stream')) return
    if (AUTH_WHITELIST.has(request.url.split('?')[0])) return

    const queryToken = (request.query as Record<string, string>).token ?? ''
    if (!queryToken || !timingSafeCompare(queryToken, remoteToken)) {
      await reply.code(401).send({ error: 'Unauthorized' })
    }
  })
}

export default fp(authPlugin, { name: 'auth', fastify: '5.x' })
