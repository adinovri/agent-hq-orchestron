import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  loadConfig,
  ConfigSchema,
  DEFAULT_ENABLE_HEADLESS_MODE,
} from '@agent-hq-orchestron/shared'

/**
 * `enableHeadlessMode` is an operator kill switch, so the two properties
 * that matter are: an untouched install keeps headless available, and a
 * literal `false` in ~/.orchestron/config.json actually survives the
 * zod parse (a `.default(true)` applied over a falsy value is the classic
 * way for a flag like this to silently never turn off).
 */

let tmpDir: string

function writeConfig(body: unknown): string {
  const p = path.join(tmpDir, 'config.json')
  fs.writeFileSync(p, JSON.stringify(body), { mode: 0o600 })
  return p
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestron-cfg-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('config.enableHeadlessMode', () => {
  it('defaults to true when no config file exists', () => {
    const cfg = loadConfig({
      configPath: path.join(tmpDir, 'does-not-exist.json'),
      env: {},
    })
    expect(cfg.enableHeadlessMode).toBe(true)
    expect(DEFAULT_ENABLE_HEADLESS_MODE).toBe(true)
  })

  it('defaults to true when the config file omits the field', () => {
    const cfg = loadConfig({ configPath: writeConfig({ port: 9999 }), env: {} })
    expect(cfg.enableHeadlessMode).toBe(true)
    expect(cfg.port).toBe(9999)
  })

  it('honours an explicit false from the config file', () => {
    const cfg = loadConfig({
      configPath: writeConfig({ enableHeadlessMode: false }),
      env: {},
    })
    expect(cfg.enableHeadlessMode).toBe(false)
  })

  it('honours an explicit true from the config file', () => {
    const cfg = loadConfig({
      configPath: writeConfig({ enableHeadlessMode: true }),
      env: {},
    })
    expect(cfg.enableHeadlessMode).toBe(true)
  })

  it('rejects a non-boolean value rather than coercing it', () => {
    // "false" as a string is the shape an operator most plausibly writes
    // by mistake, and coercing it would be worse than refusing to boot.
    expect(() =>
      loadConfig({ configPath: writeConfig({ enableHeadlessMode: 'false' }), env: {} }),
    ).toThrow()
  })

  it('is not disturbed by unrelated env overrides', () => {
    const cfg = loadConfig({
      configPath: writeConfig({ enableHeadlessMode: false }),
      env: { ORCHESTRON_PORT: '7070', ORCHESTRON_LOG_LEVEL: 'debug' },
    })
    expect(cfg.enableHeadlessMode).toBe(false)
    expect(cfg.port).toBe(7070)
  })

  it('parses standalone through ConfigSchema with the same default', () => {
    const parsed = ConfigSchema.parse({ dataDir: tmpDir, maxConcurrent: 4 })
    expect(parsed.enableHeadlessMode).toBe(true)
  })
})
