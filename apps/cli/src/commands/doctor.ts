import type { Command } from 'commander'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, writeFileSync, unlinkSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import pc from 'picocolors'
import Table from 'cli-table3'

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
      const allResults = [...binaryResults, ...fsResults]

      if (opts.json) {
        process.stdout.write(JSON.stringify(allResults, null, 2) + '\n')
        const hasCriticalFail = allResults.some((r) => r.status === 'fail' && r.critical)
        process.exit(hasCriticalFail ? 1 : 0)
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

      const criticalFails = allResults.filter((r) => r.status === 'fail' && r.critical)
      if (criticalFails.length > 0) {
        process.stdout.write(pc.red(`\n${criticalFails.length} critical check(s) failed.\n`))
        process.exit(1)
      } else {
        process.stdout.write(pc.green('\nAll critical checks passed.\n'))
      }
    })
}
