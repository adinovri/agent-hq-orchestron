import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY = join(__dirname, '../src/index.ts')
/** The workspace's own tsx, not `npx tsx`: npx re-resolves the package on
 *  every spawn, and that resolution was the bulk of this file's wall clock. */
const TSX = join(__dirname, '../../../node_modules/.bin/tsx')


/**
 * B6-F1 — rotate wrote the config key `token`; the API reads
 * `remoteToken`. The rotate therefore printed a token that never
 * authenticated, reported success, and left the old (possibly leaked)
 * bearer working.
 */

let dataDir: string
let configPath: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(join(os.tmpdir(), 'cli-token-'))
  configPath = join(dataDir, 'config.json')
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

async function runCli(
  env: Record<string, string>,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(TSX, [CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
    })
    return { stdout, stderr, code: 0 }
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; code?: number }
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 }
  }
}

function read(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
}

describe('orchestron token rotate', () => {
  it('writes remoteToken, the key the API actually reads', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ port: 8090, remoteToken: 'old-token' }))
    const { stdout, code } = await runCli(
      { ORCHESTRON_DATA_DIR: dataDir },
      'token', 'rotate', '--json',
    )
    expect(code).toBe(0)
    const out = JSON.parse(stdout) as { token: string; key: string }
    expect(out.key).toBe('remoteToken')

    const cfg = read()
    expect(cfg.remoteToken).toBe(out.token)
    expect(cfg.remoteToken).not.toBe('old-token')
    // The whole defect: a stray `token` key nothing reads.
    expect('token' in cfg).toBe(false)
  }, 30_000)

  it('preserves the rest of the config', async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ port: 8091, maxConcurrent: 4, bindHost: '0.0.0.0', remoteToken: 'x' }),
    )
    await runCli({ ORCHESTRON_DATA_DIR: dataDir }, 'token', 'rotate', '--json')
    const cfg = read()
    expect(cfg.port).toBe(8091)
    expect(cfg.maxConcurrent).toBe(4)
    expect(cfg.bindHost).toBe('0.0.0.0')
  }, 30_000)

  it('removes a legacy token key in the same write', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ port: 8090, token: 'legacy-abc' }))
    const { stdout } = await runCli(
      { ORCHESTRON_DATA_DIR: dataDir },
      'token', 'rotate', '--json',
    )
    const out = JSON.parse(stdout) as { token: string; legacyKeyRemoved: boolean }
    expect(out.legacyKeyRemoved).toBe(true)
    const cfg = read()
    expect('token' in cfg).toBe(false)
    expect(cfg.remoteToken).toBe(out.token)
  }, 30_000)

  it('honours ORCHESTRON_CONFIG over the data dir', async () => {
    const alt = join(dataDir, 'alt.json')
    fs.writeFileSync(alt, JSON.stringify({ remoteToken: 'x' }))
    await runCli({ ORCHESTRON_CONFIG: alt }, 'token', 'rotate', '--json')
    expect(fs.existsSync(configPath)).toBe(false)
    expect((JSON.parse(fs.readFileSync(alt, 'utf8')) as { remoteToken: string }).remoteToken)
      .not.toBe('x')
  }, 30_000)

  it('creates the config when there is none', async () => {
    const { code } = await runCli({ ORCHESTRON_DATA_DIR: dataDir }, 'token', 'rotate', '--json')
    expect(code).toBe(0)
    expect(typeof read().remoteToken).toBe('string')
  }, 30_000)

  it('writes the file 0600 — plaintext bearer', async () => {
    await runCli({ ORCHESTRON_DATA_DIR: dataDir }, 'token', 'rotate', '--json')
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600)
  }, 30_000)

  it('says a restart is needed — the API parses config once at boot', async () => {
    // Without this, an operator rotating after a leak walks away
    // believing the leaked token is dead while the process still takes it.
    const { stdout } = await runCli({ ORCHESTRON_DATA_DIR: dataDir }, 'token', 'rotate')
    expect(stdout.toLowerCase()).toContain('restart')
    const json = await runCli({ ORCHESTRON_DATA_DIR: dataDir }, 'token', 'rotate', '--json')
    expect((JSON.parse(json.stdout) as { restartRequired: boolean }).restartRequired).toBe(true)
  }, 60_000)
})

describe('orchestron token generate', () => {
  it('prints a token and writes nothing', async () => {
    const { stdout, code } = await runCli(
      { ORCHESTRON_DATA_DIR: dataDir },
      'token', 'generate', '--json',
    )
    expect(code).toBe(0)
    expect((JSON.parse(stdout) as { token: string }).token).toMatch(/^[0-9a-f]{48}$/)
    expect(fs.existsSync(configPath)).toBe(false)
  }, 30_000)
})

describe('orchestron qr — token discovery', () => {
  it('finds remoteToken in the config file with no env var set', async () => {
    // The second symptom of B6-F1: qr read `token` only, so the
    // documented way to pair a phone could not find the token sitting
    // in the very file it was reading.
    fs.writeFileSync(configPath, JSON.stringify({ remoteToken: 'cfg-remote-token' }))
    const { stdout, code } = await runCli(
      { ORCHESTRON_DATA_DIR: dataDir, ORCHESTRON_REMOTE_TOKEN: '' },
      'qr', '--port', '3010',
    )
    expect(code).toBe(0)
    expect(stdout).toContain('cfg-remote-token')
  }, 30_000)

  it('still falls back to a legacy token key', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ token: 'cfg-legacy-token' }))
    const { stdout, code } = await runCli(
      { ORCHESTRON_DATA_DIR: dataDir, ORCHESTRON_REMOTE_TOKEN: '' },
      'qr',
    )
    expect(code).toBe(0)
    expect(stdout).toContain('cfg-legacy-token')
  }, 30_000)

  it('prefers remoteToken when both are present', async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ remoteToken: 'the-live-one', token: 'the-stale-one' }),
    )
    const { stdout } = await runCli(
      { ORCHESTRON_DATA_DIR: dataDir, ORCHESTRON_REMOTE_TOKEN: '' },
      'qr',
    )
    expect(stdout).toContain('the-live-one')
    expect(stdout).not.toContain('the-stale-one')
  }, 30_000)
})
