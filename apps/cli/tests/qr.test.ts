import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY = join(__dirname, '../src/index.ts')

async function runCli(
  env: Record<string, string>,
  ...args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', CLI_ENTRY, ...args], {
      env: { ...process.env, ...env },
    })
    return { stdout, stderr, code: 0 }
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; code?: number }
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 }
  }
}

describe('orchestron qr', () => {
  it('exits with code 1 and clear error when no token provided', async () => {
    // Unset any env token, use temp HOME so no config file exists
    const { stderr, code } = await runCli(
      {
        ORCHESTRON_REMOTE_TOKEN: '',
        HOME: '/tmp',
      },
      'qr',
    )
    expect(code).toBe(1)
    expect(stderr.toLowerCase()).toMatch(/token|error/)
  })

  it('builds URL with correct token from env', async () => {
    const { stdout, code } = await runCli(
      { ORCHESTRON_REMOTE_TOKEN: 'test-token-abc' },
      'qr',
      '--token',
      'test-token-abc',
      '--port',
      '8080',
    )
    // Should succeed and contain the pair URL
    expect(code).toBe(0)
    expect(stdout).toContain('test-token-abc')
    expect(stdout).toContain(':8080/pair?token=')
  })

  it('includes security warning in output', async () => {
    const { stdout } = await runCli(
      { ORCHESTRON_REMOTE_TOKEN: 'tok123' },
      'qr',
      '--token',
      'tok123',
    )
    expect(stdout.toUpperCase()).toContain('SECURITY')
  })
})

describe('resolve-host', () => {
  it('returns a valid IP string', async () => {
    const mod = await import('../src/helpers/resolve-host.js')
    const { host } = await mod.resolveHost()
    expect(host).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
  })
})
