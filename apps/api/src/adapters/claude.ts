/**
 * Claude CLI adapter — interactive tmux (default) and headless.
 *
 * TMUX MODE (`useTmux !== false`): the original path. Interactive TUI in a
 * tmux window. CONSTRAINT: this path must NEVER use `claude -p` / `--print`
 * — buildArgv still asserts that.
 *
 * HEADLESS MODE (`useTmux === false`): one-shot `claude -p` child process.
 * The prompt goes in argv, the process runs the whole turn and exits.
 *
 * Transcript ownership: Claude CLI always writes its own JSONL to
 * `<CLAUDE_CONFIG_DIR>/projects/<mangled-cwd>/<session-uuid>.jsonl` in `-p`
 * mode exactly as it does interactively (verified on 2.1.266). That file is
 * the single source of truth — orchestron does NOT tee stdout into a second
 * transcript. stdout is still drained (an unread pipe would fill and wedge
 * the child) and the terminal `{"type":"result"}` event is picked out of it
 * for the final response, token usage and cost.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import type {
  AgentAdapter, SpawnConfig, ResumeConfig, TmuxHandle, HeadlessResult, TokenUsage,
} from '@agent-hq-orchestron/shared'
import { resolveUseTmux, ORCHESTRON_RESULT_SCHEMA_JSON } from '@agent-hq-orchestron/shared'
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

/** Claude's per-workspace directory name: the absolute cwd with every "/"
 *  replaced by "-" (leading dash kept). Persisted on the session record as
 *  `cwdSlug` so the transcript path can be rebuilt later without needing the
 *  project record — the project may have been edited or deleted by then. */
