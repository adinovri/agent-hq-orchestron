import type { Command } from 'commander'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync, unlinkSync, statfsSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import pc from 'picocolors'
import Table from 'cli-table3'
import { resolveConfigPath, LEGACY_TOKEN_KEY } from '@agent-hq-orchestron/shared'
import { readRawConfig, resolveApiBase } from '../helpers/api.js'
import type { JsonEnvelope } from '../helpers/output.js'

const execFileAsync = promisify(execFile)

interface CheckResult {
  name: string
  status: 'pass' | 'fail' | 'warn' | 'skip'
  version?: string
  hint?: string
  critical: boolean
}

async function checkBinary(
  name: string,
  cmd: string,
  versionArgs: string[],
  minVersion: string | null,
  critical: boolean,
): Promise<CheckResult> {
  try {
    const { stdout } = await execFileAsync(cmd, versionArgs)
    const version = stdout.trim().split('\n')[0] ?? ''
    return { name, status: 'pass', version, critical }
  } catch {
    return {
      name,
      status: critical ? 'fail' : 'skip',
      hint: critical ? `Install ${cmd}` : 'Optional — not installed',
      critical,
    }
  }
}

async function checkFilesystem(): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const orchDir = join(homedir(), '.orchestron')

  try {
    mkdirSync(orchDir, { recursive: true })
    const testFile = join(orchDir, '.write-test')
    writeFileSync(testFile, 'ok')
    unlinkSync(testFile)
    results.push({ name: '~/.orchestron writable', status: 'pass', critical: true })
  } catch (e) {
    results.push({
      name: '~/.orchestron writable',
      status: 'fail',
      hint: `Cannot write: ${String(e)}`,
      critical: true,
    })
  }

  try {
    const stats = statfsSync(orchDir)
    const freeGb = (stats.bfree * stats.bsize) / 1e9
    results.push({
      name: 'Disk free',
      status: freeGb > 1 ? 'pass' : 'warn',
      version: `${freeGb.toFixed(1)} GB`,
      hint: freeGb <= 1 ? 'Less than 1 GB free' : undefined,
      critical: false,
    })
  } catch {
    results.push({ name: 'Disk free', status: 'skip', hint: 'Could not stat', critical: false })
  }

  return results
}

async function checkOrchestraConfig(): Promise<CheckResult[]> {
  const results: CheckResult[] = []
  const cfgPath = resolveConfigPath()

  if (!existsSync(cfgPath)) {
    results.push({
      name: 'Config file',
      status: 'warn',
      hint: `Not found at ${cfgPath} — run \`orchestron serve\` once to create it`,
      critical: false,
    })
    results.push({ name: 'Remote token', status: 'skip', hint: 'No config file', critical: false })
    return results
  }
  results.push({ name: 'Config file', status: 'pass', version: cfgPath, critical: false })

  const cfg = readRawConfig()
  const hasToken =
    (typeof cfg['remoteToken'] === 'string' && cfg['remoteToken'].length > 0) ||
    (typeof cfg[LEGACY_TOKEN_KEY] === 'string' && (cfg[LEGACY_TOKEN_KEY] as string).length > 0)
  results.push({
    name: 'Remote token',
    status: hasToken ? 'pass' : 'warn',
    hint: hasToken ? undefined : 'Not set — run `orchestron token rotate` to generate one',
    critical: false,
  })

  return results
}

