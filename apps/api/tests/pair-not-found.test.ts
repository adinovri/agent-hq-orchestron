import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import authPlugin, { AUTH_WHITELIST } from '../src/plugins/auth.js'
import type { Config } from '@agent-hq-orchestron/shared'

/**
 * B6-F5 — `/api/reset` finished with `window.location.href = '/pair'`,
 * resolved against the API origin. The API has no `/pair`, and the auth
 * preHandler runs before not-found handling, so the browser landed on
 * `{"error":"Unauthorized"}` having just cleared the token that would
 * have satisfied it.
 *
 * The reset page no longer redirects at all, and `/pair` on this origin
 * is whitelisted so the answer is a 404 signpost rather than a 401 dead
 * end for anyone who still reaches it (a bookmark, a cached copy of the
 * old page).
 */

/** The same handler shape server.ts registers — 404 plus an HTML body
 *  naming where pairing actually lives. */
function registerPairStub(app: FastifyInstance): void {
  app.get('/pair', async (_req, reply) => {
    reply.code(404).type('text/html')
    return '<h1>404 — pairing lives on the web UI</h1> orchestron qr'
  })
}

function buildApp(remoteToken?: string): FastifyInstance {
  const fastify = Fastify({ logger: false })
  const config = {
    bindHost: '127.0.0.1',
    port: 8080,
    dataDir: '/tmp/test',
    maxConcurrent: 4,
    remoteToken,
    adapters: { claude: true, codex: false, opencode: false },
    logLevel: 'error',
  } as Config

  fastify.register(authPlugin, { config })
  fastify.get('/api/reset', async (_req, reply) => {
    reply.type('text/html')
    return '<h1>Orchestron Reset</h1>'
  })
  registerPairStub(fastify)
  return fastify
}

let app: FastifyInstance
afterEach(async () => { await app?.close() })

describe('/pair on the API origin', () => {
  it('is in the auth whitelist', () => {
    expect(AUTH_WHITELIST.has('/pair')).toBe(true)
  })

  it('answers 404, not 401, with no token at all', async () => {
    app = buildApp('secret-token')
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/pair' })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('Unauthorized')
  })

  it('says where pairing actually is', async () => {
    app = buildApp('secret-token')
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/pair' })
    expect(res.body).toContain('orchestron qr')
  })

  it('answers 404 for a query string too — the whitelist strips it', async () => {
    app = buildApp('secret-token')
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/pair?token=whatever' })
    expect(res.statusCode).toBe(404)
  })

  it('/api/reset itself is still anonymous 200', async () => {
    app = buildApp('secret-token')
    await app.ready()
    const res = await app.inject({ method: 'GET', url: '/api/reset' })
    expect(res.statusCode).toBe(200)
  })

  it('the real server registers the route, not just this stub', () => {
    // The stub above pins the contract; this pins that server.ts still
    // has a route to satisfy it. Without the route, /pair on the API is
    // a 404 from Fastify's default handler with a JSON body and no
    // signpost — which is a quieter regression than the 401 was.
    const serverSrc = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/server.ts'),
      'utf8',
    )
    expect(serverSrc).toContain("fastify.get('/pair'")
    expect(serverSrc).toContain('reply.code(404)')
    // And the reset page must not redirect anywhere — that was the bug.
    expect(serverSrc).not.toContain("window.location.href = '/pair'")
  })

  it('the whitelist did not widen beyond /pair', async () => {
    // A whitelist entry is an authentication hole; pin the exact set so a
    // future addition has to be deliberate.
    expect([...AUTH_WHITELIST].sort()).toEqual(
      ['/api/health', '/api/readiness', '/api/reset', '/api/version', '/pair'].sort(),
    )
    app = buildApp('secret-token')
    app.get('/api/protected', async () => ({ secret: true }))
    await app.ready()
    expect((await app.inject({ method: 'GET', url: '/api/protected' })).statusCode).toBe(401)
  })
})
