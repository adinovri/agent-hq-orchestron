import path from 'node:path'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import { appendJsonl, listDir } from '@agent-hq-orchestron/file-store'
import type { HookEvent } from '@agent-hq-orchestron/shared'

const SYNC_EVENTS = new Set<HookEvent>(['pre-spawn', 'on-schedule-fire'])
const DEFAULT_TIMEOUT_MS = 5000

export class HookAbortError extends Error {
  constructor(
    public readonly scriptPath: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(`Hook aborted: ${path.basename(scriptPath)} exited with code ${exitCode}: ${stderr.slice(0, 200)}`)
    this.name = 'HookAbortError'
  }
}

export interface HookPayload {
  event: HookEvent
  sessionUuid?: string
  [key: string]: unknown
}

interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export interface HookRunnerConfig {
  dataDir: string
  timeoutMs?: number
}

export class HookRunner {
  private readonly hooksDir: string
  private readonly logsDir: string
  private readonly timeoutMs: number

  constructor(config: HookRunnerConfig) {
    this.hooksDir = path.join(config.dataDir, 'hooks')
    this.logsDir = path.join(config.dataDir, 'logs')
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async discoverScripts(event: HookEvent): Promise<string[]> {
    const eventDir = path.join(this.hooksDir, event)
    const files = await listDir(eventDir)
    return files.sort().map(f => path.join(eventDir, f))
  }

  private buildCommand(scriptPath: string): [string, string[]] {
    const ext = path.extname(scriptPath).toLowerCase()
    if (ext === '.ts' || ext === '.mjs') {
      return ['node', ['--experimental-strip-types', scriptPath]]
    }
    return ['bash', [scriptPath]]
  }

  private runScript(scriptPath: string, payload: HookPayload): Promise<RunResult> {
    return new Promise(resolve => {
      const [cmd, args] = this.buildCommand(scriptPath)
      const start = Date.now()
      // detached=true puts child in its own process group so we can kill the whole tree
      const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true })

      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

      let killed = false
      const killGroup = (sig: NodeJS.Signals) => {
        try { process.kill(-child.pid!, sig) } catch {}
      }

      const timer = setTimeout(() => {
        killed = true
        killGroup('SIGTERM')
        setTimeout(() => killGroup('SIGKILL'), 500)
      }, this.timeoutMs)

      child.on('close', code => {
        clearTimeout(timer)
        resolve({
          exitCode: killed ? -1 : (code ?? -1),
          stdout,
          stderr,
          durationMs: Date.now() - start,
        })
      })

      child.stdin?.write(JSON.stringify(payload))
      child.stdin?.end()
      // unref so the process group doesn't keep Node alive if we abandon it
      child.unref()
    })
  }

  private async logInvocation(
    event: HookEvent,
    scriptPath: string,
    result: RunResult,
    sessionUuid?: string,
  ): Promise<void> {
    const date = new Date().toISOString().slice(0, 10)
    const logPath = path.join(this.logsDir, `hooks-${date}.jsonl`)
    await appendJsonl(logPath, {
      id: crypto.randomUUID(),
      event,
      scriptPath,
      sessionUuid,
      exitCode: result.exitCode,
      stderr: result.stderr,
      durationMs: result.durationMs,
      firedAt: new Date().toISOString(),
    })
  }

  async fire(event: HookEvent, payload: HookPayload): Promise<void> {
    const scripts = await this.discoverScripts(event)
    if (scripts.length === 0) return

    const isSync = SYNC_EVENTS.has(event)

    for (const scriptPath of scripts) {
      if (isSync) {
        const result = await this.runScript(scriptPath, payload)
        await this.logInvocation(event, scriptPath, result, payload.sessionUuid)
        if (result.exitCode !== 0) {
          throw new HookAbortError(scriptPath, result.exitCode, result.stderr)
        }
      } else {
        this.runScript(scriptPath, payload)
          .then(result => this.logInvocation(event, scriptPath, result, payload.sessionUuid))
          .catch(err => console.error(`[HookRunner] async hook error ${scriptPath}:`, err))
      }
    }
  }
}
