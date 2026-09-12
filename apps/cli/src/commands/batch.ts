import type { Command } from 'commander'
import { readFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { parse as parseYaml } from 'yaml'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import pc from 'picocolors'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Resolve the runner + entry for spawning batch steps.
//
// Under tsx (dev/test): argv[0]=node, argv[1]=apps/cli/src/index.ts
//   → we need to spawn tsx, not bare node, to run a .ts file.
// Under the compiled binary (production): argv[0]=node, argv[1]=bin/orchestron (or dist/index.js)
//   → bare node is fine since it's compiled JS.
//
// Detection: if argv[1] ends with .ts, find tsx in our local node_modules.
const SELF_ENTRY = process.argv[1]!
const IS_TS_RUN = SELF_ENTRY.endsWith('.ts')
const TSX_BIN = path.join(__dirname, '../../../../node_modules/.bin/tsx')
const SELF_RUNNER = IS_TS_RUN && existsSync(TSX_BIN) ? TSX_BIN : process.argv[0]!

// ─── Schema ─────────────────────────────────────────────────────────────────

type BatchStep = {
  name: string
  cmd: string
  args?: string[]
  if_prev_success?: boolean
  env?: Record<string, string>
}

type BatchFile = {
  steps: BatchStep[]
}

function validateBatchFile(raw: unknown): BatchFile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Batch file must be a YAML mapping at the top level')
  }
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj['steps'])) {
    throw new Error('Batch file must have a "steps" list')
  }
  const steps = obj['steps'].map((s: unknown, idx: number) => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
      throw new Error(`Step ${idx} must be a mapping`)
    }
    const m = s as Record<string, unknown>
    if (typeof m['name'] !== 'string') throw new Error(`Step ${idx} missing string "name"`)
    if (typeof m['cmd'] !== 'string') throw new Error(`Step ${idx} missing string "cmd"`)
    const args = m['args'] !== undefined
      ? (Array.isArray(m['args']) ? m['args'].map(String) : [String(m['args'])])
      : []
    const env: Record<string, string> = {}
    if (m['env'] && typeof m['env'] === 'object' && !Array.isArray(m['env'])) {
      for (const [k, v] of Object.entries(m['env'] as Record<string, unknown>)) {
        env[k] = String(v)
      }
    }
    return {
      name: m['name'] as string,
      cmd: m['cmd'] as string,
      args,
      if_prev_success: m['if_prev_success'] !== false,
      env,
    } satisfies BatchStep
  })
  return { steps }
}

// ─── Variable interpolation ─────────────────────────────────────────────────

function interpolate(s: string, vars: Record<string, string>): string {
  return s.replace(/\$\{([^}]+)\}/g, (_, key: string) => vars[key] ?? `\${${key}}`)
}

function interpolateArgs(args: string[], vars: Record<string, string>): string[] {
  return args.map((a) => interpolate(a, vars))
}

// ─── Step runner ─────────────────────────────────────────────────────────────

type StepResult = {
  name: string
  exitCode: number
  stdout: string
  elapsedMs: number
}

function runStep(
  step: BatchStep,
  vars: Record<string, string>,
): Promise<StepResult> {
  return new Promise((resolve) => {
    const cmd = interpolate(step.cmd, vars)
    const args = interpolateArgs(step.args ?? [], vars)
    const startMs = Date.now()
    const proc = spawn(SELF_RUNNER, [SELF_ENTRY, cmd, ...args], {
      env: { ...process.env, ...(step.env ?? {}) },
      stdio: ['inherit', 'pipe', 'inherit'],
    })
    let stdout = ''
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      process.stdout.write(chunk)
    })
    proc.on('close', (code) => {
      resolve({
        name: step.name,
        exitCode: code ?? 1,
        stdout,
        elapsedMs: Date.now() - startMs,
      })
    })
  })
}

// ─── Var extraction from stdout ──────────────────────────────────────────────
// Capture EXPORT name=value lines from step stdout, plus JSON fields.

