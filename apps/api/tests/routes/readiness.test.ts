import { describe, it, expect, afterEach } from 'vitest'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import authPlugin from '../../src/plugins/auth.js'
import { readinessPlugin, evaluateReadiness } from '../../src/routes/readiness.js'
import { AdapterRegistry } from '../../src/adapters/registry.js'
import type { AgentAdapter, Config } from '@agent-hq-orchestron/shared'

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    bindHost: '127.0.0.1',
    port: 8080,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-')),
    maxConcurrent: 4,
    adapters: { claude: true, codex: false, opencode: false },
    logLevel: 'error',
    idleTimeoutMs: 900_000,
    ...over,
  } as Config
}

function makeRegistry(names: string[] = ['claude']): AdapterRegistry {
  const registry = new AdapterRegistry()
  for (const n of names) registry.register(n, {} as AgentAdapter)
  return registry
}

function buildApp(config: Config, registry: AdapterRegistry): FastifyInstance {
  const app = Fastify({ logger: false })
  app.register(authPlugin, { config })
  app.register(readinessPlugin(config, registry))
  return app
}

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

describe('GET /api/readiness', () => {
  it('answers 200 with status/uptime/checks to an anonymous caller on a token-protected server', async () => {
    const config = makeConfig({ remoteToken: 'secret-token' })
    app = buildApp(config, makeRegistry())
    await app.ready()

    // No Authorization header at all — the point of the whitelist entry.
    const res = await app.inject({ method: 'GET', url: '/api/readiness' })
    expect(res.statusCode).toBe(200)

    const body = res.json()
    expect(body.status).toBe('ready')
    expect(typeof body.uptime).toBe('number')
    expect(body.uptime).toBeGreaterThanOrEqual(0)
    expect(body.checks).toEqual({ config: true, storage: true, adapters: true })
  })

  it('answers the same to a wrong bearer — the whitelist short-circuits before the token check', async () => {
    const config = makeConfig({ remoteToken: 'secret-token' })
    app = buildApp(config, makeRegistry())
    await app.ready()

    const res = await app.inject({
      method: 'GET',
      url: '/api/readiness',
      headers: { authorization: 'Bearer wrong-token' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('ready')
  })

  it('503s when the data dir is not writable — a probe that is always 200 is worthless', async () => {
    const config = makeConfig({ dataDir: path.join(os.tmpdir(), 'readiness-does-not-exist-' + Date.now()) })
    app = buildApp(config, makeRegistry())
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/readiness' })
    expect(res.statusCode).toBe(503)
    expect(res.json().status).toBe('not_ready')
    expect(res.json().checks.storage).toBe(false)
  })

  it('503s when no adapter is registered — the process is up but cannot spawn', async () => {
    const config = makeConfig()
    app = buildApp(config, makeRegistry([]))
    await app.ready()

    const res = await app.inject({ method: 'GET', url: '/api/readiness' })
    expect(res.statusCode).toBe(503)
    expect(res.json().checks).toMatchObject({ storage: true, adapters: false })
  })

  it('leaks no host detail — no dataDir path, no bindHost, no adapter names', async () => {
    const config = makeConfig({ remoteToken: 'secret-token' })
    app = buildApp(config, makeRegistry(['claude', 'codex']))
    await app.ready()

    const raw = (await app.inject({ method: 'GET', url: '/api/readiness' })).body
    expect(raw).not.toContain(config.dataDir)
    expect(raw).not.toContain(config.bindHost)
    expect(raw).not.toContain('codex')
  })

  it('evaluateReadiness reports a file masquerading as the data dir as not writable', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'readiness-')), 'not-a-dir')
    fs.writeFileSync(file, 'x')
    const body = evaluateReadiness(makeConfig({ dataDir: file }), makeRegistry())
    expect(body.status).toBe('not_ready')
    expect(body.checks.storage).toBe(false)
  })
})

describe('server boot wiring', () => {
  // NF13's root cause was not a broken route — it was no route, hidden by a
  // test fixture that registered its own. Pin the registration in server.ts
  // so deleting it fails here rather than three sweeps later.
  const serverSrc = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/server.ts'),
    'utf8',
  )

  it('server.ts registers the readiness plugin', () => {
    expect(serverSrc).toContain("import { readinessPlugin } from './routes/readiness.js'")
    expect(serverSrc).toContain('fastify.register(readinessPlugin(config, registry))')
  })

  it('no test fixture registers a /api/readiness stub any more', () => {
    const testsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.test.ts')) {
          // Strip comments first — this file discusses the stub in prose,
          // and a guard that cannot tell code from commentary is a guard
          // that will be deleted the first time it cries wolf.
          const src = fs.readFileSync(full, 'utf8')
            .split('\n')
            .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
            .join('\n')
          if (/\.get\(\s*'\/api\/readiness'/.test(src)) offenders.push(full)
        }
      }
    }
    walk(testsDir)
    expect(offenders).toEqual([])
  })
})
