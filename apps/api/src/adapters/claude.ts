/**
 * Claude CLI adapter — interactive tmux mode.
 *
 * CONSTRAINT: NEVER use `claude -p` or `--print`. Interactive tmux uses subscription quota.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import type { AgentAdapter, SpawnConfig, ResumeConfig, TmuxHandle } from '@agent-hq-orchestron/shared'
import * as tmux from './tmux.js'

const FORBIDDEN_FLAGS = new Set(['-p', '--print'])
// Real prompt marker (post-interstitials): status bar with model/version or shortcuts hint
const TUI_READY_RE = /v[0-9]+\.[0-9]+\.[0-9]+ │|\?\s+for shortcuts/
// Trust folder interstitial (default cursor on "No, exit" — need Down + Enter to accept)
const TRUST_PROMPT_RE = /Is this a project you|Yes, I trust this folder/
// Numbered menu interstitial (theme picker etc — Enter accepts default)
const MENU_INTERSTITIAL_RE = /❯\s*[0-9]+\./

/**
 * Compute the actual JSONL transcript path Claude CLI writes to.
 *
 * Claude convention: `<CLAUDE_CONFIG_DIR>/projects/<mangled-cwd>/<session-uuid>.jsonl`
 * Where <mangled-cwd> replaces "/" with "-", keeping leading "-".
 *
 * Example: cwd=/home/scriberion, configDir=/home/scriberion/ClaudeConfigs/adi.novriansyah
 * → /home/scriberion/ClaudeConfigs/adi.novriansyah/projects/-home-scriberion/<uuid>.jsonl
 */
function claudeTranscriptPath(workspace: string, configDir: string | undefined, uuid: string): string {
  const baseDir = configDir ?? path.join(os.homedir(), '.claude')
  const mangled = workspace.replace(/\//g, '-')
  return path.join(baseDir, 'projects', mangled, `${uuid}.jsonl`)
}

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
    const jsonlPath = claudeTranscriptPath(config.workspace, config.configDir, claudeUuid)

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
    let trustDismissedAt = 0
    while (Date.now() < deadline) {
      const pane = await tmux.capturePane(handle.tmuxName)
      if (TUI_READY_RE.test(pane)) return

      // Trust folder prompt — default cursor on "No, exit", need Down then Enter
      if (TRUST_PROMPT_RE.test(pane) && Date.now() - trustDismissedAt > 2000) {
        await tmux.sendKeys(handle.tmuxName, 'Down')
        await new Promise<void>((resolve) => setTimeout(resolve, 300))
        await tmux.sendKeys(handle.tmuxName, 'Enter')
        trustDismissedAt = Date.now()
      } else if (MENU_INTERSTITIAL_RE.test(pane)) {
        // Numbered menu (theme picker etc) — Enter accepts default
        await tmux.sendKeys(handle.tmuxName, 'Enter')
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 400))
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
