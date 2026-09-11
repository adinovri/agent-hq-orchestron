import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import type { Config } from '@agent-hq-orchestron/shared'
import type { AdapterRegistry } from '../adapters/registry.js'

/**
 * Readiness — the anonymous probe a load balancer is meant to poll.
 *
 * It was in `AUTH_WHITELIST` and in `docs/HLD.md` from the beginning, but
 * nothing ever registered it: live it answered 404 to anonymous, wrong-token
 * and good-token callers alike (NF13). It went unnoticed because
 * `tests/auth.test.ts` registers a `/api/readiness` stub in its own fixture,
 * so "the whitelist lets it through" passed against a route the server did
 * not have. `tests/routes/readiness.test.ts` mounts *this* plugin instead.
 *
 * Liveness (`/api/health`) answers `{ok:true}` as long as the process is up.
 * Readiness answers whether the process can actually do work: config parsed,
 * data dir writable, at least one adapter registered. A failing check returns
 * **503**, which is what makes the endpoint worth polling — a 200-always
 * probe tells a balancer nothing it did not know from the TCP connect.
 *
 * The body stays as quiet as `/api/health` about the host: check names and
 * pass/fail, never the `dataDir` path or adapter internals. Anonymous callers
 * on the tailnet get no new fingerprinting surface.
 */
export type ReadinessCheck = 'config' | 'storage' | 'adapters'

export interface ReadinessBody {
  status: 'ready' | 'not_ready'
  /** Process uptime in seconds, rounded — matches `process.uptime()`. */
  uptime: number
  checks: Record<ReadinessCheck, boolean>
}

/** Is `dir` a directory we can actually write into? `fs.accessSync(W_OK)`
 *  answers for the inode, which is the question a readiness probe has: a
 *  read-only mount or a dir owned by another uid both fail here, and neither
 *  leaves a stray file behind the way a probe-writes-a-tempfile check would. */
function storageWritable(dir: string): boolean {
  try {
    const st = fs.statSync(dir)
    if (!st.isDirectory()) return false
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

export function evaluateReadiness(config: Config, registry: AdapterRegistry): ReadinessBody {
  const checks: Record<ReadinessCheck, boolean> = {
    // Config is loaded by the time any route exists — `loadConfig()` throwing
    // exits the process at boot. Asserting the fields the rest of the checks
    // depend on keeps the check honest rather than hardcoding `true`.
    config: Boolean(config?.dataDir) && typeof config.port === 'number',
    storage: Boolean(config?.dataDir) && storageWritable(path.resolve(config.dataDir)),
    adapters: registry.names().length > 0,
  }
  const ready = Object.values(checks).every(Boolean)
  return { status: ready ? 'ready' : 'not_ready', uptime: Math.round(process.uptime()), checks }
}

export function readinessPlugin(config: Config, registry: AdapterRegistry) {
  return fp(async (app: FastifyInstance) => {
    app.get('/api/readiness', async (_req, reply) => {
      const body = evaluateReadiness(config, registry)
      return reply.code(body.status === 'ready' ? 200 : 503).send(body)
    })
  })
}
