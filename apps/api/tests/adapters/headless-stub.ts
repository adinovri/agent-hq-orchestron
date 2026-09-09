import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Test harness for the headless adapters.
 *
 * These tests spawn a real child process against a stub executable placed on
 * PATH rather than mocking `node:child_process`. The whole point of the
 * headless path is process plumbing — argv assembly, stdin closed, stdout
 * drained and parsed, stderr captured, exit code observed — and a mocked
 * spawn asserts none of that. A stub script exercises all of it for the price
 * of one `sh` fork.
 */
export interface Stub {
  /** Directory to prepend to PATH. */
  binDir: string
  /** argv the stub was invoked with, one element per line. */
  readArgv(): string[]
  /** cwd the stub ran in. */
  readCwd(): string
  /** Value of the named env var as the stub saw it ('' when unset). */
  readEnv(name: string): string
  cleanup(): void
}

/**
 * Write an executable stub named `name` that records how it was invoked,
 * prints `stdout` verbatim and `stderr` to fd 2, then exits `exitCode`.
 */
export function makeStub(opts: {
  name: string
  stdout?: string
  stderr?: string
  exitCode?: number
  /** Env vars whose values the stub should record. */
  captureEnv?: string[]
}): Stub {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestron-stub-'))
  const argvFile = path.join(binDir, 'argv.txt')
  const cwdFile = path.join(binDir, 'cwd.txt')
  const envFile = path.join(binDir, 'env.txt')

  const envDump = (opts.captureEnv ?? [])
    .map((k) => `printf '%s=%s\\n' ${k} "\${${k}-}" >> ${JSON.stringify(envFile)}`)
    .join('\n')

  const script = [
    '#!/bin/sh',
    // One argument per line so an argument containing spaces stays one token.
    `: > ${JSON.stringify(argvFile)}`,
    'for a in "$@"; do printf \'%s\\n\' "$a" >> ' + JSON.stringify(argvFile) + '; done',
    `pwd > ${JSON.stringify(cwdFile)}`,
    `: > ${JSON.stringify(envFile)}`,
    envDump,
    opts.stdout ? `cat <<'STUB_STDOUT_EOF'\n${opts.stdout}\nSTUB_STDOUT_EOF` : '',
    opts.stderr ? `cat >&2 <<'STUB_STDERR_EOF'\n${opts.stderr}\nSTUB_STDERR_EOF` : '',
    `exit ${opts.exitCode ?? 0}`,
    '',
  ].join('\n')

  const binPath = path.join(binDir, opts.name)
  fs.writeFileSync(binPath, script, { mode: 0o755 })

  return {
    binDir,
    readArgv: () =>
      fs.existsSync(argvFile)
        ? fs.readFileSync(argvFile, 'utf8').split('\n').filter((l) => l !== '')
        : [],
    readCwd: () => (fs.existsSync(cwdFile) ? fs.readFileSync(cwdFile, 'utf8').trim() : ''),
    readEnv: (name) => {
      if (!fs.existsSync(envFile)) return ''
      const line = fs
        .readFileSync(envFile, 'utf8')
        .split('\n')
        .find((l) => l.startsWith(`${name}=`))
      return line ? line.slice(name.length + 1) : ''
    },
    cleanup: () => fs.rmSync(binDir, { recursive: true, force: true }),
  }
}

/** Prepend `dir` to PATH for the duration of a test; returns the restorer. */
export function withPath(dir: string): () => void {
  const original = process.env['PATH']
  process.env['PATH'] = `${dir}:${original ?? ''}`
  return () => { process.env['PATH'] = original }
}
