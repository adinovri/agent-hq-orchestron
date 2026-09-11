import crypto from 'node:crypto'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import fp from 'fastify-plugin'
import type { Config } from '@agent-hq-orchestron/shared'

/**
 * Paths the bearer check never sees.
 *
 * `/pair` is here for a reason that is not obvious: `/api/reset` clears
 * the client's token and then sends the browser to `/pair`, which — the
 * page being served by the API — resolves against the *API* origin. The
 * API has no `/pair`, and this preHandler runs before Fastify's
 * not-found handling, so the browser landed on `{"error":"Unauthorized"}`
 * having just discarded the token it would have needed (B6-F5). Letting
 * it through means the 404 handler answers instead, with a page that
 * says where pairing actually lives.
 */
export const AUTH_WHITELIST = new Set([
  '/api/health',
  '/api/readiness',
  '/api/reset',
  '/api/version',
  '/pair',
])

/** Short-lived one-use tickets for SSE/WS query-string auth. The
 *  underlying `?token=<remoteToken>` mode is still accepted for
 *  backward-compat, but a fresh client should POST /api/sse-ticket
 *  (Bearer-authenticated), then open the SSE URL with `?ticket=<t>` —
 *  that way the long-lived remoteToken never lands in a URL that
 *  reverse proxies, browser history, or Referer headers can leak.
 *  In-memory store; single-node deploy so no cross-process sync needed. */
const SSE_TICKET_TTL_MS = 60 * 1000
const sseTickets = new Map<string, number>()   // ticket → expiresAtMs

function issueSseTicket(): { ticket: string; expiresAt: number } {
  const now = Date.now()
  // Sweep expired tickets on each mint — cheap, keeps map bounded.
  for (const [k, exp] of sseTickets) if (exp <= now) sseTickets.delete(k)
  const ticket = crypto.randomBytes(24).toString('base64url')
  const expiresAt = now + SSE_TICKET_TTL_MS
  sseTickets.set(ticket, expiresAt)
  return { ticket, expiresAt }
}

function consumeSseTicket(ticket: string): boolean {
  const exp = sseTickets.get(ticket)
  if (!exp) return false
  sseTickets.delete(ticket)
  return exp > Date.now()
}

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

  // HTTP: global preHandler — skip for SSE/WS (handled by preValidation via ?token=)
  fastify.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (AUTH_WHITELIST.has(request.url.split('?')[0])) return

    // Skip if SSE/WS — preValidation already authenticated via query param
    const upgrade = request.headers.upgrade?.toLowerCase()
    const accept = request.headers.accept ?? ''
    if (upgrade === 'websocket' || accept.includes('text/event-stream')) return

    const authHeader = request.headers.authorization ?? ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

    if (!token || !timingSafeCompare(token, remoteToken)) {
      await reply.code(401).send({ error: 'Unauthorized' })
    }
  })

  // WS/SSE: preValidation accepts ?ticket= (one-shot, short-TTL) OR
  // ?token= (legacy long-lived remoteToken). Prefer ticket for clients
  // that can POST /api/sse-ticket first — keeps the bearer out of URLs.
  fastify.addHook('preValidation', async (request: FastifyRequest, reply: FastifyReply) => {
    const upgrade = request.headers.upgrade?.toLowerCase()
    const accept = request.headers.accept ?? ''
    if (upgrade !== 'websocket' && !accept.includes('text/event-stream')) return
    if (AUTH_WHITELIST.has(request.url.split('?')[0])) return

    const q = request.query as Record<string, string>
    if (q.ticket && consumeSseTicket(q.ticket)) return
    const queryToken = q.token ?? ''
    if (!queryToken || !timingSafeCompare(queryToken, remoteToken)) {
      await reply.code(401).send({ error: 'Unauthorized' })
    }
  })

  // Mint a short-lived one-shot SSE ticket. Requires the normal Bearer
  // auth (preHandler above already ran and let this through). Client
  // usage: POST /api/sse-ticket → { ticket, expiresAt } → open EventSource
  // at /api/stream?ticket=<t> instead of embedding remoteToken.
  fastify.post('/api/sse-ticket', async () => {
    return issueSseTicket()
  })
}

export default fp(authPlugin, { name: 'auth', fastify: '5.x' })
