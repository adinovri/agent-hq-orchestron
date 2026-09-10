import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, resolveConfigPath, CONFIG_FILENAME } from '@agent-hq-orchestron/shared'

/**
 * `resolveConfigPath` is what makes a second Orchestron on one host
 * possible, and it is the piece the E2E environment (scripts/e2e-env.sh)
 * rests on entirely.
 *
 * Before it, `ORCHESTRON_DATA_DIR` moved every *record* a run wrote but the
 * config file stayed pinned to `~/.orchestron/config.json` — so a second
 * instance pointed at its own data dir still booted on the primary's port
 * and, worse, its bearer token. The tests below are therefore split in two:
 *
 *   1. the new arms actually redirect the read, and
 *   2. an install with none of the env vars set resolves *exactly* where it
 *      used to. That second half is the one that must never go red; every
 *      existing deploy depends on it.
 */

let tmpDir: string

function writeConfigAt(dir: string, body: unknown): string {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, CONFIG_FILENAME)
  fs.writeFileSync(p, JSON.stringify(body), { mode: 0o600 })
  return p
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestron-cfgpath-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('resolveConfigPath', () => {
  const legacyDefault = path.join(os.homedir(), '.orchestron', CONFIG_FILENAME)

  it('resolves to ~/.orchestron/config.json when no env var is set', () => {
    expect(resolveConfigPath({})).toBe(legacyDefault)
  })

  it('an explicit path from the caller wins over every env var', () => {
    const explicit = path.join(tmpDir, 'somewhere-else.json')
    expect(
      resolveConfigPath(
        { ORCHESTRON_CONFIG: '/env/wins/not.json', ORCHESTRON_DATA_DIR: '/env/dir' },
        explicit,
      ),
    ).toBe(explicit)
  })

  it('ORCHESTRON_CONFIG names the file outright', () => {
    expect(resolveConfigPath({ ORCHESTRON_CONFIG: '/e2e/conf.json' })).toBe('/e2e/conf.json')
  })

  it('ORCHESTRON_CONFIG outranks ORCHESTRON_DATA_DIR', () => {
    expect(
      resolveConfigPath({
        ORCHESTRON_CONFIG: '/explicit/conf.json',
        ORCHESTRON_DATA_DIR: '/some/data/dir',
      }),
    ).toBe('/explicit/conf.json')
  })

  it('derives the file from ORCHESTRON_DATA_DIR', () => {
    expect(resolveConfigPath({ ORCHESTRON_DATA_DIR: '/home/u/.orchestron-e2e' })).toBe(
      path.join('/home/u/.orchestron-e2e', CONFIG_FILENAME),
    )
  })

  it('honours the legacy AHQ_DATA_DIR the env mapping still accepts', () => {
    // envOverrides() falls back to AHQ_DATA_DIR for `dataDir`. If the config
    // path did not fall back too, a legacy install would read one dir and
    // write another.
    expect(resolveConfigPath({ AHQ_DATA_DIR: '/legacy/dir' })).toBe(
      path.join('/legacy/dir', CONFIG_FILENAME),
    )
  })

  it('prefers ORCHESTRON_DATA_DIR over the legacy AHQ_DATA_DIR', () => {
    expect(
      resolveConfigPath({ ORCHESTRON_DATA_DIR: '/new/dir', AHQ_DATA_DIR: '/legacy/dir' }),
    ).toBe(path.join('/new/dir', CONFIG_FILENAME))
  })

  it('ignores an empty-string env var rather than resolving to "/config.json"', () => {
    // systemd writes `Environment="X="` as an empty string, not an unset
    // var. Treating that as a value would put the config at the filesystem
    // root and the API would boot on built-in defaults with no token.
    expect(resolveConfigPath({ ORCHESTRON_DATA_DIR: '', ORCHESTRON_CONFIG: '' })).toBe(
      legacyDefault,
    )
  })
})

describe('loadConfig honours the resolved path', () => {
  it('reads the file ORCHESTRON_DATA_DIR points at', () => {
    const dataDir = path.join(tmpDir, '.orchestron-e2e')
    writeConfigAt(dataDir, { port: 8091, remoteToken: 'e2e-token', maxConcurrent: 4 })

    const cfg = loadConfig({ env: { ORCHESTRON_DATA_DIR: dataDir } })

    expect(cfg.port).toBe(8091)
    expect(cfg.remoteToken).toBe('e2e-token')
    expect(cfg.maxConcurrent).toBe(4)
    // ORCHESTRON_DATA_DIR is also an env override for `dataDir` itself, so
    // the records land beside the config that described them.
    expect(cfg.dataDir).toBe(dataDir)
  })

  it('reads the file ORCHESTRON_CONFIG points at', () => {
    const p = path.join(tmpDir, 'elsewhere.json')
    fs.writeFileSync(p, JSON.stringify({ port: 9099, maxConcurrent: 2 }), { mode: 0o600 })

    expect(loadConfig({ env: { ORCHESTRON_CONFIG: p } }).port).toBe(9099)
  })

  it('an env var still outranks the file it just pointed at', () => {
    const dataDir = path.join(tmpDir, '.orchestron-e2e')
    writeConfigAt(dataDir, { port: 8091, maxConcurrent: 4 })

    const cfg = loadConfig({
      env: { ORCHESTRON_DATA_DIR: dataDir, ORCHESTRON_PORT: '8099' },
    })

    expect(cfg.port).toBe(8099)
  })

  it('two data dirs yield two independent configs — the whole point', () => {
    const a = path.join(tmpDir, 'inst-a')
    const b = path.join(tmpDir, 'inst-b-e2e')
    writeConfigAt(a, { port: 8090, remoteToken: 'prod-token', maxConcurrent: 12 })
    writeConfigAt(b, { port: 8091, remoteToken: 'e2e-token', maxConcurrent: 4 })

    const cfgA = loadConfig({ env: { ORCHESTRON_DATA_DIR: a } })
    const cfgB = loadConfig({ env: { ORCHESTRON_DATA_DIR: b } })

    expect([cfgA.port, cfgB.port]).toEqual([8090, 8091])
    expect(cfgA.remoteToken).not.toBe(cfgB.remoteToken)
    expect(cfgA.dataDir).not.toBe(cfgB.dataDir)
  })

  it('missing config at the redirected path falls back to defaults, not to the old path', () => {
    // The failure this guards against is subtle and bad: a typo'd data dir
    // silently reading the deployed instance's config — same port, same
    // bearer — instead of coming up empty.
    const empty = path.join(tmpDir, 'nothing-here-e2e')
    fs.mkdirSync(empty, { recursive: true })

    const cfg = loadConfig({ env: { ORCHESTRON_DATA_DIR: empty } })

    expect(cfg.port).toBe(8080) // ConfigSchema's built-in default
    expect(cfg.remoteToken).toBeUndefined()
    expect(cfg.dataDir).toBe(empty)
  })
})
