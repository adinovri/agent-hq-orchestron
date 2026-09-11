import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  loadConfig,
  migrateLegacyTokenKey,
  applyLegacyTokenKey,
} from '@agent-hq-orchestron/shared'

/**
 * B6-F1 — `orchestron token rotate` wrote `token`; ConfigSchema reads
 * `remoteToken`. Rotate therefore printed a token that never
 * authenticated and left the leaked one live. The CLI now writes
 * `remoteToken`; these cover the two halves that carry configs the
 * broken version already wrote.
 */

let dataDir: string
let configPath: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-token-'))
  configPath = path.join(dataDir, 'config.json')
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function write(obj: Record<string, unknown>): void {
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2))
}

function read(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
}

const silent = () => {}

describe('applyLegacyTokenKey — in-memory fold', () => {
  it('adopts a lone legacy token as remoteToken', () => {
    const out = applyLegacyTokenKey({ port: 8090, token: 'legacy-abc' }, silent)
    expect(out.remoteToken).toBe('legacy-abc')
    expect('token' in out).toBe(false)
  })

  it('prefers remoteToken when both keys are present', () => {
    // The key the API has been reading is the one currently
    // authenticating live clients — adopting `token` would lock them out.
    const out = applyLegacyTokenKey({ remoteToken: 'live', token: 'stale' }, silent)
    expect(out.remoteToken).toBe('live')
  })

  it('warns in both those cases', () => {
    const msgs: string[] = []
    applyLegacyTokenKey({ token: 'legacy-abc' }, (m) => msgs.push(m))
    applyLegacyTokenKey({ remoteToken: 'live', token: 'stale' }, (m) => msgs.push(m))
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatch(/legacy/i)
    expect(msgs[1]).toMatch(/both/i)
  })

  it('leaves a config with neither key alone', () => {
    const input = { port: 8090 }
    expect(applyLegacyTokenKey(input, silent)).toBe(input)
  })

  it('ignores an empty-string legacy token', () => {
    const out = applyLegacyTokenKey({ token: '' }, silent)
    expect(out.remoteToken).toBeUndefined()
  })
})

describe('loadConfig — a legacy config still authenticates', () => {
  it('surfaces a legacy token as remoteToken', () => {
    write({ port: 8090, maxConcurrent: 4, dataDir, token: 'legacy-abc' })
    const cfg = loadConfig({ configPath, env: {} as NodeJS.ProcessEnv })
    expect(cfg.remoteToken).toBe('legacy-abc')
  })

  it('does not let a legacy token shadow a real remoteToken', () => {
    write({ port: 8090, maxConcurrent: 4, dataDir, remoteToken: 'live', token: 'stale' })
    const cfg = loadConfig({ configPath, env: {} as NodeJS.ProcessEnv })
    expect(cfg.remoteToken).toBe('live')
  })

  it('still lets the env var win', () => {
    write({ port: 8090, maxConcurrent: 4, dataDir, token: 'legacy-abc' })
    const cfg = loadConfig({
      configPath,
      env: { ORCHESTRON_REMOTE_TOKEN: 'from-env' } as NodeJS.ProcessEnv,
    })
    expect(cfg.remoteToken).toBe('from-env')
  })
})

describe('migrateLegacyTokenKey — the one-shot boot rewrite', () => {
  it('renames token to remoteToken on disk', () => {
    write({ port: 8090, maxConcurrent: 4, token: 'legacy-abc' })
    const res = migrateLegacyTokenKey({ configPath, env: {} as NodeJS.ProcessEnv, warn: silent })
    expect(res.migrated).toBe(true)
    const after = read()
    expect(after.remoteToken).toBe('legacy-abc')
    expect('token' in after).toBe(false)
    expect(after.port).toBe(8090)
  })

  it('is idempotent — a second run is a no-op', () => {
    write({ port: 8090, token: 'legacy-abc' })
    migrateLegacyTokenKey({ configPath, env: {} as NodeJS.ProcessEnv, warn: silent })
    const first = fs.readFileSync(configPath, 'utf8')
    const res = migrateLegacyTokenKey({ configPath, env: {} as NodeJS.ProcessEnv, warn: silent })
    expect(res.migrated).toBe(false)
    expect(res.reason).toBe('no legacy token key')
    expect(fs.readFileSync(configPath, 'utf8')).toBe(first)
  })

  it('refuses to touch a config that already has a remoteToken', () => {
    write({ remoteToken: 'live', token: 'stale' })
    const res = migrateLegacyTokenKey({ configPath, env: {} as NodeJS.ProcessEnv, warn: silent })
    expect(res.migrated).toBe(false)
    expect(res.reason).toBe('remoteToken already set')
    expect(read().remoteToken).toBe('live')
  })

  it('writes the file 0600 — it holds a plaintext bearer', () => {
    write({ token: 'legacy-abc' })
    fs.chmodSync(configPath, 0o644)
    migrateLegacyTokenKey({ configPath, env: {} as NodeJS.ProcessEnv, warn: silent })
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600)
  })

  it('is a no-op with no config file at all', () => {
    const res = migrateLegacyTokenKey({
      configPath: path.join(dataDir, 'absent.json'),
      env: {} as NodeJS.ProcessEnv,
      warn: silent,
    })
    expect(res.migrated).toBe(false)
    expect(res.reason).toBe('no config file')
  })

  it('survives an unparseable config without throwing', () => {
    fs.writeFileSync(configPath, '{not json')
    const res = migrateLegacyTokenKey({ configPath, env: {} as NodeJS.ProcessEnv, warn: silent })
    expect(res.migrated).toBe(false)
    expect(res.reason).toBe('unparseable config')
  })

  it('resolves the path from ORCHESTRON_DATA_DIR like the server does', () => {
    write({ token: 'legacy-abc' })
    const res = migrateLegacyTokenKey({
      env: { ORCHESTRON_DATA_DIR: dataDir } as NodeJS.ProcessEnv,
      warn: silent,
    })
    expect(res.migrated).toBe(true)
    expect(res.configPath).toBe(configPath)
    expect(read().remoteToken).toBe('legacy-abc')
  })
})

describe('rotate semantics end to end', () => {
  it('a rotate that writes remoteToken invalidates the old bearer', () => {
    // The shape of the bug: rotate wrote `token`, so the config the API
    // loaded still carried the OLD remoteToken and the printed one 401d.
    write({ port: 8090, maxConcurrent: 4, dataDir, remoteToken: 'old-token' })

    // What the broken CLI did.
    const broken = read()
    broken.token = 'new-token'
    write(broken)
    expect(loadConfig({ configPath, env: {} as NodeJS.ProcessEnv }).remoteToken).toBe('old-token')

    // What the fixed CLI does.
    const fixed = read()
    fixed.remoteToken = 'new-token'
    delete fixed.token
    write(fixed)
    expect(loadConfig({ configPath, env: {} as NodeJS.ProcessEnv }).remoteToken).toBe('new-token')
  })
})
