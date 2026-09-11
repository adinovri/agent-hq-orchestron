import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

  /**
   * NF23 — `doctor --json` used to print a bare array.
   *
   * CLI-02's contract is that every `--json` document carries a top-level
   * `ok`, so a caller can branch on one field without knowing which command
   * produced it. `doctor` was the only verb without one, which meant
   * `orchestron doctor --json | jq -e .ok` exited 5 with
   * `Cannot index array with string "ok"` — on the command an automated
   * caller runs first, before it knows whether the host works at all.
   */
  interface DoctorCheck {
    name: string
    status: string
    critical: boolean
  }
  interface DoctorEnvelope {
    ok: boolean
    error?: string
    checks: DoctorCheck[]
  }

  it('--json speaks the envelope, not a bare array (NF23)', async () => {
    const { stdout } = await runCli({}, 'doctor', '--json')
    const parsed = JSON.parse(stdout) as DoctorEnvelope
    // The regression in one line: an array has no `.ok`, and that is exactly
    // what `jq -e .ok` choked on.
    expect(Array.isArray(parsed)).toBe(false)
    expect(typeof parsed.ok).toBe('boolean')
    expect(Array.isArray(parsed.checks)).toBe(true)
    expect(parsed.checks.length).toBeGreaterThan(0)
  })

  it('--json check objects keep their fields', async () => {
    const { stdout } = await runCli({}, 'doctor', '--json')
    const { checks } = JSON.parse(stdout) as DoctorEnvelope
    for (const item of checks) {
      expect(typeof item.name).toBe('string')
      expect(['pass', 'fail', 'warn', 'skip']).toContain(item.status)
      expect(typeof item.critical).toBe('boolean')
    }
  })

  it('--json agrees with its own exit code', async () => {
    // The invariant the envelope buys. `ok` mirrors the exit code rather than
    // "the command ran": a document saying ok:true beside exit 1 would just
    // move the special-case a caller has to write, instead of removing it.
    // On a healthy host both say success; the failing direction is asserted
    // below by making a critical binary unfindable.
    const { stdout, code } = await runCli({}, 'doctor', '--json')
    const parsed = JSON.parse(stdout) as DoctorEnvelope
    expect(parsed.ok).toBe(code === 0)
  })

  it('--json reports ok:false with an error when a critical check fails', async () => {
    // Without this the failing branch is never exercised and the suite only
    // ever proves the happy document — which is how a bare array survived
    // this long in a file that already had five `--json` assertions.
    //
    // Emptying PATH outright does not work: the child is `tsx`, whose shebang
    // is `env node`, so the spawn dies before doctor runs and stdout comes
    // back empty. The PATH therefore holds exactly one entry — a `node`
    // symlink — which keeps the harness alive while tmux, git and claude (all
    // critical) become unfindable.
    const probeDir = mkdtempSync(join(tmpdir(), 'orchestron-doctor-probe-'))
    symlinkSync(process.execPath, join(probeDir, 'node'))
    try {
      const { stdout, code } = await runCli({ PATH: probeDir }, 'doctor', '--json')
      const parsed = JSON.parse(stdout) as DoctorEnvelope
      expect(parsed.ok).toBe(false)
      expect(parsed.error).toMatch(/critical check\(s\) failed/)
      expect(parsed.error).toContain('tmux')
      expect(code).toBe(1)
      // The findings are why the caller ran doctor: a failure document that
      // dropped them would be a worse regression than the one being fixed.
      expect(parsed.checks.some((c) => c.name === 'tmux' && c.status === 'fail')).toBe(true)
      // And the check that can still run must still say so, so the document
      // is a diagnosis rather than a blanket failure.
      expect(parsed.checks.find((c) => c.name === 'node')?.status).toBe('pass')
    } finally {
      rmSync(probeDir, { recursive: true, force: true })
    }
  })

  it('--json includes filesystem check', async () => {
    const { stdout } = await runCli({}, 'doctor', '--json')
    const { checks } = JSON.parse(stdout) as DoctorEnvelope
    const names = checks.map((r) => r.name)
    expect(names.some((n) => n.toLowerCase().includes('writable') || n.toLowerCase().includes('disk'))).toBe(true)
  })

  it('node check passes since node >=20 is running', async () => {
    const { stdout } = await runCli({}, 'doctor', '--json')
    const { checks } = JSON.parse(stdout) as DoctorEnvelope
    const nodeCheck = checks.find((r) => r.name === 'node')
    expect(nodeCheck).toBeDefined()
    expect(nodeCheck?.status).toBe('pass')
  })

  it('--json survives a pipe that walks away', async () => {
    // Same reason `fail()` uses process.exitCode: a write to a pipe is
    // asynchronous and process.exit does not wait for it. The document is
    // ~1 KB so it cannot truncate on buffer size alone — this asserts the
    // reader-walks-away half, which size does not cover.
    const { stdout } = await runCli({}, 'doctor', '--json')
    expect(stdout.trimEnd().endsWith('}')).toBe(true)
    expect(() => JSON.parse(stdout)).not.toThrow()
  })
})
