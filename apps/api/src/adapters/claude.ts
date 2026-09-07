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
// Dismissable interstitials (checkboxes, wizards, "Teach auto mode?" etc) —
// Any pane that offers "Esc to cancel" is a modal we can Esc out of safely.
const ESC_DISMISS_RE = /Esc to cancel|esc to (cancel|dismiss|close)/

/**
 * Compute the actual JSONL transcript path Claude CLI writes to.
 *
 * Claude convention: `<CLAUDE_CONFIG_DIR>/projects/<mangled-cwd>/<session-uuid>.jsonl`
 * Where <mangled-cwd> replaces "/" with "-", keeping leading "-".
 *
 * Example: cwd=/home/scriberion, configDir=/home/scriberion/ClaudeConfigs/adi.novriansyah
 * → /home/scriberion/ClaudeConfigs/adi.novriansyah/projects/-home-scriberion/<uuid>.jsonl
 */
function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  if (p === '~') return os.homedir()
  return p
}

/** Effective Claude config dir — falls back to the CLAUDE_CONFIG_DIR env
 *  var before defaulting to ~/.claude, matching Claude CLI's own resolution.
 *  Exported so session-manager can persist it in SessionMetadata at spawn
 *  time and reuse the same value for wake-up / reopen / clone. */
export function effectiveClaudeConfigDir(explicit?: string): string {
  return expandHome(explicit ?? process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude'))
}

export function claudeTranscriptPath(workspace: string, configDir: string | undefined, uuid: string): string {
  const baseDir = effectiveClaudeConfigDir(configDir)
  const mangled = expandHome(workspace).replace(/\//g, '-')
  return path.join(baseDir, 'projects', mangled, `${uuid}.jsonl`)
}

function buildArgv(opts: {
  model?: string
  effort?: string
  configDir?: string
  mcpConfigPath?: string
  sessionMode: { type: 'new'; uuid: string } | { type: 'resume'; uuid: string }
}): string[] {
  const argv: string[] = ['claude']

  if (opts.configDir) {
    // passed via env CLAUDE_CONFIG_DIR, not argv — but still verify no forbidden flags
  }

  if (opts.model) argv.push('--model', opts.model)
  if (opts.effort) argv.push('--effort', opts.effort)
  if (opts.mcpConfigPath) argv.push('--mcp-config', opts.mcpConfigPath)
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
      effort: config.effort,
      configDir: config.configDir,
      mcpConfigPath: config.mcpConfigPath,
      sessionMode: { type: 'new', uuid: claudeUuid },
    })

    // Only pass override vars, not full process.env — tmux -e sets these.
    //
    // Skip CLAUDE_CONFIG_DIR when it resolves to the harness default
    // (~/.claude). Claude Code 2.x stores OAuth tokens in macOS Keychain
    // under a service name that HASHES the CLAUDE_CONFIG_DIR value —
    // `claude` bare (env unset) reads `Claude Code-credentials`, while
    // `CLAUDE_CONFIG_DIR=~/.claude claude` reads `Claude Code-credentials-
    // <hash-of-path>`. Passing the env explicitly when the value is
    // already the default forces a different keychain entry than the one
    // the user's interactive shell authenticated, so orchestron-spawned
    // claude re-prompts for OAuth. Match the interactive shell's behavior
    // by leaving env inherited when configDir === default.
    const defaultDir = path.join(os.homedir(), '.claude')
    const expandedConfigDir = config.configDir ? expandHome(config.configDir) : undefined
    const env: NodeJS.ProcessEnv | undefined =
      expandedConfigDir && expandedConfigDir !== defaultDir
        ? { CLAUDE_CONFIG_DIR: expandedConfigDir }
        : undefined

    const [cmd, ...args] = argv
    await tmux.newSession(tmuxName, [cmd!, ...args], config.workspace, env)

    return { tmuxName, claudeUuid, jsonlPath }
  }

  async resume(sessionUuid: string, config: ResumeConfig): Promise<TmuxHandle> {
    // Use a fresh random suffix so re-opening the same session multiple times
    // doesn't collide on the tmux name (previous impl appended '-resume' which
    // wasn't unique across reopens).
    const tmuxName = `orchestron-${sessionUuid.slice(0, 8)}-${crypto.randomBytes(3).toString('hex')}`
    // Claude writes the resumed transcript back to its ORIGINAL JSONL path
    // (same UUID, same mangled cwd) — reuse claudeTranscriptPath so the
    // orchestron tailer + metrics find the same file.
    const jsonlPath = claudeTranscriptPath(config.workspace, config.configDir, sessionUuid)

    const argv = buildArgv({
      model: config.model,
      effort: config.effort,
      configDir: config.configDir,
      mcpConfigPath: config.mcpConfigPath,
      sessionMode: { type: 'resume', uuid: sessionUuid },
    })

    // Only pass override vars, not full process.env — tmux -e sets these.
    //
    // Skip CLAUDE_CONFIG_DIR when it resolves to the harness default
    // (~/.claude). Claude Code 2.x stores OAuth tokens in macOS Keychain
    // under a service name that HASHES the CLAUDE_CONFIG_DIR value —
    // `claude` bare (env unset) reads `Claude Code-credentials`, while
    // `CLAUDE_CONFIG_DIR=~/.claude claude` reads `Claude Code-credentials-
    // <hash-of-path>`. Passing the env explicitly when the value is
    // already the default forces a different keychain entry than the one
    // the user's interactive shell authenticated, so orchestron-spawned
    // claude re-prompts for OAuth. Match the interactive shell's behavior
    // by leaving env inherited when configDir === default.
    const defaultDir = path.join(os.homedir(), '.claude')
    const expandedConfigDir = config.configDir ? expandHome(config.configDir) : undefined
    const env: NodeJS.ProcessEnv | undefined =
      expandedConfigDir && expandedConfigDir !== defaultDir
        ? { CLAUDE_CONFIG_DIR: expandedConfigDir }
        : undefined

    const [cmd, ...args] = argv
    await tmux.newSession(tmuxName, [cmd!, ...args], config.workspace, env)

    return { tmuxName, claudeUuid: sessionUuid, jsonlPath }
  }

  async waitTuiReady(handle: TmuxHandle, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let lastDismissAt = 0
    while (Date.now() < deadline) {
      const pane = await tmux.capturePane(handle.tmuxName)

      // Order matters: dismiss interstitials FIRST, then check ready.
      // Status bar (TUI_READY_RE) can render while interstitial still overlays input.
      const hasTrust = TRUST_PROMPT_RE.test(pane)
      const hasMenu = MENU_INTERSTITIAL_RE.test(pane)
      const hasEscDismissable = ESC_DISMISS_RE.test(pane)
      const canDismiss = Date.now() - lastDismissAt > 1500

      if (hasTrust && canDismiss) {
        // Default cursor on "No, exit" — Down to "Yes, I trust", then Enter
        await tmux.sendKeys(handle.tmuxName, 'Down')
        await new Promise<void>((resolve) => setTimeout(resolve, 300))
        await tmux.sendKeys(handle.tmuxName, 'Enter')
        lastDismissAt = Date.now()
      } else if (hasMenu && canDismiss) {
        // Numbered menu (theme picker, "Teach auto mode?" etc) — Enter accepts default
        await tmux.sendKeys(handle.tmuxName, 'Enter')
        lastDismissAt = Date.now()
      } else if (hasEscDismissable && canDismiss) {
        // Checkbox wizard / dismissable modal — Esc closes it
        await tmux.sendKeys(handle.tmuxName, 'Escape')
        lastDismissAt = Date.now()
      } else if (TUI_READY_RE.test(pane) && !hasTrust && !hasMenu && !hasEscDismissable) {
        // Only mark ready if NO interstitial still present
        return
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 400))
    }
    throw new Error(`waitTuiReady timeout after ${timeoutMs}ms for session ${handle.tmuxName}`)
  }

  async sendPrompt(handle: TmuxHandle, prompt: string): Promise<void> {
    await tmux.setBuffer(handle.tmuxName, prompt)
    await tmux.pasteBuffer(handle.tmuxName)

    // Wait for the paste to actually appear in the input line, then wait a
    // beat more for the TUI to settle (welcome banners, MCP-auth warnings)
    // before pressing Enter. Otherwise Enter races the paste or gets
    // consumed by a still-settling banner and the prompt sits stuck.
    const marker = prompt.trim().slice(0, 40)
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      const pane = await tmux.capturePane(handle.tmuxName)
      if (marker && pane.includes(marker)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    // Small settle delay after paste is visible — TUI may still be
    // absorbing the paste-buffer redraw.
    await new Promise((r) => setTimeout(r, 250))
    await tmux.sendKeys(handle.tmuxName, 'Enter')
  }

  async kill(handle: TmuxHandle): Promise<void> {
    await tmux.killSession(handle.tmuxName)
  }
}
