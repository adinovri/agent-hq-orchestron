import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * NF14: the web idle chip hardcoded a 15-minute auto-sleep threshold while
 * the E2E instance ran `idleTimeoutMs: 60000`. The UI had no way to do
 * better — `/api/health/detail` did not publish the value. These pin that it
 * does, and that it is the live config rather than a re-spelled default.
 *
 * `server.ts` boots on import (loadConfig, process.exit on failure), so the
 * handler cannot be injected the way a route plugin can; the registration is
 * pinned at the source, the way `pair-not-found.test.ts` pins /pair. The live
 * assertion belongs to the deploy check and the E2E sweep.
 */
const serverSrc = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/server.ts'),
  'utf8',
)

function healthDetailBlock(): string {
  const start = serverSrc.indexOf("fastify.get('/api/health/detail'")
  expect(start).toBeGreaterThan(-1)
  const end = serverSrc.indexOf("fastify.get('/api/version'", start)
  return serverSrc.slice(start, end === -1 ? undefined : end)
}

describe('/api/health/detail publishes idleTimeoutMs', () => {
  it('the handler returns the configured value, not a literal', () => {
    const block = healthDetailBlock()
    expect(block).toContain('idleTimeoutMs: config.idleTimeoutMs')
    // A hardcoded 900000 here would pass a naive "field present" check while
    // reproducing the exact bug on any tuned instance.
    expect(block).not.toMatch(/idleTimeoutMs:\s*\d/)
  })

  it('anonymous /api/health stays minimal — the threshold is authed detail only', () => {
    const start = serverSrc.indexOf("fastify.get('/api/health'")
    const block = serverSrc.slice(start, serverSrc.indexOf("fastify.get('/api/health/detail'", start))
    expect(block).not.toContain('idleTimeoutMs')
  })

  it('the web fallback matches the schema default', () => {
    // The UI falls back to a default whenever the field is absent (older
    // server, fetch in flight). If the two drift, an old server gets
    // described with a number neither side believes.
    const here = path.dirname(fileURLToPath(import.meta.url))
    const schema = fs.readFileSync(path.join(here, '../../../packages/shared/src/config.ts'), 'utf8')
    expect(schema).toContain('idleTimeoutMs: z.number().int().min(0).default(15 * 60 * 1000)')

    const webFallback = fs.readFileSync(path.join(here, '../../web/lib/idle-chip.ts'), 'utf8')
    expect(webFallback).toContain('export const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000')
  })
})
