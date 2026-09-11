import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY = join(__dirname, '../src/index.ts')
/** The workspace's own tsx, not `npx tsx`: npx re-resolves the package on
 *  every spawn, and that resolution was the bulk of this file's wall clock. */
const TSX = join(__dirname, '../../../node_modules/.bin/tsx')


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

describe('orchestron doctor', () => {
  it('outputs a table with expected column headers', async () => {
    const { stdout } = await runCli({}, 'doctor')
    expect(stdout).toContain('Check')
    expect(stdout).toContain('Status')
    expect(stdout).toContain('Version')
    expect(stdout).toContain('Hint')
  })

  it('checks for node, tmux, git, claude binaries', async () => {
    const { stdout } = await runCli({}, 'doctor')
    expect(stdout).toContain('node')
    expect(stdout).toContain('tmux')
    expect(stdout).toContain('git')
    expect(stdout).toContain('claude')
  })

  it('--json outputs valid JSON array with expected fields', async () => {
    const { stdout } = await runCli({}, 'doctor', '--json')
    const parsed = JSON.parse(stdout) as Array<{
      name: string
      status: string
      critical: boolean
    }>
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBeGreaterThan(0)
    for (const item of parsed) {
      expect(typeof item.name).toBe('string')
      expect(['pass', 'fail', 'warn', 'skip']).toContain(item.status)
      expect(typeof item.critical).toBe('boolean')
    }
  })

  it('--json includes filesystem check', async () => {
    const { stdout } = await runCli({}, 'doctor', '--json')
    const parsed = JSON.parse(stdout) as Array<{ name: string }>
    const names = parsed.map((r) => r.name)
    expect(names.some((n) => n.toLowerCase().includes('writable') || n.toLowerCase().includes('disk'))).toBe(true)
  })

  it('node check passes since node >=20 is running', async () => {
    const { stdout } = await runCli({}, 'doctor', '--json')
    const parsed = JSON.parse(stdout) as Array<{ name: string; status: string }>
    const nodeCheck = parsed.find((r) => r.name === 'node')
    expect(nodeCheck).toBeDefined()
    expect(nodeCheck?.status).toBe('pass')
  })
})