export function mangleCwd(workspace: string): string {
  return expandHome(workspace).replace(/\//g, '-')
}

export function claudeTranscriptPath(workspace: string, configDir: string | undefined, uuid: string): string {
  const baseDir = effectiveClaudeConfigDir(configDir)
  return path.join(baseDir, 'projects', mangleCwd(workspace), `${uuid}.jsonl`)
}

/** Rebuild a transcript path from the tuple persisted on a session record.
 *  Mirrors `claudeTranscriptPath` but takes the already-mangled slug, so it
 *  works for sessions whose workspace has since moved. */
export function claudeTranscriptPathFromSlug(configDir: string | undefined, cwdSlug: string, uuid: string): string {
  return path.join(effectiveClaudeConfigDir(configDir), 'projects', cwdSlug, `${uuid}.jsonl`)
}

/**
 * Best available transcript path for a Claude session record.
 *
 * `jsonlPath` recorded at spawn is authoritative and normally correct — this
 * only matters when it is empty (a spawn that died before the adapter filled
 * it in) or points somewhere the file no longer is. In those cases the
 * `configDir` + `cwdSlug` + `claudeSessionUuid` tuple on the record rebuilds
 * it without consulting the project, which may since have been edited or
 * deleted.
 *
 * Returns the recorded path unchanged when nothing better can be derived, so
 * callers get a consistent "the path we believe in" either way.
 */
export function resolveClaudeTranscriptPath(session: {
  jsonlPath?: string
  configDir?: string
  cwdSlug?: string
  claudeSessionUuid?: string
}, fileExists: (p: string) => boolean): string {
  if (session.jsonlPath && fileExists(session.jsonlPath)) return session.jsonlPath
  if (session.cwdSlug && session.claudeSessionUuid) {
    const rebuilt = claudeTranscriptPathFromSlug(session.configDir, session.cwdSlug, session.claudeSessionUuid)
    if (fileExists(rebuilt)) return rebuilt
  }
  return session.jsonlPath ?? ''
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

  // Auto-allow the 10 orchestron MCP tools so an agent under a managed
  // policy that overrides bypassPermissions (e.g. Nanovest Team plan's
  // `disableBypassPermissionsMode: "disable"`) doesn't freeze on every
  // spawn_session / note_set call waiting for approval. These tools all
  // route through the orchestron API which enforces its own guardrails
  // (rate limits, max children, depth, per-parent mutex) so first-party
  // orchestron trust is warranted; user-defined MCP servers stay gated.
  argv.push('--allowedTools', MCP_TOOLS_TMUX.join(','))

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

/** Orchestron MCP tools auto-allowed for interactive sessions. */
const MCP_TOOLS_TMUX = [
  'mcp__orchestron__spawn_session',
  'mcp__orchestron__wait_for_idle',
  'mcp__orchestron__send_input',
  'mcp__orchestron__get_status',
  'mcp__orchestron__read_transcript',
  'mcp__orchestron__list_projects',
  'mcp__orchestron__list_sessions',
  'mcp__orchestron__note_get',
  'mcp__orchestron__note_set',
  'mcp__orchestron__note_list',
]

/** Same list minus `wait_for_idle`. That tool blocks until a child session
 *  goes idle, which can be minutes — in a one-shot invocation there is no
 *  turn boundary to release it and no way to interrupt, so the whole
 *  headless run would hang on it. Async delegation (Phase 3) replaces it. */
const MCP_TOOLS_HEADLESS = MCP_TOOLS_TMUX.filter((t) => t !== 'mcp__orchestron__wait_for_idle')

/** Keep at most this many bytes of the child's stderr for `failureReason`.
 *  Enough for a stack trace or auth error, small enough to store on the
 *  session record. */
const STDERR_TAIL_BYTES = 8 * 1024

/** Build argv for a headless (`claude -p`) invocation. Unlike buildArgv the
 *  prompt travels in argv rather than through a tmux paste. */
export function buildHeadlessArgv(opts: {
  prompt: string
  model?: string
  effort?: string
  mcpConfigPath?: string
  /** Opt into the structured-output contract for this run. Claude's
   *  `--json-schema` takes the schema INLINE as a JSON string and errors on
   *  a path (`--json-schema is not valid JSON`), so the shared schema object
   *  is serialised here rather than read from `outputSchemaPath` — that
   *  field exists for Codex, whose flag does take a file. */
  structuredOutput?: boolean
  sessionMode: { type: 'new'; uuid: string } | { type: 'resume'; uuid: string }
}): string[] {
  // `--verbose` is required for `--output-format stream-json` under `-p`.
  const argv: string[] = ['claude', '-p', '--output-format', 'stream-json', '--verbose']

  if (opts.model) argv.push('--model', opts.model)
  if (opts.effort) argv.push('--effort', opts.effort)
  if (opts.mcpConfigPath) argv.push('--mcp-config', opts.mcpConfigPath)
  if (opts.structuredOutput) argv.push('--json-schema', ORCHESTRON_RESULT_SCHEMA_JSON)
  argv.push('--permission-mode', 'bypassPermissions')
  argv.push('--allowedTools', MCP_TOOLS_HEADLESS.join(','))

  if (opts.sessionMode.type === 'new') {
    // Pre-assign the id so the transcript path is known before the process
    // has written anything — no post-hoc directory scan needed.
    argv.push('--session-id', opts.sessionMode.uuid)
  } else {
    argv.push('--resume', opts.sessionMode.uuid)
  }

  // Prompt last, after `--`, so a prompt starting with "-" is not parsed
  // as a flag.
  argv.push('--', opts.prompt)
  return argv
}

/** CLAUDE_CONFIG_DIR override for a spawn, or undefined when the effective
 *  dir is the harness default.
 *
 *  Skip the env when it resolves to ~/.claude: Claude Code 2.x stores OAuth
 *  tokens in the macOS Keychain under a service name that HASHES the
 *  CLAUDE_CONFIG_DIR value, so `claude` bare (env unset) reads
 *  `Claude Code-credentials` while `CLAUDE_CONFIG_DIR=~/.claude claude`
 *  reads `Claude Code-credentials-<hash>`. Setting it explicitly when the
 *  value is already the default points at a keychain entry the user's
 *  interactive shell never authenticated, and the spawned claude re-prompts
 *  for OAuth. Leaving it inherited matches the interactive shell. */
export function buildClaudeEnv(configDir: string | undefined): NodeJS.ProcessEnv | undefined {
  const defaultDir = path.join(os.homedir(), '.claude')
  const expanded = configDir ? expandHome(configDir) : undefined
  return expanded && expanded !== defaultDir ? { CLAUDE_CONFIG_DIR: expanded } : undefined
}

/** Parse one line of `--output-format stream-json` output. Only the terminal
 *  `result` event carries what we need; everything else is ignored (the
 *  native JSONL already has it). */
function parseClaudeResultLine(line: string): Partial<HeadlessResult> | null {
  let ev: {
    type?: string
    subtype?: string
    is_error?: boolean
    result?: string
    session_id?: string
    total_cost_usd?: number
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  try { ev = JSON.parse(line) } catch { return null }
  if (ev.type !== 'result') return null

  const out: Partial<HeadlessResult> = {}
  if (typeof ev.result === 'string') out.finalResponse = ev.result
  if (ev.session_id) out.sessionId = ev.session_id
  if (typeof ev.total_cost_usd === 'number') out.costUsd = ev.total_cost_usd
  if (ev.usage) {
    const usage: TokenUsage = {
      input: ev.usage.input_tokens ?? 0,
      output: ev.usage.output_tokens ?? 0,
    }
    if (ev.usage.cache_read_input_tokens != null) usage.cacheRead = ev.usage.cache_read_input_tokens
    if (ev.usage.cache_creation_input_tokens != null) usage.cacheCreation = ev.usage.cache_creation_input_tokens
    out.tokenUsage = usage
  }
  return out
}

/** A live headless child plus the promise that settles on its exit.
 *  The promise is built at spawn time, so a late `awaitHeadlessExit` still
 *  observes the real exit code instead of racing an already-fired event. */
interface HeadlessProc {
  proc: ChildProcess
  exit: Promise<HeadlessResult>
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude'

  /** Live headless children, keyed by the synthetic handle name. An entry
   *  survives the child's exit so a late `awaitHeadlessExit` still sees the
   *  real result; it is removed once that result has been handed over (or
   *  on kill). Bounded by the session pool cap. */
  private readonly headless = new Map<string, HeadlessProc>()

  async spawn(config: SpawnConfig): Promise<TmuxHandle> {
    // `?? true` — a spawn payload without the field is a tmux spawn.
    if (!resolveUseTmux(config.useTmux)) return this.spawnHeadless(config)

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
    // See buildClaudeEnv for why the default dir is left inherited.
    const env = buildClaudeEnv(config.configDir)

    const [cmd, ...args] = argv
    await tmux.newSession(tmuxName, [cmd!, ...args], config.workspace, env)

    return { tmuxName, claudeUuid, jsonlPath }
  }

  /**
   * Headless spawn: one-shot `claude -p`. The prompt is in argv, so the run
   * starts immediately and needs no TUI-ready wait and no paste.
   *
   * The session id is pre-assigned via `--session-id`, which makes the
   * native JSONL path fully known up front — the caller can tail it right
   * away, exactly as it does for a tmux session.
   */
  private spawnHeadless(config: SpawnConfig): TmuxHandle {
    const claudeUuid = crypto.randomUUID()
    const handleName = `headless-${claudeUuid.slice(0, 8)}`
    const jsonlPath = claudeTranscriptPath(config.workspace, config.configDir, claudeUuid)

    const argv = buildHeadlessArgv({
      prompt: config.initialPrompt,
      model: config.model,
      effort: config.effort,
      mcpConfigPath: config.mcpConfigPath,
      structuredOutput: !!config.outputSchemaPath,
      sessionMode: { type: 'new', uuid: claudeUuid },
    })

    const handle: TmuxHandle = { tmuxName: handleName, claudeUuid, jsonlPath, headless: true }
    this.startHeadless(handle, argv, config.workspace, config.configDir)
    return handle
  }

  /** Launch the child and register the promise that resolves on its exit.
   *  Shared by spawnHeadless and (future) headless resume. */
  private startHeadless(
    handle: TmuxHandle,
    argv: string[],
    workspace: string,
    configDir: string | undefined,
  ): void {
    const [cmd, ...args] = argv
    // Headless inherits the full environment (unlike tmux, which gets only
    // overrides via `-e`) — the child needs PATH, HOME and the rest.
    const override = buildClaudeEnv(configDir)
    const proc = spawnProcess(cmd!, args, {
      cwd: expandHome(workspace),
      env: override ? { ...process.env, ...override } : process.env,
      // stdin closed: `-p` must not sit waiting on it. stdout/stderr piped
      // and drained below — an unread pipe fills at ~64KB and wedges the child.
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const exit = new Promise<HeadlessResult>((resolve) => {
      const collected: Partial<HeadlessResult> = {}
      let stdoutTail = ''
      let stderrTail = ''

      proc.stdout?.setEncoding('utf8')
      proc.stdout?.on('data', (chunk: string) => {
        // stream-json is newline-delimited; keep the trailing partial line.
        stdoutTail += chunk
        const lines = stdoutTail.split('\n')
        stdoutTail = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          const parsed = parseClaudeResultLine(line)
          if (parsed) Object.assign(collected, parsed)
        }
      })
      proc.stderr?.setEncoding('utf8')
      proc.stderr?.on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
      })

      const settle = (exitCode: number | null) => {
        // Flush a final line that arrived without a trailing newline.
        if (stdoutTail.trim()) {
          const parsed = parseClaudeResultLine(stdoutTail)
          if (parsed) Object.assign(collected, parsed)
        }
        resolve({ ...collected, exitCode, stderr: stderrTail.trim() || undefined })
      }

      proc.on('close', (code) => settle(code))
      // spawn failure (ENOENT etc) never emits 'close' — resolve with the
      // reason as stderr so the session surfaces something actionable.
      proc.on('error', (err) => {
        stderrTail = (stderrTail + `\n${err.message}`).slice(-STDERR_TAIL_BYTES)
        settle(null)
      })
    })

    this.headless.set(handle.tmuxName, { proc, exit })
  }

  /**
   * One headless turn against an existing conversation: `claude -p --resume`.
   *
   * This is both the multi-turn send path and the cross-mode reopen path —
   * `-p --resume <uuid>` and interactive `--resume <uuid>` read the same
   * JSONL store, so a session started either way can continue as the other
   * (verified on 2.1.266; see scratchpad/headless-phase2-verification.md).
   *
   * The session id does NOT change: Claude appends to the same
   * `<uuid>.jsonl`, so `claudeUuid`, `jsonlPath` and `cwdSlug` on the record
   * stay valid across every turn and the transcript tailer never has to
   * re-point. Only the handle name is fresh, so each turn's child has its own
   * key in the registry and a kill aimed at turn N cannot reap turn N+1.
   */
  private resumeHeadless(sessionUuid: string, config: ResumeConfig): TmuxHandle {
    if (!config.prompt) {
      throw new Error('Headless resume needs a prompt — a `claude -p` invocation has nothing to run without one')
    }
    const handleName = `headless-${sessionUuid.slice(0, 8)}-${crypto.randomBytes(3).toString('hex')}`
    const argv = buildHeadlessArgv({
      prompt: config.prompt,
      model: config.model,
      effort: config.effort,
      mcpConfigPath: config.mcpConfigPath,
      structuredOutput: !!config.outputSchemaPath,
      sessionMode: { type: 'resume', uuid: sessionUuid },
    })

    const handle: TmuxHandle = {
      tmuxName: handleName,
      claudeUuid: sessionUuid,
      jsonlPath: claudeTranscriptPath(config.workspace, config.configDir, sessionUuid),
      headless: true,
    }
    this.startHeadless(handle, argv, config.workspace, config.configDir)
    return handle
  }

  /** Resolve when the headless child for `handle` exits. Safe to call at any
   *  time — the promise was created at spawn, so it does not race the exit.
   *  Returns `{ exitCode: null }` for an unknown handle (already consumed,
   *  or an API restart lost the in-memory registry). */
  async awaitHeadlessExit(handle: TmuxHandle): Promise<HeadlessResult> {
    const entry = this.headless.get(handle.tmuxName)
    if (!entry) return { exitCode: null }
    const result = await entry.exit
    this.headless.delete(handle.tmuxName)
    return result
  }

  async resume(sessionUuid: string, config: ResumeConfig): Promise<TmuxHandle> {
    // `?? true` — a resume config without the field resumes into tmux.
    if (!resolveUseTmux(config.useTmux)) return this.resumeHeadless(sessionUuid, config)

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
    // See buildClaudeEnv for why the default dir is left inherited.
    const env = buildClaudeEnv(config.configDir)

    const [cmd, ...args] = argv
    await tmux.newSession(tmuxName, [cmd!, ...args], config.workspace, env)

    return { tmuxName, claudeUuid: sessionUuid, jsonlPath }
  }

  async waitTuiReady(handle: TmuxHandle, timeoutMs: number): Promise<void> {
    // Headless has no TUI and no interstitials — `-p` skips the trust dialog.
    if (handle.headless) return
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
    if (handle.headless) {
      // A headless turn carries its prompt in argv; there is no live process
      // to paste into. Follow-up turns go through `resume({useTmux: false,
      // prompt})`, which starts a fresh child — session-manager routes them
      // there, so reaching here is a bug in a caller, not a user action.
      throw new Error('Headless turns take their prompt in argv — use resume({ useTmux: false, prompt }) for a follow-up turn')
    }
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
    if (handle.headless) {
      const entry = this.headless.get(handle.tmuxName)
      if (entry) {
        // SIGTERM lets claude flush its JSONL; the exit promise settles from
        // the resulting 'close'. Dropping the entry here is safe because
        // whoever awaits it already holds the promise.
        entry.proc.kill('SIGTERM')
        this.headless.delete(handle.tmuxName)
      }
      return
    }
    await tmux.killSession(handle.tmuxName)
  }
}
