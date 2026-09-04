/**
 * Claude CLI adapter — interactive tmux mode.
 *
 * CONSTRAINT: NEVER use `claude -p` or `--print`. Interactive tmux uses subscription quota.
 */
import crypto from 'node:crypto'
import type { AgentAdapter, SpawnConfig, ResumeConfig, TmuxHandle } from '@agent-hq-orchestron/shared'
import * as tmux from './tmux.js'

const FORBIDDEN_FLAGS = new Set(['-p', '--print'])
const TUI_READY_RE = /❯|│\s*>|\?\s+for shortcuts/

function buildArgv(opts: {
  model?: string
  configDir?: string
  sessionMode: { type: 'new'; uuid: string } | { type: 'resume'; uuid: string }
}): string[] {
  const argv: string[] = ['claude']

  if (opts.configDir) {
    // passed via env CLAUDE_CONFIG_DIR, not argv — but still verify no forbidden flags
  }

  if (opts.model) argv.push('--model', opts.model)
  argv.push('--permission-mode', 'bypassPermissions')

  if (opts.sessionMode.type === 'new') {
    argv.push('--session-id', opts.sessionMode.uuid)
  } else {
    argv.push('--resume', opts.sessionMode.uuid)
  }

  for (const flag of argv) {
    if (FORBIDDEN_FLAGS.has(flag)) {
      throw new Error(`Forbidden flag in argv: ${flag}. Claude adapter must not use -p/--print.`)
    }
  }

  return argv
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude'

  async spawn(config: SpawnConfig): Promise<TmuxHandle> {
    const claudeUuid = crypto.randomUUID()
    const tmuxName = `orchestron-${claudeUuid.slice(0, 8)}`
    const jsonlPath = `${config.workspace}/.orchestron/sessions/${claudeUuid}.jsonl`

    const argv = buildArgv({
      model: config.model,
      configDir: config.configDir,
      sessionMode: { type: 'new', uuid: claudeUuid },
    })

    const env = config.configDir
      ? { ...process.env, CLAUDE_CONFIG_DIR: config.configDir }
      : undefined

    const [cmd, ...args] = argv
    await tmux.newSession(tmuxName, [cmd!, ...args], config.workspace, env)

    return { tmuxName, claudeUuid, jsonlPath }
  }

  async resume(sessionUuid: string, config: ResumeConfig): Promise<TmuxHandle> {
    const tmuxName = `orchestron-${sessionUuid.slice(0, 8)}-resume`
    const jsonlPath = `${config.workspace}/.orchestron/sessions/${sessionUuid}.jsonl`

    const argv = buildArgv({
      model: config.model,
      configDir: config.configDir,
      sessionMode: { type: 'resume', uuid: sessionUuid },
    })

    const env = config.configDir
      ? { ...process.env, CLAUDE_CONFIG_DIR: config.configDir }
      : undefined

    const [cmd, ...args] = argv
    await tmux.newSession(tmuxName, [cmd!, ...args], config.workspace, env)

    return { tmuxName, claudeUuid: sessionUuid, jsonlPath }
  }

  async waitTuiReady(handle: TmuxHandle, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const pane = await tmux.capturePane(handle.tmuxName)
      if (TUI_READY_RE.test(pane)) return
      await new Promise<void>((resolve) => setTimeout(resolve, 200))
    }
    throw new Error(`waitTuiReady timeout after ${timeoutMs}ms for session ${handle.tmuxName}`)
  }

  async sendPrompt(handle: TmuxHandle, prompt: string): Promise<void> {
    await tmux.setBuffer(handle.tmuxName, prompt)
    await tmux.pasteBuffer(handle.tmuxName)
    await tmux.sendKeys(handle.tmuxName, 'Enter')
  }

  async kill(handle: TmuxHandle): Promise<void> {
    await tmux.killSession(handle.tmuxName)
  }
}
