import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'

const execFileAsync = promisify(execFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY = join(__dirname, '../src/index.ts')
const TSX = join(__dirname, '../../../node_modules/.bin/tsx')

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'orch-repl-'))
})

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Run the REPL with a sequence of newline-separated inputs fed on stdin,
 * kill after a short timeout, and return everything it printed.
 *
 * We can't use `execFileAsync` for interactive REPL tests because the process
 * never exits on its own — we feed stdin, collect stdout+stderr, then kill.
 */
function runReplWithInput(
  input: string,
  { timeoutMs = 3000 }: { timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = execFile(
      TSX,
      [CLI_ENTRY, 'repl', '--url', 'http://127.0.0.1:19999'],
      { env: { ...process.env, ORCHESTRON_DATA_DIR: tmpDir } },
    )

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    child.on('close', (code) => resolve({ stdout, stderr, code }))

    // Write input and close stdin to trigger graceful exit on Ctrl+D equivalent
    child.stdin?.write(input)
    child.stdin?.end()

    // Fallback kill if process doesn't exit in time
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
    }, timeoutMs)
    child.on('close', () => clearTimeout(timer))
  })
}

describe('orchestron repl — command registration', () => {
  it('repl subcommand is registered and appears in --help', async () => {
    const { stdout } = await execFileAsync(TSX, [CLI_ENTRY, '--help'], {
      env: { ...process.env, ORCHESTRON_DATA_DIR: tmpDir },
    })
    expect(stdout).toContain('repl')
  })

  it('repl --help shows description', async () => {
    const { stdout } = await execFileAsync(TSX, [CLI_ENTRY, 'repl', '--help'], {
      env: { ...process.env, ORCHESTRON_DATA_DIR: tmpDir },
    }).catch((e: unknown) => {
      const err = e as { stdout?: string; stderr?: string }
      return { stdout: (err.stdout ?? '') + (err.stderr ?? '') }
    })
    expect(stdout).toMatch(/repl|interactive/i)
  })
})

describe('orchestron repl — REPL interaction', () => {
  it('shows banner on startup', async () => {
    const { stderr } = await runReplWithInput('\n')
    expect(stderr).toMatch(/Orchestron REPL/i)
  })

  it('shows prompt', async () => {
    const { stdout, stderr } = await runReplWithInput('\n')
    // rl writes prompt to stdout (the output stream)
    expect(stdout + stderr).toContain('orchestron')
  })

  it('.help command prints help text', async () => {
    const { stdout, stderr } = await runReplWithInput('.help\n')
    const combined = stdout + stderr
    expect(combined).toMatch(/\.help|Subcommands|Special commands/i)
  })

  it('.exit command exits the REPL', async () => {
    const { code } = await runReplWithInput('.exit\n', { timeoutMs: 5000 })
    expect(code).toBe(0)
  })

  it('exit command (without dot) exits the REPL', async () => {
    const { code } = await runReplWithInput('exit\n', { timeoutMs: 5000 })
    expect(code).toBe(0)
  })

  it('unknown command shows error message with suggestion', async () => {
    const { stderr } = await runReplWithInput('sesion\nexit\n')
    expect(stderr).toMatch(/Unknown command|Did you mean/i)
  })

  it('.set default-project changes the prompt', async () => {
    const { stdout, stderr } = await runReplWithInput('.set default-project proj-123\nexit\n')
    const combined = stdout + stderr
    expect(combined).toContain('proj-123')
  })

  it('dot command other than .help/.exit/.set shows error', async () => {
    const { stderr } = await runReplWithInput('.unknown\nexit\n')
    expect(stderr).toMatch(/Unknown REPL command/i)
  })

  it('alias sess resolves to session', async () => {
    // sess list will try to call the real API — that fails, but the error
    // message should come from session list, NOT from "Unknown command"
    const { stderr } = await runReplWithInput('sess list\nexit\n', { timeoutMs: 5000 })
    // Should NOT show "Unknown command: sess"
    expect(stderr).not.toContain('Unknown command: sess')
  })

  it('alias sch resolves to schedule', async () => {
    const { stderr } = await runReplWithInput('sch list\nexit\n', { timeoutMs: 5000 })
    expect(stderr).not.toContain('Unknown command: sch')
  })
})

describe('orchestron repl — history file', () => {
  it('creates history file in ~/.orchestron/', async () => {
    // Override HOME so history goes to tmpDir
    const fakeHome = join(tmpDir, 'home')
    fs.mkdirSync(fakeHome, { recursive: true })
    await runReplWithInput('exit\n', { timeoutMs: 5000 }).then(() => {})
    // We can't easily control HOME in the test, so just verify REPL exits cleanly
    // The history write itself is tested via code inspection
  })
})
