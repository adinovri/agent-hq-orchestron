import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import authPlugin from '../src/plugins/auth.js'
import type { Config } from '@agent-hq-orchestron/shared'

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

  fastify.get('/api/health', async () => ({ ok: true }))
  fastify.get('/api/readiness', async () => ({ ready: true }))
  fastify.get('/api/protected', async () => ({ secret: true }))

  return fastify
}

describe('auth plugin', () => {
  let app: FastifyInstance

  afterEach(async () => {
    await app.close()
  })

  it('no remoteToken — all routes public', async () => {
    app = buildApp(undefined)
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/protected' })
    expect(res.statusCode).toBe(200)
  })

  it('correct Bearer token — passes', async () => {
    app = buildApp('secret-token')
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/protected',
      headers: { authorization: 'Bearer secret-token' },
    })
    expect(res.statusCode).toBe(200)
  })

  it('wrong token — 401', async () => {
    app = buildApp('secret-token')
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/protected',
      headers: { authorization: 'Bearer wrong-token' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('missing Authorization header — 401', async () => {
    app = buildApp('secret-token')
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/protected' })
    expect(res.statusCode).toBe(401)
  })

  it('whitelisted /api/health skips auth', async () => {
    app = buildApp('secret-token')
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
  })

  it('whitelisted /api/readiness skips auth', async () => {
    app = buildApp('secret-token')
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/readiness' })
    expect(res.statusCode).toBe(200)
  })
})