function extractVars(stdout: string, stepIdx: number): Record<string, string> {
  const vars: Record<string, string> = {}
  const prefix = `step${stepIdx}`
  for (const line of stdout.split('\n')) {
    const m = line.match(/^EXPORT\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m) {
      vars[m[1]!] = m[2]!.trim()
    }
  }
  try {
    const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' || typeof v === 'number') {
        vars[`${prefix}.${k}`] = String(v)
      }
    }
  } catch { /* not JSON */ }
  return vars
}

// ─── Command registration ────────────────────────────────────────────────────

export function registerBatch(program: Command): void {
  program
    .command('batch <file>')
    .description(
      'Run a sequence of orchestron commands from a YAML file. ' +
      'Steps share a variable namespace; use ${step0.fieldName} for JSON outputs. ' +
      'Steps can emit EXPORT KEY=VALUE lines to pass arbitrary values forward.',
    )
    .option('--continue-on-error', 'Continue to next step even if the previous step failed')
    .option('--dry-run', 'Print steps without executing them')
    .action(async (file: string, opts: { continueOnError?: boolean; dryRun?: boolean }) => {
      let raw: string
      try {
        raw = readFileSync(file, 'utf8')
      } catch {
        process.stderr.write(pc.red(`Error: Cannot read batch file: ${file}\n`))
        process.exitCode = 1
        return
      }

      let batch: BatchFile
      try {
        const parsed = parseYaml(raw)
        batch = validateBatchFile(parsed)
      } catch (e: unknown) {
        process.stderr.write(pc.red(`Error: Invalid batch file: ${e instanceof Error ? e.message : String(e)}\n`))
        process.exitCode = 1
        return
      }

      if (opts.dryRun) {
        process.stdout.write(pc.cyan(`Batch: ${batch.steps.length} step(s)\n`))
        for (let i = 0; i < batch.steps.length; i++) {
          const s = batch.steps[i]!
          const cond = s.if_prev_success === false ? ' [always]' : ''
          process.stdout.write(`  ${i + 1}. ${s.name}${cond}: orchestron ${s.cmd} ${(s.args ?? []).join(' ')}\n`)
        }
        return
      }

      const results: StepResult[] = []
      const vars: Record<string, string> = {}
      let prevSuccess = true

      process.stdout.write(pc.bold(`\nBatch: ${batch.steps.length} step(s)\n`) + '\n')

      for (let i = 0; i < batch.steps.length; i++) {
        const step = batch.steps[i]!

        // If this step requires previous success AND prev failed AND we're
        // not in continue-on-error mode, skip it and keep going (so all
        // remaining steps appear in the summary as skipped).
        if (step.if_prev_success !== false && !prevSuccess && !opts.continueOnError) {
          process.stdout.write(pc.gray(`  [skip] ${step.name} (previous step failed)\n`))
          results.push({ name: step.name, exitCode: -1, stdout: '', elapsedMs: 0 })
          continue
        }

        process.stdout.write(pc.bold(`▶ Step ${i + 1}/${batch.steps.length}: ${step.name}\n`))
        process.stdout.write(pc.dim(`  orchestron ${step.cmd} ${interpolateArgs(step.args ?? [], vars).join(' ')}\n`))

        const result = await runStep(step, vars)
        results.push(result)
        prevSuccess = result.exitCode === 0

        const extracted = extractVars(result.stdout, i)
        Object.assign(vars, extracted)

        const status = result.exitCode === 0
          ? pc.green('✓ ok')
          : pc.red(`✗ exit ${result.exitCode}`)
        process.stdout.write(`  ${status} — ${result.elapsedMs}ms\n\n`)

        if (!prevSuccess) {
          process.stderr.write(pc.red(`Step ${i + 1} (${step.name}) failed.\n`))
        }
      }

      process.stdout.write(pc.bold('\n─── Batch summary ───\n'))
      for (const r of results) {
        const icon = r.exitCode === 0 ? pc.green('✓') : r.exitCode === -1 ? pc.gray('-') : pc.red('✗')
        const time = r.exitCode === -1 ? pc.gray('skipped') : `${r.elapsedMs}ms`
        process.stdout.write(`  ${icon}  ${r.name.padEnd(30)} ${time}\n`)
      }

      const failed = results.filter((r) => r.exitCode !== 0 && r.exitCode !== -1)
      if (failed.length > 0) {
        process.exitCode = 1
      }
    })
}
