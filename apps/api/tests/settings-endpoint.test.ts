import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * TUI P1b — Settings screen stub filed GET /api/settings as a missing
 * endpoint. These tests pin the shape and security contract at the source
 * level (same technique as health-detail-idle-timeout.test.ts) so the
 * endpoint can't drift without a test failure.
 */
const serverSrc = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/server.ts'),
  'utf8',
)

function settingsBlock(): string {
  const start = serverSrc.indexOf("fastify.get('/api/settings'")
  expect(start, 'GET /api/settings must exist in server.ts').toBeGreaterThan(-1)
  const end = serverSrc.indexOf("fastify.get('/api/version'", start)
  return serverSrc.slice(start, end === -1 ? undefined : end)
}

describe('GET /api/settings endpoint', () => {
  it('exists in server.ts', () => {
    expect(settingsBlock().length).toBeGreaterThan(0)
  })

  it('returns bindHost and apiPort from config (not literals)', () => {
    const block = settingsBlock()
    expect(block).toContain('bindHost: config.bindHost')
    expect(block).toContain('apiPort: config.port')
    // Hardcoded port would mean a tuned instance reports the wrong value.
    expect(block).not.toMatch(/apiPort:\s*\d/)
  })

  it('masks remoteToken — never exposes it in plaintext', () => {
    const block = settingsBlock()
    // The block must reference config.remoteToken only to check presence and
    // slice the suffix — it must NOT return the raw value.
    expect(block).toContain('config.remoteToken')
    expect(block).not.toMatch(/return.*remoteToken.*config\.remoteToken/)
    // Must contain masking logic (last-4 suffix pattern).
    expect(block).toContain('slice(-4)')
    expect(block).toContain('not set')
  })

  it('surfaces mcpAutoInject.enabled driven by remoteToken presence', () => {
    const block = settingsBlock()
    expect(block).toContain('mcpAutoInject')
    expect(block).toContain('enabled:')
    expect(block).toContain('!!config.remoteToken')
  })

  it('includes MCP guardrail constants', () => {
    const block = settingsBlock()
    expect(block).toContain('depth: 5')
    expect(block).toContain('children: 10')
    expect(block).toContain('rate: 5')
  })

  it('reads cleanupPeriodDays from Claude settings.json without fatal error on miss', () => {
    const block = settingsBlock()
    expect(block).toContain('cleanupPeriodDays')
    expect(block).toContain('settings.json')
    // Must be guarded — absence is non-fatal.
    expect(block).toMatch(/catch\s*\{/)
    expect(block).toContain('null')
  })

  it('is inside the authenticated perimeter (not in AUTH_WHITELIST)', () => {
    const whitelistBlock = serverSrc.slice(
      serverSrc.indexOf('AUTH_WHITELIST'),
      serverSrc.indexOf(']', serverSrc.indexOf('AUTH_WHITELIST')) + 1,
    )
    expect(whitelistBlock).not.toContain('/api/settings')
  })
})