async function checkApiReachable(): Promise<CheckResult> {
  const base = resolveApiBase()
  const url = `${base}/api/readiness`
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    let res: Response
    try {
      res = await fetch(url, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (res.ok) {
      return { name: `API (${base})`, status: 'pass', version: 'ready', critical: false }
    }
    if (res.status === 503) {
      return {
        name: `API (${base})`,
        status: 'warn',
        version: 'not_ready',
        hint: 'Server is up but not ready — check storage / adapters',
        critical: false,
      }
    }
    return {
      name: `API (${base})`,
      status: 'fail',
      hint: `HTTP ${res.status} — is \`orchestron serve\` running?`,
      critical: false,
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    const short = msg.includes('AbortError') || msg.includes('abort') ? 'timed out (3 s)' : msg.slice(0, 80)
    return {
      name: `API (${base})`,
      status: 'fail',
      hint: `Cannot connect: ${short} — is \`orchestron serve\` running?`,
      critical: false,
    }
  }
}

function statusIcon(status: CheckResult['status']): string {
  switch (status) {
    case 'pass': return pc.green('✓')
    case 'fail': return pc.red('✗')
    case 'warn': return pc.yellow('⚠')
    case 'skip': return pc.gray('—')
  }
}

export function registerDoctor(program: Command): void {
  program
    .command('doctor')
    .description('Check system prerequisites and configuration')
    .option('--json', 'Machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const checks: Promise<CheckResult>[] = [
        checkBinary('node', 'node', ['--version'], '20', true),
        checkBinary('tmux', 'tmux', ['-V'], '3.2', true),
        checkBinary('git', 'git', ['--version'], '2.40', true),
        checkBinary('claude', 'claude', ['--version'], null, true),
        checkBinary('gh', 'gh', ['--version'], null, false),
        checkBinary('bb', 'bb', ['--version'], null, false),
        checkBinary('tailscale', 'tailscale', ['version'], null, false),
      ]

      const binaryResults = await Promise.all(checks)
      const fsResults = await checkFilesystem()
      const cfgResults = await checkOrchestraConfig()
      const apiResult = await checkApiReachable()
      const allResults = [...binaryResults, ...fsResults, ...cfgResults, apiResult]

      const criticalFailures = allResults.filter((r) => r.status === 'fail' && r.critical)

      if (opts.json) {
        // NF23: this printed a bare array. Every other `--json` verb emits an
        // envelope with a top-level `ok`, which is the whole point of the
        // flag — a caller branches on one field without knowing which command
        // produced the document. `doctor` was the single exception, so any
        // uniform consumer broke on precisely the command it would run first.
        //
        // `ok` tracks the exit code rather than "the command ran". doctor
        // already exits 1 when a critical check fails; a document saying
        // `ok: true` beside exit 1 is a contradiction a caller has to
        // special-case, which is the problem being fixed, not a second one to
        // introduce. So a critical failure means `ok: false` plus the `error`
        // summary — and the `checks` array stays on the document either way,
        // because the findings are why the caller ran doctor at all.
        const envelope: JsonEnvelope =
          criticalFailures.length > 0
            ? {
                ok: false,
                error: `${criticalFailures.length} critical check(s) failed: ${criticalFailures
                  .map((r) => r.name)
                  .join(', ')}`,
                checks: allResults,
              }
            : { ok: true, checks: allResults }
        process.stdout.write(JSON.stringify(envelope, null, 2) + '\n')
        // `process.exitCode`, never `process.exit`: the JSON document was
        // just handed to stdout, and a write to a PIPE is asynchronous.
        // `doctor --json | jq` exited before the buffer drained and jq read an
        // empty document — the exact shape of the truncation the `--json`
        // envelope exists to avoid.
        if (criticalFailures.length > 0) process.exitCode = 1
        return
      }

      const t = new Table({
        head: [
          pc.bold('Check'),
          pc.bold('Status'),
          pc.bold('Version'),
          pc.bold('Hint'),
        ],
      })

      for (const r of allResults) {
        t.push([
          r.name,
          statusIcon(r.status) + ' ' + r.status,
          r.version ?? '',
          r.hint ?? '',
        ])
      }

      process.stdout.write(t.toString() + '\n')

      if (criticalFailures.length > 0) {
        process.stdout.write(pc.red(`\n${criticalFailures.length} critical check(s) failed.\n`))
        process.exitCode = 1
      } else {
        process.stdout.write(pc.green('\nAll critical checks passed.\n'))
      }
    })
}
