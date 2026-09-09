import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { writeJson, readJson, listDir } from '@agent-hq-orchestron/file-store'
import type { SessionMetadata, SessionStatus, SpawnConfig, TmuxHandle, HeadlessResult } from '@agent-hq-orchestron/shared'
import {
  resolveUseTmux,
  parseHeadlessResultDocument,
  DEFAULT_HEADLESS_STRUCTURED_OUTPUT,
  ORCHESTRON_RESULT_SCHEMA_FILENAME,
  ORCHESTRON_RESULT_SCHEMA_JSON,
} from '@agent-hq-orchestron/shared'
import type { AdapterRegistry } from '../adapters/registry.js'
import { TranscriptTailer } from '../streaming/transcript-tailer.js'

/** Poll SQLite thread_history for a new thread_id written after afterMs. */
async function captureCodexThreadId(codexHome: string | undefined, afterMs: number, timeoutMs = 20_000): Promise<string> {
  const base = codexHome && codexHome !== '~'
    ? (codexHome.startsWith('~/') ? path.join(os.homedir(), codexHome.slice(2)) : codexHome)
    : path.join(os.homedir(), '.codex')
  const dbPath = path.join(base, 'thread_history_1.sqlite')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true })
      db.pragma('journal_mode = WAL')
      const row = db.prepare(
        'SELECT thread_id FROM thread_items WHERE created_at_ms > ? ORDER BY created_at_ms DESC LIMIT 1'
      ).get(afterMs) as { thread_id: string } | undefined
      db.close()
      if (row?.thread_id) return row.thread_id
    } catch { /* DB not yet created — keep polling */ }
    await new Promise((r) => setTimeout(r, 400))
  }
  return ''
}

/** Rebuild an adapter handle from a persisted session record.
 *
 *  `headless` MUST be derived through resolveUseTmux: records written before
 *  the toggle existed have no `useTmux` field, and they are all tmux
 *  sessions. Getting it wrong here sends a tmux kill at a headless handle
 *  (or vice versa) and the process is never reaped. */
function handleFor(session: SessionMetadata): TmuxHandle {
  return {
    tmuxName: session.tmuxName,
    claudeUuid: session.claudeSessionUuid,
    jsonlPath: session.jsonlPath,
    headless: !resolveUseTmux(session.useTmux),
  }
}

export class PoolFullError extends Error {
  constructor(max: number) {
    super(`Session pool is full (max ${max} concurrent sessions)`)
    this.name = 'PoolFullError'
  }
}

export class InvalidTransitionError extends Error {
  constructor(from: SessionStatus, to: SessionStatus) {
    super(`Invalid state transition: ${from} → ${to}`)
    this.name = 'InvalidTransitionError'
  }
}

// Legal transitions — tycho-inspired lifecycle
const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  // 'running' direct from 'spawning' is the headless path: the child process
  // starts the turn the moment it launches (prompt is in argv), so there is
  // no 'waiting' phase — nothing to wait for and no prompt left to paste.
  spawning: ['waiting', 'running', 'failed', 'killed'],
  waiting: ['running', 'killed'],
  // 'running' → 'failed' is likewise headless: a non-zero exit is a real
  // failure with no idle state in between. Harmless for tmux, which simply
  // never takes it.
  running: ['running', 'idle', 'needs_input', 'succeeded', 'failed', 'killed'],
  idle: ['running', 'needs_input', 'sleeping', 'succeeded', 'killed'],
  needs_input: ['running', 'idle', 'sleeping', 'succeeded', 'killed'],
  sleeping: ['spawning', 'succeeded', 'killed'],   // wake → spawning; archive → succeeded; kill remains legal
  // Terminal states allow → 'spawning' for in-place respawn (fresh Claude
  // conversation using the same orchestron session id). No other exits.
  succeeded: ['spawning'],
  failed: ['spawning'],
  killed: ['spawning'],
}

// Detect whether an assistant text is soliciting user input (question).
// Cheap heuristic: ends with `?`, or contains typical question phrases.
const QUESTION_PHRASES = [
  /\?\s*$/,                         // ends with ?
  /would you like/i,
  /do you want/i,
  /should i /i,
  /which (one|do you|would)/i,
  /let me know/i,
  /please (tell|specify|confirm|clarify|choose)/i,
  /what (do you|would|should)/i,
  /any (specific|preference|thoughts)/i,
  /shall i/i,
  /could you (tell|specify|clarify|share)/i,
]
/** Drop a model when it looks like it belongs to a different harness — e.g.
 *  a project's defaultModel `claude-sonnet-5` accidentally passed to a codex
 *  spawn. Adapter's own default is safer than a rejection at spawn time. */
function filterModelForHarness(model: string | undefined, agentType: import('@agent-hq-orchestron/shared').AgentType): string | undefined {
  if (!model) return undefined
  const isClaudeModel = /^claude[-_]/i.test(model)
  const isGptModel = /^gpt[-_]/i.test(model)
  const isCodexAstra = /^(codex|astra)/i.test(model)
  if (agentType === 'claude' && (isGptModel || isCodexAstra)) return undefined
  if (agentType === 'codex' && isClaudeModel) return undefined
  return model
}

function textAsksQuestion(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return QUESTION_PHRASES.some((re) => re.test(t))
}

/** Scan /proc for a running claude / codex process that has the given
 *  harness session id somewhere in its argv (i.e. an active `--resume <uuid>`,
 *  `--session-id <uuid>`, or `codex resume <uuid>` invocation). Returns the
 *  first match found so adopt() can refuse to spawn a second tmux against
 *  the same JSONL/rollout — a second writer races the first and corrupts
 *  the transcript.
 *
 *  Linux-only via /proc (matches the rest of the orchestron deploy target).
 *  Errors reading individual /proc/<pid>/cmdline entries are swallowed so a
 *  short-lived process disappearing mid-scan doesn't abort the whole check.
 */
async function findLiveHarnessProcess(harnessSessionId: string): Promise<{ pid: number; cmd: string } | null> {
  const { readdir, readFile } = await import('node:fs/promises')
  let pids: string[]
  try {
    pids = (await readdir('/proc')).filter((n) => /^\d+$/.test(n))
  } catch { return null }
  for (const pid of pids) {
    let raw: string
    try {
      raw = await readFile(`/proc/${pid}/cmdline`, 'utf8')
    } catch { continue }
    if (!raw.includes(harnessSessionId)) continue
    // cmdline is NUL-separated. First arg is executable path (or basename).
    const argv = raw.split('\0').filter(Boolean)
    if (argv.length === 0) continue
    const bin = (argv[0] ?? '').split('/').pop() ?? ''
    // Match direct `claude`/`codex` invocations AND node-launched wrappers
    // (Claude CLI is a Node script — appears as `node .../claude.mjs`).
    const looksHarness =
      bin === 'claude' || bin === 'codex' ||
      argv.some((a) => /(?:^|\/)(claude|codex)(?:\.mjs|\.js)?$/i.test(a))
    if (!looksHarness) continue
    return { pid: Number.parseInt(pid, 10), cmd: argv.join(' ') }
  }
  return null
}

/** Read the first user-role message content from a Claude JSONL transcript
 *  file. Used by adopt() to populate initialPrompt so the dashboard has a
 *  meaningful title for an imported session. Returns null when the file
 *  has no user event yet (rare — usually the file exists only after the
 *  very first prompt is written). */
function readFirstUserPromptFromJsonl(jsonlPath: string): string | null {
  try {
    const raw = fs.readFileSync(jsonlPath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const d = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } }
        if (d.type !== 'user' && d.message?.role !== 'user') continue
        const content = d.message?.content
        if (typeof content === 'string') return content.slice(0, 500)
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object' && 'type' in block && (block as { type?: string }).type === 'text') {
              const text = (block as { text?: string }).text
              if (typeof text === 'string' && text.trim()) return text.slice(0, 500)
            }
          }
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* file unreadable */ }
  return null
}

/** Read the first real user message from codex thread_history_1.sqlite.
 *  Used when a codex session is TUI-only (no rollout jsonl on disk).
 *  item_type='userMessage' rows carry `{content: [{type:'text', text:'...'}]}`.
 *  Returns null if no userMessage found. */
function readFirstUserPromptFromCodexSqlite(dbPath: string, threadId: string): string | null {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const row = db.prepare(
      `SELECT item_json FROM thread_items WHERE thread_id = ? AND item_type = 'userMessage' ORDER BY rowid ASC LIMIT 1`,
    ).get(threadId) as { item_json?: string } | undefined
    db.close()
    if (!row?.item_json) return null
    const parsed = JSON.parse(row.item_json) as { content?: Array<{ type?: string; text?: string }> }
    for (const block of parsed.content ?? []) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        return block.text.slice(0, 500)
      }
    }
  } catch { /* SQLite unreadable / thread absent */ }
  return null
}

/** Same as readFirstUserPromptFromJsonl but for codex rollout jsonl, which
 *  has a totally different schema: top-level {type: 'response_item', payload:
 *  {type: 'message', role: 'user'|'developer'|'assistant', content: [{type:
 *  'input_text', text: '...'}]}}. The FIRST user-role message is always the
 *  CLI-injected <environment_context> block (and other wrapper roles emit
 *  <skills_instructions>, <user_instructions>) — those need to be skipped
 *  so the returned string is what the human actually typed first. */
function readFirstUserPromptFromCodexRollout(jsonlPath: string): string | null {
  const WRAPPER_TAGS = ['environment_context', 'skills_instructions', 'user_instructions']
  const looksInjectedWrapper = (t: string): boolean => {
    const trimmed = t.trim()
    if (!trimmed.startsWith('<')) return false
    return WRAPPER_TAGS.some((tag) => trimmed.includes(`</${tag}>`) || trimmed.startsWith(`<${tag}>`) || trimmed.startsWith(`<${tag}`))
  }
  try {
    const raw = fs.readFileSync(jsonlPath, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const d = JSON.parse(line) as { type?: string; payload?: { type?: string; role?: string; content?: unknown } }
        if (d.type !== 'response_item') continue
        const p = d.payload
        if (!p || p.type !== 'message' || p.role !== 'user') continue
        const content = p.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          const b = block as { type?: string; text?: string }
          // Codex uses type: 'input_text' for user-typed content
          if ((b.type === 'input_text' || b.type === 'text') && typeof b.text === 'string') {
            const t = b.text.trim()
            if (!t) continue
            if (looksInjectedWrapper(t)) continue
            return t.slice(0, 500)
          }
        }
      } catch { /* skip malformed line */ }
    }
  } catch { /* file unreadable */ }
  return null
}

const MODAL_FOOTER_RE = /(↑\/↓|▲\/▼)\s+to\s+navigate/
const MODAL_SELECT_RE = /Enter\s+to\s+select/
// Numbered option lines in the modal: "❯ 1. Yes", "  2. No", …
// Leading char varies (❯ / ● / space). We accept any single non-digit char.
const OPTION_LINE_RE = /^\s*(?:[❯●▶>▷◈]?\s*)?(\d+)\.\s+(.+?)\s*$/
// Modal top marker — the checkbox header line above the title.
const MODAL_HEADER_RE = /^\s*☐\s+(.+?)\s*$/
const SEPARATOR_RE = /^[─━=—-]{3,}$/
const PERMISSION_HINT_RE = /(Do\s+you\s+want\s+to\s+proceed\??|Do\s+you\s+want\s+to\s+allow)/i

/** Parse a captured tmux pane into a PendingPrompt when the Claude selector
 *  modal (AskUserQuestion or permission approval) is currently displayed.
 *  Returns null when no modal is present.
 *
 *  Modal structure (both AskUserQuestion and permission approval):
 *    ☐ <header>          <- top boundary
 *
 *    <title (may end with ?)>
 *    [<detail lines>]    <- e.g. Bash command being approved
 *
 *    ❯ 1. <option>
 *         <description>  <- optional indented continuation
 *      2. <option>
 *      ...
 *      N. Type something.
 *    ─────               <- Claude splits built-in extras below a separator
 *      N+1. Chat about this
 *
 *    Enter to select · ↑/↓ to navigate · Esc to cancel   <- footer
 */
/** MCP tool-approval modal has a different shape than the native
 *  Claude tool-approval modal — no ☐ header, no "↑/↓ to navigate" /
 *  "Enter to select" footer. Instead:
 *
 *      About the <server> — <ToolName> Tool:
 *      │ description lines... │
 *      (ctrl+o to expand description)
 *
 *       Do you want to proceed?
 *       ❯ 1. Yes
 *         2. No
 *
 *       Esc to cancel · Tab to amend
 *
 *  Detected by "Do you want to proceed?" + "Esc to cancel" + a MCP
 *  header line. Options parsed with the same OPTION_LINE_RE (❯ 1. Yes /
 *  2. No matches). Kicks in on top of the native selector detector
 *  below so both modal families surface as PendingPromptBanner. */
const MCP_MODAL_HEADER_RE = /^\s*About\s+the\s+(\S+)\s+[—–-]\s+(.+?)\s+Tool:\s*$/i
const MCP_MODAL_QUESTION_RE = /Do\s+you\s+want\s+to\s+proceed\??/i
const MCP_MODAL_FOOTER_RE = /Esc\s+to\s+cancel(?:.*Tab\s+to\s+amend)?/i

function parseMcpToolModal(pane: string): import('@agent-hq-orchestron/shared').PendingPrompt | null {
  if (!MCP_MODAL_QUESTION_RE.test(pane) || !MCP_MODAL_FOOTER_RE.test(pane)) return null
  const lines = pane.split(/\r?\n/)
  const headerIdx = lines.findIndex((l) => MCP_MODAL_HEADER_RE.test(l))
  const questionIdx = lines.findIndex((l) => MCP_MODAL_QUESTION_RE.test(l))
  const footerIdx = lines.findIndex((l) => MCP_MODAL_FOOTER_RE.test(l))
  if (headerIdx === -1 || questionIdx === -1 || footerIdx === -1) return null
  if (headerIdx >= questionIdx || questionIdx >= footerIdx) return null

  const headerMatch = (lines[headerIdx] ?? '').match(MCP_MODAL_HEADER_RE)
  const server = headerMatch?.[1] ?? 'MCP'
  const tool = headerMatch?.[2]?.trim() ?? 'tool'

  const options: string[] = []
  for (let i = questionIdx + 1; i < footerIdx; i++) {
    const m = (lines[i] ?? '').match(OPTION_LINE_RE)
    if (m) {
      const num = Number.parseInt(m[1] ?? '0', 10)
      const label = (m[2] ?? '').trim()
      if (num > 0 && label) options.push(label)
    }
  }
  if (options.length === 0) return null

  // Description = lines between header and question with the │ box
  // prefix trimmed; skip separators and the "(ctrl+o to expand)" hint.
  const detailLines: string[] = []
  for (let i = headerIdx + 1; i < questionIdx; i++) {
    const line = (lines[i] ?? '').replace(/^\s*│\s?|\s*│\s*$/g, '').trim()
    if (!line || SEPARATOR_RE.test(line)) continue
    if (/\(ctrl\+o\s+to\s+expand/i.test(line)) continue
    detailLines.push(line)
  }
  const detail = detailLines.join(' ')

  return {
    kind: 'permission',
    title: `${server} · ${tool}`,
    detail: detail || undefined,
    options,
    capturedAt: new Date().toISOString(),
  }
}

function parseSelectorModal(pane: string): import('@agent-hq-orchestron/shared').PendingPrompt | null {
  if (!MODAL_FOOTER_RE.test(pane) || !MODAL_SELECT_RE.test(pane)) return null

  const lines = pane.split(/\r?\n/)
  const footerIdx = lines.findIndex((l) => MODAL_FOOTER_RE.test(l) && MODAL_SELECT_RE.test(l))
  if (footerIdx <= 0) return null

  // Top boundary: nearest ☐ header line above the footer.
  let topIdx = -1
  for (let i = footerIdx - 1; i >= 0; i--) {
    if (MODAL_HEADER_RE.test(lines[i] ?? '')) { topIdx = i; break }
  }
  if (topIdx === -1) return null

  // Collect all numbered options between top and footer. Separator lines,
  // empty lines, and description continuation lines are skipped WITHOUT
  // stopping the scan — Claude places "Chat about this" below a separator.
  const optionsByNum = new Map<number, string>()
  let firstOptionLineIdx = footerIdx
  for (let i = topIdx + 1; i < footerIdx; i++) {
    const line = lines[i] ?? ''
    const m = line.match(OPTION_LINE_RE)
    if (m) {
      const num = Number.parseInt(m[1] ?? '0', 10)
      const label = (m[2] ?? '').trim()
      if (num > 0 && label) {
        optionsByNum.set(num, label)
        if (i < firstOptionLineIdx) firstOptionLineIdx = i
      }
    }
  }
  if (optionsByNum.size === 0) return null
  const nums = [...optionsByNum.keys()].sort((a, b) => a - b)
  const options = nums.map((n) => optionsByNum.get(n) ?? '')

  // Title + detail live between the ☐ header and the first option line.
  // Skip empty and separator lines; the LAST non-blank/non-separator line
  // in that band is the title (often ending with `?`); everything above it
  // (up to the header) is optional detail (e.g. the Bash command).
  const titleBandRaw: string[] = []
  for (let i = topIdx + 1; i < firstOptionLineIdx; i++) {
    const line = (lines[i] ?? '').trim()
    if (!line || SEPARATOR_RE.test(line)) continue
    titleBandRaw.push(line)
  }
  let title = ''
  let detail: string | undefined
  if (titleBandRaw.length > 0) {
    title = titleBandRaw[titleBandRaw.length - 1] ?? ''
    if (titleBandRaw.length > 1) {
      detail = titleBandRaw.slice(0, -1).join('\n')
    }
  }
  if (!title) {
    // Fallback to the ☐ header text itself.
    const headerMatch = (lines[topIdx] ?? '').match(MODAL_HEADER_RE)
    title = headerMatch?.[1]?.trim() ?? 'Selector modal'
  }

  const kind: 'permission' | 'question' = PERMISSION_HINT_RE.test(pane) ? 'permission' : 'question'
  return { kind, title, detail, options, capturedAt: new Date().toISOString() }
}

export interface SessionManagerConfig {
  dataDir: string
  maxConcurrent: number
  /** Milliseconds a session may stay idle/needs_input before its tmux is
   *  released (session goes to 'sleeping'). 0 disables the sweeper. */
  idleTimeoutMs?: number
  /** Absolute path to a shared Claude-memory directory. When set, every
   *  claude spawn/reopen/clone/respawn ensures the per-workspace
   *  `<configDir>/projects/<mangled-cwd>/memory/` is a symlink pointing at
   *  this dir — so all sessions across all workspaces share one memory
   *  pool. Real memory dirs found in the path get safety-renamed with a
   *  timestamp suffix so nothing is lost. Empty/unset disables the feature. */
  sharedMemoryDir?: string
  /** Absolute path to a directory holding the shared codex memories SQLite.
   *  When set, every codex spawn/reopen/clone/respawn ensures
   *  `<CODEX_HOME>/memories_1.sqlite` is a symlink pointing at
   *  `<sharedCodexMemoryDir>/memories_1.sqlite` — so codex sessions across
   *  every CODEX_HOME share one derived-memory pool. Only the memories DB
   *  is symlinked; thread_history / goals / queue stay per-CODEX_HOME so
   *  conversation state remains isolated per identity. Empty/unset
   *  disables the feature. */
  sharedCodexMemoryDir?: string
  /** When set, session-manager auto-writes a per-session MCP config that
   *  registers the orchestron MCP server and injects it into every spawn
   *  and reopen via `--mcp-config`. */
  mcpAutoInject?: {
    apiUrl: string
    token: string
    mcpServerPath: string   // absolute path to dist/mcp-server.js
  }
  /** Hand headless runs the structured-output schema that carries the
   *  `inquiry` field, so an agent with no TUI can still ask the user a
   *  question. Defaults to on; see `headlessStructuredOutput` in the server
   *  config for why an operator might turn it off. Ignored for tmux. */
  headlessStructuredOutput?: boolean
}

export class SessionManager {
  private readonly dataDir: string
  private readonly sessionsDir: string
  private readonly maxConcurrent: number
  private readonly registry: AdapterRegistry
  private readonly mcpAutoInject: SessionManagerConfig['mcpAutoInject']
  private readonly idleTimeoutMs: number
  private readonly sharedMemoryDir: string
  private readonly sharedCodexMemoryDir: string
  private readonly headlessStructuredOutput: boolean
  // Optional — needed only for the wake-up path (sleeping → spawning). Kept
  // optional so unit tests don't have to construct a ProjectRegistry.
  private projectResolver: ((projectId: string) => Promise<{ path: string; defaultModel?: string; defaultEffort?: import('@agent-hq-orchestron/shared').EffortLevel }>) | null = null
  // Watchers that flip running → awaiting_input on the next turn_duration event.
  // Keyed by session uuid; one active watcher per session at a time.
  private readonly turnWatchers = new Map<string, TranscriptTailer>()
  // Per-session warm-shutdown timers armed when the session enters
  // idle/needs_input. Fires warmShutdown() at (idleSince + idleTimeoutMs).
  private readonly idleSweepers = new Map<string, NodeJS.Timeout>()
  // Safety-net sweep interval — catches sessions whose per-session timer
  // was lost (e.g. server crash, dropped notification).
  /** Sessions whose in-flight headless turn was interrupted by the user.
   *  The SIGTERM shows up as a signal exit in finishHeadlessTurn, which would
   *  otherwise read as a failure; this marker says "that was deliberate, land
   *  on idle". Consumed exactly once by the turn that was interrupted. */
  private readonly headlessInterrupts = new Set<string>()

  private safetyNetSweep: NodeJS.Timeout | null = null
  // AskUserQuestion pane-scan sweep — catches modals that current Claude
  // buffers out of JSONL (writes flushed only when the turn ends).
  private askUserSweep: NodeJS.Timeout | null = null

  constructor(config: SessionManagerConfig, registry: AdapterRegistry) {
    this.dataDir = config.dataDir
    this.sessionsDir = path.join(config.dataDir, 'sessions')
    this.maxConcurrent = config.maxConcurrent
    this.registry = registry
    this.mcpAutoInject = config.mcpAutoInject
    // Default 15min. Explicit 0 in config disables the sweeper (opt-out).
    this.idleTimeoutMs = config.idleTimeoutMs ?? 15 * 60 * 1000
    this.sharedMemoryDir = config.sharedMemoryDir ?? ''
    this.sharedCodexMemoryDir = config.sharedCodexMemoryDir ?? ''
    this.headlessStructuredOutput = config.headlessStructuredOutput ?? DEFAULT_HEADLESS_STRUCTURED_OUTPUT
  }

  /**
   * Ensure the structured-output schema exists on disk and return its path,
   * or undefined when structured output is off or the session is tmux.
   *
   * Only Codex actually reads the file — its `--output-schema` flag takes a
   * path. Claude's `--json-schema` takes the document inline and errors on a
   * path, so the Claude adapter serialises the same shared constant itself
   * and treats a defined path purely as the "structured output is on" signal.
   * One schema, two delivery mechanisms, same split as mcpConfigPath vs
   * mcpConfigInline.
   *
   * Written once per API process rather than per session — the document is a
   * compile-time constant, so there is nothing per-session to vary.
   */
  private async ensureOutputSchemaPath(useTmux: boolean): Promise<string | undefined> {
    if (useTmux || !this.headlessStructuredOutput) return undefined
    const p = path.join(this.dataDir, ORCHESTRON_RESULT_SCHEMA_FILENAME)
    if (!this.outputSchemaWritten) {
      await fs.promises.mkdir(this.dataDir, { recursive: true })
      await fs.promises.writeFile(p, ORCHESTRON_RESULT_SCHEMA_JSON, 'utf8')
      this.outputSchemaWritten = true
    }
    return p
  }

  private outputSchemaWritten = false

  /**
   * Ensure `<configDir>/projects/<mangled-cwd>/memory/` is a symlink into
   * the shared Claude-memory pool. Claude CLI creates this dir as a real
   * directory the first time a workspace is used — we detect that and
   * convert it (safety-renaming the real dir with a timestamp).
   */
  private async ensureMemorySymlink(agentType: import('@agent-hq-orchestron/shared').AgentType, configDir: string | undefined, workspace: string): Promise<void> {
    if (agentType === 'codex') return this.ensureCodexMemorySymlink(configDir)
    if (agentType !== 'claude' || !this.sharedMemoryDir) return
    try {
      const fsp = await import('node:fs/promises')
      const p = await import('node:path')
      const os = await import('node:os')
      const expandHome = (x: string) => x.startsWith('~/') ? p.join(os.homedir(), x.slice(2)) : x === '~' ? os.homedir() : x
      const sharedTarget = expandHome(this.sharedMemoryDir)
      const baseDir = expandHome(configDir ?? process.env['CLAUDE_CONFIG_DIR'] ?? p.join(os.homedir(), '.claude'))
      const mangled = expandHome(workspace).replace(/\//g, '-')
      const memPath = p.join(baseDir, 'projects', mangled, 'memory')

      // Make sure the shared pool exists first.
      await fsp.mkdir(sharedTarget, { recursive: true, mode: 0o700 })
      // And the parent so we can create the symlink.
      await fsp.mkdir(p.dirname(memPath), { recursive: true, mode: 0o700 })

      let stat: import('node:fs').Stats | null = null
      try { stat = await fsp.lstat(memPath) } catch { stat = null }
      if (!stat) {
        await fsp.symlink(sharedTarget, memPath)
        return
      }
      if (stat.isSymbolicLink()) return   // already linked (to anything) — leave alone
      if (stat.isDirectory()) {
        // Real dir — safety-move + symlink. Never delete: files could be
        // hand-edited memory the user wants to merge into the pool later.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const bak = `${memPath}.bak-${stamp}`
        await fsp.rename(memPath, bak)
        console.warn(`[session-manager] moved real memory dir to ${bak} and symlinked ${memPath} → ${sharedTarget}`)
        await fsp.symlink(sharedTarget, memPath)
        return
      }
      console.warn(`[session-manager] unexpected fs type at ${memPath}; skipping shared-memory symlink`)
    } catch (err) {
      // Never let this block a spawn — memory-symlink is a convenience, not a hard dep.
      console.warn(`[session-manager] ensureMemorySymlink failed: ${(err as Error).message}`)
    }
  }

  /**
   * Ensure <CODEX_HOME>/memories_1.sqlite is a symlink into the shared
   * codex-memory pool. Codex writes its curated cross-thread memory pool
   * to this single SQLite file; symlinking to a shared location lets
   * multiple CODEX_HOME identities (different profiles) contribute to one
   * pool of learned patterns. Auto-generated -wal / -shm sidecars live in
   * the same directory as the symlinked DB file — SQLite handles the
   * concurrent-writer serialization via WAL locks.
   *
   * Deliberately does NOT symlink thread_history / goals / queue — those
   * carry conversation content that should stay isolated per identity.
   */
  private async ensureCodexMemorySymlink(configDir: string | undefined): Promise<void> {
    if (!this.sharedCodexMemoryDir) return
    try {
      const fsp = await import('node:fs/promises')
      const p = await import('node:path')
      const os = await import('node:os')
      const expandHome = (x: string) => x.startsWith('~/') ? p.join(os.homedir(), x.slice(2)) : x === '~' ? os.homedir() : x
      const sharedDir = expandHome(this.sharedCodexMemoryDir)
      const codexHome = expandHome(configDir ?? process.env['CODEX_HOME'] ?? p.join(os.homedir(), '.codex'))

      const sharedDbPath = p.join(sharedDir, 'memories_1.sqlite')
      const localDbPath = p.join(codexHome, 'memories_1.sqlite')

      // Ensure both directories exist so symlink() can succeed.
      await fsp.mkdir(sharedDir, { recursive: true, mode: 0o700 })
      await fsp.mkdir(codexHome, { recursive: true, mode: 0o700 })

      let stat: import('node:fs').Stats | null = null
      try { stat = await fsp.lstat(localDbPath) } catch { stat = null }
      if (!stat) {
        // Sqlite file doesn't exist yet — create the symlink; SQLite will
        // materialize the DB (and WAL sidecars) at the shared location on
        // first codex write.
        await fsp.symlink(sharedDbPath, localDbPath)
        return
      }
      if (stat.isSymbolicLink()) return   // already linked
      if (stat.isFile()) {
        // Real DB file. Safety-move to bak (never delete — codex's own
        // derived memories from this identity), then symlink. WAL sidecars
        // stay behind and become stale; codex re-creates them at shared
        // location on next write.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const bak = `${localDbPath}.bak-${stamp}`
        await fsp.rename(localDbPath, bak)
        console.warn(`[session-manager] moved codex memories DB to ${bak} and symlinked ${localDbPath} → ${sharedDbPath}`)
        await fsp.symlink(sharedDbPath, localDbPath)
        return
      }
      console.warn(`[session-manager] unexpected fs type at ${localDbPath}; skipping codex-memory symlink`)
    } catch (err) {
      // Convenience feature — never block spawn.
      console.warn(`[session-manager] ensureCodexMemorySymlink failed: ${(err as Error).message}`)
    }
  }

  /** Wire in a project lookup for the wake-up flow. Called from server boot. */
  setProjectResolver(resolver: NonNullable<SessionManager['projectResolver']>): void {
    this.projectResolver = resolver
  }

  private mcpConfigPath(sessionId: string): string {
    return path.join(this.dataDir, 'mcp-configs', `${sessionId}.json`)
  }

  /** Build inline MCP config args for Codex (`-c mcp_servers.NAME.*=VALUE`).
   *  Codex accepts TOML-typed config overrides via `-c KEY=VALUE`. Strings
   *  need TOML quoting; arrays use TOML array syntax. Kept in sync with the
   *  claude JSON config shape written by ensureSessionMcpConfig(). */
  private buildCodexMcpArgs(sessionId: string): string[] | undefined {
    if (!this.mcpAutoInject) return undefined
    const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    const args: string[] = []
    args.push('-c', `mcp_servers.orchestron.command=${q('node')}`)
    args.push('-c', `mcp_servers.orchestron.args=[${q(this.mcpAutoInject.mcpServerPath)}]`)
    args.push('-c', `mcp_servers.orchestron.env.ORCHESTRON_API_URL=${q(this.mcpAutoInject.apiUrl)}`)
    args.push('-c', `mcp_servers.orchestron.env.ORCHESTRON_TOKEN=${q(this.mcpAutoInject.token)}`)
    args.push('-c', `mcp_servers.orchestron.env.ORCHESTRON_SESSION_ID=${q(sessionId)}`)
    return args
  }

  /** Write a per-session MCP config that exposes the orchestron server to
   *  the child agent. Returns the file path, or undefined if auto-inject
   *  is not configured. Currently CLAUDE-only — Codex uses buildCodexMcpArgs()
   *  above which returns inline `-c` flags instead. */
  private async ensureSessionMcpConfig(sessionId: string, agentType?: import('@agent-hq-orchestron/shared').AgentType): Promise<string | undefined> {
    if (!this.mcpAutoInject) return undefined
    if (agentType && agentType !== 'claude') return undefined
    const cfg = {
      mcpServers: {
        orchestron: {
          command: 'node',
          args: [this.mcpAutoInject.mcpServerPath],
          env: {
            ORCHESTRON_API_URL: this.mcpAutoInject.apiUrl,
            ORCHESTRON_TOKEN: this.mcpAutoInject.token,
            ORCHESTRON_SESSION_ID: sessionId,
          },
        },
      },
    }
    const p = this.mcpConfigPath(sessionId)
    await writeJson(p, cfg)
    return p
  }

  private sessionPath(uuid: string): string {
    return path.join(this.sessionsDir, `${uuid}.json`)
  }

  /** Generic in-process serializer used by spawn() and by every mutating
   *  lifecycle method (reopen/respawn/clone/adopt/archive/kill/
   *  deleteRecord/updateMetadata). Callers pick a key — `spawn:${parent}`
   *  for delegation-guardrail TOCTOU, `uuid:${id}` for lifecycle races
   *  that would otherwise clobber the same record from two concurrent
   *  handlers. Not a cross-process lock (would need a filesystem lock or
   *  SQLite); MCP + the local HTTP API are the only concurrent callers
   *  and both live inside this Node process. */
  private locks = new Map<string, Promise<void>>()

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    while (this.locks.has(key)) {
      try { await this.locks.get(key) } catch { /* prior holder failed — proceed */ }
    }
    let release!: () => void
    const p = new Promise<void>((r) => { release = r })
    this.locks.set(key, p)
    try {
      return await fn()
    } finally {
      this.locks.delete(key)
      release()
    }
  }

  async spawn(spawnConfig: SpawnConfig): Promise<SessionMetadata> {
    const key = `spawn:${spawnConfig.parentSessionId ?? '__no_parent__'}`
    return this.withLock(key, () => this._spawnUnlocked(spawnConfig))
  }

  private async _spawnUnlocked(spawnConfig: SpawnConfig): Promise<SessionMetadata> {
    const active = await this.countActiveSessions()
    if (active >= this.maxConcurrent) {
      throw new PoolFullError(this.maxConcurrent)
    }

    // Delegation guardrails: prevent infinite child-of-child spawning and
    // per-parent spam.
    if (spawnConfig.parentSessionId) {
      const MAX_DEPTH = 5           // grandparent → parent → ... → self, max chain
      const MAX_CHILDREN = 10        // per parent
      const RATE_LIMIT_WINDOW_MS = 60_000
      const RATE_LIMIT_MAX = 5       // spawns/minute per parent

      // Walk parent chain to compute depth
      let depth = 1
      let cur = spawnConfig.parentSessionId
      while (cur && depth < MAX_DEPTH + 1) {
        const rec = await readJson<SessionMetadata | null>(this.sessionPath(cur), null)
        if (!rec || !rec.parentSessionId) break
        cur = rec.parentSessionId
        depth += 1
      }
      if (depth > MAX_DEPTH) {
        throw new Error(`Delegation depth limit reached (${MAX_DEPTH}). Parent chain too long.`)
      }

      // Count existing children of this parent
      const all = await this.list()
      const children = all.filter((s) => s.parentSessionId === spawnConfig.parentSessionId)
      if (children.length >= MAX_CHILDREN) {
        throw new Error(`Parent ${spawnConfig.parentSessionId.slice(0, 8)} already has ${children.length} children (max ${MAX_CHILDREN})`)
      }

      // Rate limit: how many children spawned in the last window
      const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS
      const recent = children.filter((s) => new Date(s.startedAt).getTime() > cutoff)
      if (recent.length >= RATE_LIMIT_MAX) {
        throw new Error(`Parent ${spawnConfig.parentSessionId.slice(0, 8)} spawn rate limit: ${RATE_LIMIT_MAX} per minute`)
      }
    }

    const uuid = crypto.randomUUID()
    const adapter = this.registry.getOrThrow(spawnConfig.agentType)
    const mcpConfigPath = await this.ensureSessionMcpConfig(uuid, spawnConfig.agentType)
    const mcpConfigInline = spawnConfig.agentType === 'codex'
      ? this.buildCodexMcpArgs(uuid)
      : undefined
    // Effective config dir: harness-specific. Route layer resolves the
    // right env-var per harness (CLAUDE_CONFIG_DIR for claude, CODEX_HOME
    // for codex). For claude we also cascade to CLAUDE_CONFIG_DIR env and
    // ~/.claude default via effectiveClaudeConfigDir. Codex adapter reads
    // CODEX_HOME env internally when passed undefined.
    const { effectiveClaudeConfigDir, mangleCwd } = await import('../adapters/claude.js')
    const effectiveConfigDir = spawnConfig.agentType === 'claude'
      ? effectiveClaudeConfigDir(spawnConfig.configDir)
      : spawnConfig.configDir
    // Resolve once, here, and persist the resolved boolean — downstream code
    // then never has to re-derive it from a project record that may since
    // have been edited. `?? true` via resolveUseTmux.
    const useTmux = resolveUseTmux(spawnConfig.useTmux)
    // Same-harness model check: project defaults might carry a Claude model
    // that Codex would reject at spawn. Drop the model if it looks like the
    // wrong family; adapter will fall back to its own default (gpt-6-astra
    // for codex, sonnet for claude).
    const effectiveModel = filterModelForHarness(spawnConfig.model, spawnConfig.agentType)
    await this.ensureMemorySymlink(spawnConfig.agentType, effectiveConfigDir, spawnConfig.workspace)
    const outputSchemaPath = await this.ensureOutputSchemaPath(useTmux)
    const spawnedAt = Date.now()
    const handle = await adapter.spawn({ ...spawnConfig, useTmux, model: effectiveModel, configDir: effectiveConfigDir, mcpConfigPath, mcpConfigInline, outputSchemaPath })

    // Codex thread_id capture happens async in completeSpawn() via SQLite
    // (see captureCodexThreadId call after sendPrompt). We used to block here
    // waiting up to 40s for waitTuiReady + captureNewSessionId, but that
    // scanned the rollout dir which interactive TUI never writes — always
    // returned empty ids and just froze the HTTP response, causing the
    // client's spawn modal to hang. Session record is written with empty
    // claudeSessionUuid; completeSpawn patches it once SQLite has the row.

    const now = new Date().toISOString()
    const session: SessionMetadata = {
      id: uuid,
      projectId: spawnConfig.projectId,
      agentType: spawnConfig.agentType,
      model: spawnConfig.model,
      effort: spawnConfig.effort,
      status: 'spawning',
      parentSessionId: spawnConfig.parentSessionId ?? null,
      detached: spawnConfig.detached ?? false,
      claudeSessionUuid: handle.claudeUuid,
      tmuxName: handle.tmuxName,
      jsonlPath: handle.jsonlPath,
      configDir: effectiveConfigDir,
      cwdSlug: mangleCwd(spawnConfig.workspace),
      useTmux,
      initialPrompt: spawnConfig.initialPrompt,
      finalResponse: null,
      tokenUsage: null,
      costUsd: null,
      startedAt: now,
      endedAt: null,
      lastActivityAt: now,
      metadata: {},
    }

    await writeJson(this.sessionPath(uuid), session)

    // Fire-and-forget: complete the spawn lifecycle async so the HTTP response is fast.
    // Dismisses trust folder / theme picker, waits for TUI ready, pastes prompt, then transitions.
    // Passes spawnConfig so completeSpawn can re-spawn on transient tmux/claude-boot failure.
    this.completeSpawn(uuid, adapter, handle, spawnConfig.initialPrompt, spawnConfig, spawnedAt).catch(async (err: unknown) => {
      const msg = (err as Error).message ?? String(err)
      console.error(`[session-manager] completeSpawn failed for ${uuid}: ${msg}`)
      try {
        const rec = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
        if (rec && rec.status === 'spawning') {
          await this.transition(uuid, 'failed').catch(() => {})
          const failed = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
          if (failed) {
            failed.failureReason = msg
            await writeJson(this.sessionPath(uuid), failed)
          }
        }
      } catch { /* ignore */ }
    })

    return session
  }

  private async completeSpawn(
    uuid: string,
    adapter: import('@agent-hq-orchestron/shared').AgentAdapter,
    handle: import('@agent-hq-orchestron/shared').TmuxHandle,
    prompt: string,
    spawnConfig?: SpawnConfig,
    spawnedAt?: number,
  ): Promise<void> {
    // Headless: the child is already running the turn (prompt was in argv).
    // No TUI to wait for, nothing to paste — just follow it to exit.
    if (handle.headless) {
      await this.completeHeadlessSpawn(uuid, adapter, handle)
      return
    }

    let currentHandle = handle
    let attempt = 0
    const MAX_ATTEMPTS = 2

    while (true) {
      try {
        // TUI ready (auto-dismisses trust/menu interstitials) — 30s timeout for cold start
        await adapter.waitTuiReady(currentHandle, 30_000)
        break
      } catch (err: unknown) {
        const msg = (err as Error).message ?? ''
        // Only retry when the tmux pane vanished early (Claude subprocess died
        // at boot — usually a transient auth/subscription glitch). Other errors
        // (timeouts on interstitials etc.) propagate.
        const paneDied = msg.includes('can\'t find pane') || msg.includes('no such pane')
        attempt += 1
        if (!paneDied || attempt >= MAX_ATTEMPTS || !spawnConfig) {
          throw err
        }
        console.warn(`[session-manager] tmux pane died for ${uuid}, respawning (attempt ${attempt + 1}/${MAX_ATTEMPTS})`)
        // Clean up dead tmux (best-effort) and respawn with fresh claude UUID.
        await adapter.kill(currentHandle).catch(() => {})
        const newHandle = await adapter.spawn(spawnConfig)
        currentHandle = newHandle

        // Update the session record with the new tmux/claude handles.
        const rec = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
        if (rec) {
          rec.tmuxName = newHandle.tmuxName
          rec.claudeSessionUuid = newHandle.claudeUuid
          rec.jsonlPath = newHandle.jsonlPath
          await writeJson(this.sessionPath(uuid), rec)
        }
      }
    }

    await this.transition(uuid, 'waiting')

    // Paste initial prompt + Enter
    const pasteTs = Date.now()
    await adapter.sendPrompt(currentHandle, prompt)
    await this.transition(uuid, 'running')

    // Codex interactive TUI: capture thread_id from SQLite after prompt paste.
    // SQLite is only written once codex starts processing, so we poll here
    // (post-paste) rather than pre-paste where the DB would be empty.
    if (spawnConfig?.agentType === 'codex' && currentHandle.claudeUuid === '') {
      captureCodexThreadId(spawnConfig.configDir, spawnedAt ?? pasteTs, 30_000).then(async (threadId) => {
        if (!threadId) return
        const rec = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
        if (rec && !rec.claudeSessionUuid) {
          rec.claudeSessionUuid = threadId
          await writeJson(this.sessionPath(uuid), rec)
        }
      }).catch(() => {})
    }

    if (currentHandle.jsonlPath) {
      this.watchForTurnEnd(uuid, currentHandle.jsonlPath)
    }
  }

  /**
   * Headless spawn lifecycle: `spawning → running → idle | needs_input`.
   *
   * A headless session is NOT single-shot any more. The child process is
   * ephemeral — one process per turn — but the *session* persists, exactly as
   * a tmux one does, and comes to rest in `idle` ready for the next
   * `-p --resume` turn. Phase 1 landed a finished run in `succeeded`, which
   * conflated "the process exited" with "the user is done with this session";
   * `succeeded` is now reached only through Archive, same as tmux.
   *
   * Differences from the tmux path that remain, all because the process is
   * ephemeral rather than long-lived:
   *  - no waitTuiReady / interstitial dismissal — `-p` and `exec` have no TUI
   *  - no sendPrompt — the prompt is in argv, one prompt per child
   *  - no turn watcher — the harness emits no `turn_duration` in headless
   *    mode; process exit IS the turn boundary
   *  - no sleeping — nothing is held between turns, so there is nothing for
   *    the idle sweeper to release (armIdleSweeper skips headless)
   *  - an idle headless session costs nothing, so it does not occupy a pool
   *    cap slot (see countActiveSessions)
   */
  private async completeHeadlessSpawn(
    uuid: string,
    adapter: import('@agent-hq-orchestron/shared').AgentAdapter,
    handle: TmuxHandle,
  ): Promise<void> {
    await this.transition(uuid, 'running')
    await this.finishHeadlessTurn(uuid, adapter, handle)
  }

  /**
   * Await one headless child's exit and land the session.
   *
   * Shared by the initial spawn and by every follow-up turn from sendInput,
   * so a turn is reconciled identically however it was started. Assumes the
   * session is already in `running`.
   *
   * Landing rules:
   *   exit 0 + structured inquiry  → `needs_input` (+ pendingInquiry set)
   *   exit 0                       → `idle`
   *   interrupted by the user      → `idle` (the turn was cut short on purpose)
   *   anything else                → `failed` (+ failureReason from stderr)
   */
  private async finishHeadlessTurn(
    uuid: string,
    adapter: import('@agent-hq-orchestron/shared').AgentAdapter,
    handle: TmuxHandle,
  ): Promise<void> {
    const result: HeadlessResult = adapter.awaitHeadlessExit
      ? await adapter.awaitHeadlessExit(handle)
      : { exitCode: null, stderr: `adapter '${adapter.name}' does not support headless mode` }

    // Re-read: the record may have moved on while the child ran — most
    // importantly a user Kill, which already put it in a terminal state.
    // Transitioning again would throw InvalidTransitionError.
    const rec = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!rec) {
      this.headlessInterrupts.delete(uuid)
      return
    }
    const TERMINAL: SessionStatus[] = ['succeeded', 'failed', 'killed']
    if (TERMINAL.includes(rec.status)) {
      this.headlessInterrupts.delete(uuid)
      return
    }

    // An interrupt SIGTERMs the child, which surfaces here as a non-zero /
    // signal exit. That is a user decision, not a failure, so consume the
    // marker and land on idle with whatever the turn managed to produce.
    const interrupted = this.headlessInterrupts.delete(uuid)

    const patched: SessionMetadata = { ...rec }

    // Codex mints its own thread id and only announces it on stdout, so this
    // is the one chance to capture it. Claude pre-assigns via --session-id
    // and reports the same value back, so the assignment is a no-op there.
    if (result.sessionId && !patched.claudeSessionUuid) {
      patched.claudeSessionUuid = result.sessionId
      if (!patched.jsonlPath && patched.agentType === 'codex') {
        const { findCodexRolloutPath } = await import('../adapters/codex.js')
        patched.jsonlPath = (await findCodexRolloutPath(patched.configDir, result.sessionId)) ?? ''
      }
    }

    // With structured output on, finalResponse is a JSON document rather than
    // prose. parseHeadlessResultDocument is forgiving by design — a plain
    // string comes back as `{summary: <that string>, inquiry: null}` — so this
    // is safe to run unconditionally, including when the flag is off or the
    // model ignored the schema.
    const doc = parseHeadlessResultDocument(result.finalResponse)
    if (result.finalResponse != null) patched.finalResponse = doc.summary
    if (result.tokenUsage) patched.tokenUsage = result.tokenUsage
    if (result.costUsd != null) patched.costUsd = result.costUsd

    const ok = result.exitCode === 0 || interrupted
    // An inquiry from a turn that then failed is not actionable — the process
    // died, so there is nothing to resume into. Only honour it on a clean run.
    const inquiry = result.exitCode === 0 ? doc.inquiry : null
    patched.pendingInquiry = inquiry
    if (!ok) {
      patched.failureReason = result.stderr
        ? `headless exit ${result.exitCode ?? 'signal'}: ${result.stderr}`
        : `headless exit ${result.exitCode ?? 'signal'}`
    } else {
      // A turn that succeeded clears a stale reason from an earlier one.
      patched.failureReason = undefined
    }

    await writeJson(this.sessionPath(uuid), patched)
    await this.transition(uuid, !ok ? 'failed' : inquiry ? 'needs_input' : 'idle')
  }

  /**
   * Run one follow-up turn on a headless session.
   *
   * Every turn is a fresh child process resuming the same conversation —
   * `claude -p --resume <uuid>` / `codex exec resume <thread_id>`. The
   * harness appends to the transcript it already owns and reports the same
   * session id back, so `claudeSessionUuid`, `jsonlPath` and `cwdSlug` on the
   * record survive untouched across turns.
   *
   * Returns as soon as the child is launched; `finishHeadlessTurn` lands the
   * session when it exits, exactly as it does for the initial spawn. That
   * keeps POST /input fast and means one code path reconciles every turn.
   *
   * Deliberately narrower than the tmux path in two ways:
   *
   *  - No queue-during-run. A tmux TUI buffers a paste and runs it as the
   *    next turn; a headless child has no input channel at all, and starting
   *    a second `--resume` against a live one would have two processes
   *    appending to the same JSONL. `running` is refused.
   *  - No wake-from-sleeping. Headless never sleeps (see armIdleSweeper), so
   *    there is no cold-start branch to take.
   */
  private async sendHeadlessTurn(
    uuid: string,
    session: SessionMetadata,
    prompt: string,
  ): Promise<SessionMetadata> {
    const ALLOWED: SessionStatus[] = ['idle', 'needs_input']
    if (!ALLOWED.includes(session.status)) {
      throw new Error(
        session.status === 'running' || session.status === 'spawning'
          ? `Cannot send input while a headless turn is still running — headless has no input queue. Wait for it to finish, or interrupt it first.`
          : `Cannot send input while session is ${session.status}`,
      )
    }
    if (!session.claudeSessionUuid) {
      throw new Error(
        'Cannot send input: this headless session has no harness session id — its first run failed before the harness reported one. Respawn instead.',
      )
    }
    if (!this.projectResolver) {
      throw new Error('Cannot send input to a headless session: project resolver not wired')
    }

    const proj = await this.projectResolver(session.projectId)
    const adapter = this.registry.getOrThrow(session.agentType)
    await this.ensureMemorySymlink(session.agentType, session.configDir, proj.path)
    // Regenerate per-turn so a rotated token / moved API URL takes effect on
    // the next turn rather than at the next spawn.
    const mcpConfigPath = await this.ensureSessionMcpConfig(uuid, session.agentType)
    const mcpConfigInline = session.agentType === 'codex' ? this.buildCodexMcpArgs(uuid) : undefined
    const outputSchemaPath = await this.ensureOutputSchemaPath(false)

    const handle = await adapter.resume(session.claudeSessionUuid, {
      workspace: proj.path,
      // Must be the SAME configDir the session was spawned with: the harness
      // finds a conversation by scanning that dir and nothing else, so a
      // different one means "No conversation found" on a perfectly good id.
      configDir: session.configDir,
      model: session.model ?? proj.defaultModel,
      effort: session.effort ?? proj.defaultEffort,
      mcpConfigPath,
      mcpConfigInline,
      outputSchemaPath,
      useTmux: false,
      prompt,
    })

    // The handle name is fresh per turn so a kill aimed at this turn cannot
    // reap the next one; persist it or `handleFor` would still point at the
    // previous turn's child. jsonlPath is refreshed too — for codex it is
    // globbed from the rollout tree and may only now exist.
    const refreshed = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    await writeJson(this.sessionPath(uuid), {
      ...(refreshed ?? session),
      tmuxName: handle.tmuxName,
      jsonlPath: handle.jsonlPath || (refreshed ?? session).jsonlPath,
      // The question, if there was one, has now been answered.
      pendingInquiry: null,
    })

    const updated = await this.transition(uuid, 'running')

    this.finishHeadlessTurn(uuid, adapter, handle).catch(async (err: unknown) => {
      const msg = (err as Error).message ?? String(err)
      console.error(`[session-manager] headless turn failed for ${uuid}: ${msg}`)
      try {
        const rec = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
        if (rec && rec.status === 'running') {
          await this.transition(uuid, 'failed').catch(() => {})
          const failed = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
          if (failed) {
            failed.failureReason = msg
            await writeJson(this.sessionPath(uuid), failed)
          }
        }
      } catch { /* ignore */ }
    })

    return updated
  }

  async sendInput(uuid: string, prompt: string): Promise<SessionMetadata> {
    let session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    // Headless: each turn is its own `-p --resume` / `exec resume` child.
    if (!resolveUseTmux(session.useTmux)) {
      return this.sendHeadlessTurn(uuid, session, prompt)
    }

    // Wake-up path: session is sleeping → cold-start tmux with --resume,
    // wait for TUI ready, then fall through to the normal paste flow.
    if (session.status === 'sleeping') {
      if (!this.projectResolver) {
        throw new Error('Cannot wake sleeping session: project resolver not wired')
      }
      const proj = await this.projectResolver(session.projectId)
      const adapter = this.registry.getOrThrow(session.agentType)
      await this.ensureMemorySymlink(session.agentType, session.configDir, proj.path)

      // Claude subprocess sometimes dies within a few seconds of boot
      // (transient auth / quota / MCP-connect flakiness). Same retry pattern
      // as completeSpawn — attempt twice with a fresh mcp config each time,
      // then surface a clean error so the client can retry.
      let handle: import('@agent-hq-orchestron/shared').TmuxHandle | null = null
      let lastErr: Error | null = null
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const mcpConfigPath = await this.ensureSessionMcpConfig(uuid)
          handle = await adapter.resume(session.claudeSessionUuid, {
            workspace: proj.path,
            configDir: session.configDir,   // wake-up must use SAME configDir as spawn
            model: session.model ?? proj.defaultModel,
            effort: session.effort ?? proj.defaultEffort,
            mcpConfigPath,
          })
          await adapter.waitTuiReady(handle, 15_000)
          break
        } catch (err) {
          lastErr = err as Error
          // Tear down the failed tmux if it exists, then retry once.
          if (handle) {
            await adapter.kill(handle).catch(() => {})
            handle = null
          }
          if (attempt === 2) break
          await new Promise((r) => setTimeout(r, 500))
        }
      }

      if (!handle) {
        // Leave the session in 'sleeping' so a subsequent send can retry.
        // Don't drag it into 'failed' — that'd hide the resumable state.
        throw new Error(
          `Wake-up failed after 2 attempts: ${lastErr?.message ?? 'unknown'}. Session stays sleeping — try sending again.`,
        )
      }

      // Persist new tmux + jsonl path only after TUI is confirmed ready.
      await writeJson(this.sessionPath(uuid), {
        ...session,
        tmuxName: handle.tmuxName,
        jsonlPath: handle.jsonlPath,
        status: 'spawning',
        endedAt: null,
        idleSince: null,
      })
      await this.transition(uuid, 'waiting')
      // Re-read after wake-up so downstream sees fresh tmux name.
      session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
      if (!session) throw new Error(`Session vanished during wake-up: ${uuid}`)
    }

    // Allow queue-during-run: Claude TUI buffers the pasted input and sends
    // it as the next turn after the current one finishes. Only reject when
    // the session is terminal or still initializing.
    const INPUT_ALLOWED: SessionStatus[] = ['needs_input', 'idle', 'waiting', 'running']
    if (!INPUT_ALLOWED.includes(session.status)) {
      throw new Error(`Cannot send input while session is ${session.status}`)
    }

    const adapter = this.registry.getOrThrow(session.agentType)
    const handle = handleFor(session)

    // Dismiss any stale interstitial (e.g. "Teach auto mode?" modal that Claude
    // may pop up between turns) before pasting the prompt. Short timeout — if
    // the TUI is already ready this returns immediately.
    await adapter.waitTuiReady(handle, 10_000).catch(() => { /* proceed anyway */ })

    await adapter.sendPrompt(handle, prompt)
    // If session was already running, don't force a transition — the current
    // turn's watcher will still handle turn_duration → idle/needs_input.
    // The queued prompt becomes the next turn and a fresh watcher then arms.
    if (session.status === 'running') {
      // Just re-arm watcher (safe: idempotent — old watcher closed on next fire)
      this.watchForTurnEnd(uuid, session.jsonlPath)
      // Bump activity manually — no transition fires, so the record would
      // otherwise stay at whatever lastActivityAt it had, and the dashboard
      // wouldn't reflect the queued input.
      const refreshed = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
      if (refreshed) {
        await writeJson(this.sessionPath(uuid), { ...refreshed, lastActivityAt: new Date().toISOString() })
      }
      return refreshed ?? session
    }
    const updated = await this.transition(uuid, 'running')
    this.watchForTurnEnd(uuid, session.jsonlPath)
    return updated
  }

  /**
   * Safety-net reconciliation: forces a running→idle/needs_input transition
   * based on the last assistant text, when the tailer's fs.watch missed the
   * turn_duration event (known Linux inotify quirk for appends). Called by
   * the transcript polling endpoint.
   */
  async reconcileTurnEnd(uuid: string, lastAssistantText: string): Promise<void> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session || session.status !== 'running') return
    // Headless turns end when the child exits, full stop. A transcript-driven
    // reconcile here would race finishHeadlessTurn and could flip the session
    // to idle while its process is still working.
    if (!resolveUseTmux(session.useTmux)) return
    const next: SessionStatus = textAsksQuestion(lastAssistantText) ? 'needs_input' : 'idle'
    if (ALLOWED_TRANSITIONS[session.status].includes(next)) {
      await this.transition(uuid, next).catch(() => {})
    }
    // Close any dangling watcher for cleanliness
    const w = this.turnWatchers.get(uuid)
    if (w) {
      w.close()
      this.turnWatchers.delete(uuid)
    }
  }

  /**
   * Mid-turn reconciliation: transitions running→needs_input when Claude's
   * TUI is showing an AskUserQuestion selector that requires an answer.
   * Claude does NOT emit `turn_duration` until the user answers the modal,
   * so `reconcileTurnEnd` above never fires — the session would otherwise
   * appear stuck at `running` in the dashboard list until someone opens the
   * session detail and picks an answer. Called by the transcript polling
   * endpoint when it sees a pending AskUserQuestion (tool_use without a
   * matching later tool_result).
   */
  async reconcilePendingUserQuestion(uuid: string): Promise<void> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session || session.status !== 'running') return
    if (ALLOWED_TRANSITIONS[session.status].includes('needs_input')) {
      await this.transition(uuid, 'needs_input').catch(() => {})
    }
  }

  /**
   * Interrupt the current turn — send Escape to the Claude TUI which aborts
   * the API call in progress without killing the session. Session transitions
   * back to `idle` once tailer sees `turn_duration` or timeout.
   */
  async interrupt(uuid: string): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    if (session.status !== 'running' && session.status !== 'needs_input' && session.status !== 'idle') {
      throw new Error(`Cannot interrupt session in ${session.status} state`)
    }

    // Headless: there is no TUI to send Escape to, but there IS a child
    // process, and now that a headless session survives its turn, stopping
    // one turn has to be possible without ending the session. SIGTERM the
    // child and mark the interrupt so finishHeadlessTurn reads the resulting
    // signal exit as deliberate and lands on `idle` instead of `failed`.
    //
    // Between turns there is no child at all, so an interrupt is a no-op on
    // an already-idle session — same as pressing Escape at a tmux prompt.
    if (!resolveUseTmux(session.useTmux)) {
      if (session.status !== 'running') return session
      this.headlessInterrupts.add(uuid)
      const adapter = this.registry.getOrThrow(session.agentType)
      try {
        await adapter.kill(handleFor(session))
      } catch (err) {
        // Nothing was signalled, so nothing will consume the marker.
        this.headlessInterrupts.delete(uuid)
        throw err
      }
      // finishHeadlessTurn owns the transition — it is already awaiting the
      // exit promise and will land the session once the child is reaped.
      // Racing it with a transition here would throw on the second write.
      return session
    }

    const handle = handleFor(session)

    // Send Escape via tmux — Claude TUI interprets as interrupt-turn.
    // Fallback silently if tmux is dead.
    try {
      const tmux = await import('../adapters/tmux.js')
      await tmux.sendKeys(handle.tmuxName, 'Escape')
    } catch { /* ignore */ }

    // Interrupted turns write '[Request interrupted by user]' but NO
    // `turn_duration` event, so the tailer/safety-net won't auto-transition.
    // Proactively flip running → idle here since we know the user chose to
    // stop. Close any active watcher for cleanliness.
    if (session.status === 'running') {
      const w = this.turnWatchers.get(uuid)
      if (w) {
        w.close()
        this.turnWatchers.delete(uuid)
      }
      const updated = await this.transition(uuid, 'idle').catch(() => session)
      return updated
    }
    return session
  }

  /**
   * Tail the JSONL for one `system.turn_duration` event and auto-transition to
   * `awaiting_input`. Fire-and-forget; watcher closes itself once triggered.
   * Default starts at current file size (only new events). Pass fromStart=true
   * to replay from the beginning — used on resume to catch an already-ended turn.
   */
  private watchForTurnEnd(uuid: string, jsonlPath: string, opts?: { fromStart?: boolean }): void {
    // Close any prior watcher for this session first
    const prior = this.turnWatchers.get(uuid)
    if (prior) {
      prior.close()
      this.turnWatchers.delete(uuid)
    }

    let startOffset = 0
    if (!opts?.fromStart) {
      try {
        startOffset = fs.statSync(jsonlPath).size
      } catch { /* file may not exist yet */ }
    }

    const tailer = new TranscriptTailer(uuid, jsonlPath, this.dataDir, {
      startOffset,
      persistOffset: false,
    })
    this.turnWatchers.set(uuid, tailer)

    // Track the last assistant text so we can heuristically decide whether the
    // agent asked a question (→ needs_input) or the turn just ended (→ idle).
    let lastAssistantText = ''

    tailer.on('event', async (ev: { event: unknown }) => {
      const obj = ev.event as {
        type?: string
        subtype?: string
        message?: { content?: Array<{ type?: string; text?: string }> }
      } | null
      if (!obj) return

      // Buffer the most recent assistant text block seen in this stream.
      if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
        for (const b of obj.message!.content!) {
          if (b.type === 'text' && b.text) lastAssistantText = b.text
        }
        return
      }

      if (obj.type !== 'system' || obj.subtype !== 'turn_duration') return
      const current = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
      if (current && (current.status === 'running' || current.status === 'idle' || current.status === 'needs_input')) {
        const next: SessionStatus = textAsksQuestion(lastAssistantText) ? 'needs_input' : 'idle'
        // Only transition if it's a legal move from current state.
        if (ALLOWED_TRANSITIONS[current.status].includes(next)) {
          await this.transition(uuid, next).catch(() => {})
        }
      }
      tailer.close()
      this.turnWatchers.delete(uuid)
    })

    tailer.start().catch(() => {
      this.turnWatchers.delete(uuid)
    })
  }

  /**
   * Mark a session as succeeded — user says "task done". Kills the tmux
   * session to free resources, then transitions to `succeeded` (terminal,
   * read-only). Session file + transcript stay for review.
   */
  async archive(uuid: string): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    // Sleeping sessions can also be archived — no tmux to kill, straight
    // path to 'succeeded'. The state machine already allows sleeping →
    // succeeded; this guard was the only thing rejecting the flow.
    const ARCHIVABLE: SessionStatus[] = ['needs_input', 'idle', 'waiting', 'running', 'sleeping']
    if (!ARCHIVABLE.includes(session.status)) {
      throw new Error(`Cannot archive session in ${session.status} state`)
    }

    // Close watcher
    const watcher = this.turnWatchers.get(uuid)
    if (watcher) {
      watcher.close()
      this.turnWatchers.delete(uuid)
    }

    // Kill tmux — session archived means we don't need the process anymore
    const adapter = this.registry.getOrThrow(session.agentType)
    await adapter.kill(handleFor(session)).catch(() => { /* tmux may already be gone */ })

    // Direct terminal transition. Every allowed pre-state (idle,
    // needs_input, running, sleeping) goes straight to 'succeeded'.
    const succeeded = await this.transition(uuid, 'succeeded')

    // Terminal-report callback: if this session had a parent, deliver a
    // sanitized summary to the parent's input (tycho-style). Fire-and-forget.
    if (session.parentSessionId) {
      this.deliverTerminalReport(session.parentSessionId, session).catch((err) =>
        console.warn(`[session-manager] terminal-report to parent failed: ${(err as Error).message}`),
      )
    }
    return succeeded
  }

  /** Read last assistant text from a session's JSONL (best-effort summary). */
  private async readLastAssistantText(jsonlPath: string): Promise<string> {
    try {
      const { readFile } = await import('node:fs/promises')
      const raw = await readFile(jsonlPath, 'utf8')
      let last = ''
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const o = JSON.parse(line) as {
            type?: string
            message?: { content?: Array<{ type?: string; text?: string }> }
          }
          if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
            for (const b of o.message!.content!) {
              if (b.type === 'text' && b.text) last = b.text
            }
          }
        } catch { /* skip */ }
      }
      return last
    } catch { return '' }
  }

  /**
   * Deliver a terminal report to the parent session — sanitized summary
   * queued as a user turn. Uses sendInput which handles all statuses.
   */
  private async deliverTerminalReport(parentId: string, child: SessionMetadata): Promise<void> {
    const parent = await readJson<SessionMetadata | null>(this.sessionPath(parentId), null)
    if (!parent) return
    // Only deliver if parent is alive (not terminal).
    const TERMINAL: SessionStatus[] = ['succeeded', 'failed', 'killed']
    if (TERMINAL.includes(parent.status)) return

    const summary = (await this.readLastAssistantText(child.jsonlPath)).slice(0, 800)
    const report = [
      `[Child session ${child.id.slice(0, 8)} archived — status: ${child.status}]`,
      child.initialPrompt ? `Original prompt: ${child.initialPrompt.slice(0, 200)}` : '',
      summary ? `Final response: ${summary}` : '(no assistant output)',
    ].filter(Boolean).join('\n')

    await this.sendInput(parentId, report).catch(() => { /* parent might be busy */ })
  }

  async transition(uuid: string, newStatus: SessionStatus): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    const allowed = ALLOWED_TRANSITIONS[session.status]
    if (!allowed.includes(newStatus)) {
      throw new InvalidTransitionError(session.status, newStatus)
    }

    const terminal: SessionStatus[] = ['succeeded', 'failed', 'killed']
    const now = new Date().toISOString()
    const IDLE_STATES: SessionStatus[] = ['idle', 'needs_input']
    // Track idleSince: set when entering an idle-ish state, clear when leaving.
    let nextIdleSince: string | null | undefined = session.idleSince ?? null
    if (IDLE_STATES.includes(newStatus) && !IDLE_STATES.includes(session.status)) {
      nextIdleSince = now
    } else if (!IDLE_STATES.includes(newStatus)) {
      nextIdleSince = null
    }
    const updated: SessionMetadata = {
      ...session,
      status: newStatus,
      endedAt: terminal.includes(newStatus) ? now : session.endedAt,
      idleSince: nextIdleSince,
      lastActivityAt: now,
    }

    await writeJson(this.sessionPath(uuid), updated)

    // Sweeper arming based on target state. `updated` is passed so the
    // sweeper can see the session's mode without a second read.
    if (IDLE_STATES.includes(newStatus)) {
      this.armIdleSweeper(uuid, updated)
    } else {
      this.clearIdleSweeper(uuid)
    }

    return updated
  }

  // ── Idle sweeper (warm-shutdown after inactivity) ─────────────────

  /** Arm a per-session warm-shutdown timer. No-op when idleTimeoutMs = 0,
   *  and no-op for headless sessions.
   *
   *  Warm-shutdown exists to release a tmux window that an idle session is
   *  still holding. A headless session between turns holds nothing — the
   *  child exited when the turn ended — so `sleeping` would be a state with
   *  no resource behind it, and waking would be a no-op that only makes the
   *  next send slower to reason about. Idle IS the resting state there. */
  private armIdleSweeper(uuid: string, session?: SessionMetadata): void {
    if (this.idleTimeoutMs <= 0) return
    if (session && !resolveUseTmux(session.useTmux)) return
    // Cancel any existing timer so we don't accumulate.
    this.clearIdleSweeper(uuid)
    const t = setTimeout(() => {
      this.warmShutdown(uuid).catch((err) => {
        console.warn(`[session-manager] warmShutdown ${uuid.slice(0, 8)} failed: ${(err as Error).message}`)
      })
    }, this.idleTimeoutMs)
    // Node timers hold the event loop open — unref so the process can exit
    // cleanly on shutdown without waiting for them.
    if (typeof t.unref === 'function') t.unref()
    this.idleSweepers.set(uuid, t)
  }

  private clearIdleSweeper(uuid: string): void {
    const t = this.idleSweepers.get(uuid)
    if (t) {
      clearTimeout(t)
      this.idleSweepers.delete(uuid)
    }
  }

  /**
   * Kill the tmux window and transition the session to 'sleeping'. Called
   * by the idle timer and by the safety-net sweep. Idempotent — a session
   * already sleeping (or terminal) is a no-op.
   */
  async warmShutdown(uuid: string): Promise<void> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) return
    const IDLE_STATES: SessionStatus[] = ['idle', 'needs_input']
    if (!IDLE_STATES.includes(session.status)) return
    // Defence in depth: nothing should arm a sweeper for a headless session,
    // but a stale timer surviving a mode flip must not push it to `sleeping`
    // — a state it can never be woken out of, since wake-up resumes a tmux.
    if (!resolveUseTmux(session.useTmux)) return
    const adapter = this.registry.getOrThrow(session.agentType)
    await adapter.kill(handleFor(session)).catch(() => { /* tmux may already be dead */ })
    // Close any dangling watcher.
    const w = this.turnWatchers.get(uuid)
    if (w) { w.close(); this.turnWatchers.delete(uuid) }
    await this.transition(uuid, 'sleeping').catch(() => { /* race with kill */ })
  }

  /** Called from server boot — reconcile in-memory timers with disk state. */
  async resumeIdleSweepers(): Promise<void> {
    if (this.idleTimeoutMs <= 0) return
    const sessions = await this.list()
    const IDLE_STATES: SessionStatus[] = ['idle', 'needs_input']
    const now = Date.now()
    for (const s of sessions) {
      if (!IDLE_STATES.includes(s.status)) continue
      // Headless sessions never sleep — see armIdleSweeper.
      if (!resolveUseTmux(s.useTmux)) continue
      const since = s.idleSince ? Date.parse(s.idleSince) : Date.parse(s.endedAt ?? s.startedAt)
      const idleFor = now - since
      if (idleFor >= this.idleTimeoutMs) {
        // Already past threshold — warm-shutdown immediately.
        this.warmShutdown(s.id).catch(() => {})
      } else {
        // Arm a shortened timer for the remaining time.
        const remaining = this.idleTimeoutMs - idleFor
        this.clearIdleSweeper(s.id)
        const t = setTimeout(() => {
          this.warmShutdown(s.id).catch(() => {})
        }, remaining)
        if (typeof t.unref === 'function') t.unref()
        this.idleSweepers.set(s.id, t)
      }
    }
    // Safety-net sweep — every 10 minutes, catch orphans whose timer got lost.
    if (!this.safetyNetSweep) {
      this.safetyNetSweep = setInterval(() => {
        this.sweepOrphans().catch(() => {})
      }, 10 * 60 * 1000)
      if (typeof this.safetyNetSweep.unref === 'function') this.safetyNetSweep.unref()
    }
    // AskUserQuestion pane sweep — every 20s scan tmux panes of running
    // claude sessions for the interactive selector modal and flip to
    // needs_input when detected. Current Claude buffers tool_use/turn_duration
    // until the modal is answered, so JSONL-based reconciliation alone can't
    // see the pending question.
    if (!this.askUserSweep) {
      this.askUserSweep = setInterval(() => {
        this.sweepAskUserPrompts().catch(() => {})
      }, 20 * 1000)
      if (typeof this.askUserSweep.unref === 'function') this.askUserSweep.unref()
    }
  }

  /**
   * Scan tmux panes of `running` / `needs_input` claude sessions for an
   * interactive selector modal — AskUserQuestion, permission approval, etc.
   * When found: transition to `needs_input` AND capture the prompt into
   * session.pendingPrompt so the dashboard can render an approval banner.
   * Codex uses a different approval model and is skipped. Best-effort —
   * pane capture failures are silent.
   */
  private async sweepAskUserPrompts(): Promise<void> {
    const sessions = await this.list()
    const tmux = await import('../adapters/tmux.js')
    for (const s of sessions) {
      // Also scan needs_input so we can clear pendingPrompt when the modal
      // is dismissed externally (user hit Escape in tmux, another agent
      // answered, etc.).
      if (s.status !== 'running' && s.status !== 'needs_input') continue
      // Scan BOTH claude and codex. Codex spawns with --ask-for-approval never
      // so approval modals should not appear, but the first-workspace trust
      // prompt (auto-dismissed by the adapter) and future codex TUI modals
      // can still surface. The parser regex (↑/↓ to navigate + Enter to
      // select) is a universal TUI convention and matches both harnesses'
      // selector shape when it does appear. Opencode is not scanned yet.
      if (s.agentType !== 'claude' && s.agentType !== 'codex') continue
      // Headless has no pane to capture — its `tmuxName` is a synthetic
      // handle key, so capturePane would just fail into the catch below on
      // every tick. Its needs_input comes from the structured inquiry.
      if (!resolveUseTmux(s.useTmux)) continue
      if (!s.tmuxName) continue
      try {
        const pane = await tmux.capturePane(s.tmuxName)
        // Try native selector modal first (Bash/WebFetch/etc. approval);
        // fall back to MCP tool approval modal (different shape — see
        // parseMcpToolModal). Either result exposes as PendingPromptBanner.
        const prompt = parseSelectorModal(pane) ?? parseMcpToolModal(pane)
        if (prompt) {
          if (s.status === 'running') {
            await this.reconcilePendingUserQuestion(s.id).catch(() => {})
          }
          await this.setPendingPrompt(s.id, prompt).catch(() => {})
        } else if (s.pendingPrompt) {
          // Modal gone but stale prompt on record — clear it
          await this.setPendingPrompt(s.id, null).catch(() => {})
        }
      } catch { /* pane may be gone if tmux was killed between list & capture */ }
    }
  }

  /** Merge (or clear) the pendingPrompt field on a session record. Only
   *  writes when the payload actually differs — avoids rewriting the file
   *  on every 20s sweep tick when nothing changed. */
  async setPendingPrompt(uuid: string, prompt: import('@agent-hq-orchestron/shared').PendingPrompt | null): Promise<void> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) return
    const cur = session.pendingPrompt
    // Compare by shape ignoring capturedAt so a re-scan of the same modal
    // doesn't churn the record.
    const same =
      (cur == null && prompt == null) ||
      (!!cur && !!prompt &&
        cur.kind === prompt.kind &&
        cur.title === prompt.title &&
        (cur.detail ?? '') === (prompt.detail ?? '') &&
        cur.options.length === prompt.options.length &&
        cur.options.every((o, i) => o === prompt.options[i]))
    if (same) return
    await writeJson(this.sessionPath(uuid), { ...session, pendingPrompt: prompt })
  }

  /** Answer a pending selector modal by index (1-based, matching how the
   *  options are numbered in the TUI). Sends `Down`×(index-1) + `Enter` to
   *  the tmux pane. Also clears `pendingPrompt` optimistically so the UI
   *  banner disappears before the next sweep tick. */
  async answerPendingPrompt(uuid: string, index: number): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)
    if (!session.pendingPrompt) throw new Error(`No pending prompt for session ${uuid}`)
    const total = session.pendingPrompt.options.length
    if (!Number.isInteger(index) || index < 1 || index > total) {
      throw new Error(`Invalid choice ${index} — must be 1..${total}`)
    }
    const tmux = await import('../adapters/tmux.js')
    const keys: string[] = []
    for (let i = 1; i < index; i++) keys.push('Down')
    keys.push('Enter')
    await tmux.sendKeySequence(session.tmuxName, keys)
    await this.setPendingPrompt(uuid, null)
    const after = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    return after ?? session
  }

  /** Patch the model/effort fields on a session record. Restricted to
   *  states where the tmux is NOT live (terminal or sleeping) — active
   *  sessions have claude already bound to a specific model, so metadata
   *  edits alone wouldn't take effect until a Respawn/wake anyway.
   *  Empty string clears the override so the session falls back to the
   *  project default; `undefined` leaves the field untouched. */
  async updateMetadata(
    uuid: string,
    patch: { model?: string; effort?: import('@agent-hq-orchestron/shared').EffortLevel | ''; useTmux?: boolean },
  ): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)
    // Editable whenever no live process is bound to the current values.
    // For tmux that means terminal or sleeping — an idle tmux session still
    // has a claude bound to its model, so an edit there would silently not
    // take effect until the next spawn.
    //
    // A headless session between turns has no process at all: `idle` and
    // `needs_input` are its resting states and the next turn re-reads the
    // record from scratch. Editing there is both safe and the only moment a
    // multi-turn headless session is ever editable, so it is allowed.
    const EDITABLE: SessionStatus[] = ['succeeded', 'killed', 'failed', 'sleeping']
    const HEADLESS_AT_REST: SessionStatus[] = ['idle', 'needs_input']
    const headlessAtRest =
      !resolveUseTmux(session.useTmux) && HEADLESS_AT_REST.includes(session.status)
    if (!EDITABLE.includes(session.status) && !headlessAtRest) {
      throw new Error(
        `Cannot edit metadata on active session (status: ${session.status}). ` +
        `Kill it or let it sleep first — metadata edits only apply on next spawn.`,
      )
    }
    const next: SessionMetadata = { ...session }
    if (patch.model !== undefined) {
      next.model = patch.model === '' ? undefined : patch.model
    }
    if (patch.effort !== undefined) {
      next.effort = patch.effort === '' ? undefined : patch.effort
    }
    // Same EDITABLE gate as model/effort — the mode is baked into argv at
    // spawn, so changing it mid-flight would desync the record from the
    // running process. Stored as an explicit boolean (never cleared back to
    // undefined) so the next spawn reads an unambiguous value.
    if (patch.useTmux !== undefined) {
      next.useTmux = patch.useTmux
    }
    await writeJson(this.sessionPath(uuid), next)
    return next
  }

  private async sweepOrphans(): Promise<void> {
    if (this.idleTimeoutMs <= 0) return
    const sessions = await this.list()
    const IDLE_STATES: SessionStatus[] = ['idle', 'needs_input']
    const now = Date.now()
    for (const s of sessions) {
      if (!IDLE_STATES.includes(s.status)) continue
      if (!resolveUseTmux(s.useTmux)) continue     // headless never sleeps
      if (this.idleSweepers.has(s.id)) continue    // covered by primary timer
      const since = s.idleSince ? Date.parse(s.idleSince) : Date.parse(s.endedAt ?? s.startedAt)
      if (now - since >= this.idleTimeoutMs) {
        console.warn(`[session-manager] safety-net sweep: warm-shutdown orphan ${s.id.slice(0, 8)}`)
        this.warmShutdown(s.id).catch(() => {})
      } else {
        // Re-arm primary timer.
        this.armIdleSweeper(s.id)
      }
    }
  }

  async resume(uuid: string, workspace: string): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    const adapter = this.registry.getOrThrow(session.agentType)
    await adapter.resume(session.claudeSessionUuid, { workspace })
    return session
  }

  /**
   * Reopen a terminal (succeeded/killed/failed) session — bring it back to
   * `idle` state by spawning a fresh tmux + claude with --resume so the same
   * Claude session continues. Same orchestron UUID, same claudeSessionUuid,
   * new tmux name.
   */
  /**
   * Respawn a terminal session IN-PLACE — reuses the same orchestron session
   * id + record, but starts a fresh Claude conversation (new claudeSessionUuid,
   * new tmux, new JSONL). initialPrompt / model / effort / project all
   * preserved. Old Claude JSONL is left on disk untouched (Claude CLI owns
   * that directory).
   *
   * Contrast with reopen(): reopen keeps the same claudeSessionUuid and
   * resumes the prior conversation. Respawn discards the prior conversation
   * and starts over from the initialPrompt.
   */
  async respawn(uuid: string, workspace: string, configDir?: string, fallbackModel?: string, fallbackEffort?: import('@agent-hq-orchestron/shared').EffortLevel, overrides?: { model?: string; effort?: import('@agent-hq-orchestron/shared').EffortLevel }): Promise<SessionMetadata> {
    return this.withLock(`uuid:${uuid}`, () => this._respawnUnlocked(uuid, workspace, configDir, fallbackModel, fallbackEffort, overrides))
  }

  private async _respawnUnlocked(uuid: string, workspace: string, configDir?: string, fallbackModel?: string, fallbackEffort?: import('@agent-hq-orchestron/shared').EffortLevel, overrides?: { model?: string; effort?: import('@agent-hq-orchestron/shared').EffortLevel }): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    const TERMINAL: SessionStatus[] = ['succeeded', 'killed', 'failed']
    if (!TERMINAL.includes(session.status)) {
      throw new Error(`Cannot respawn session in ${session.status} state — only terminal states are supported`)
    }

    // Spawn a fresh Claude conversation. adapter.spawn() generates a new
    // claudeSessionUuid internally + returns handle with new tmuxName + jsonlPath.
    const adapter = this.registry.getOrThrow(session.agentType)
    const mcpConfigPath = await this.ensureSessionMcpConfig(uuid)
    const { effectiveClaudeConfigDir, mangleCwd } = await import('../adapters/claude.js')
    const effectiveConfigDir = session.agentType === 'claude'
      ? effectiveClaudeConfigDir(configDir ?? session.configDir)
      : (configDir ?? session.configDir)
    await this.ensureMemorySymlink(session.agentType, effectiveConfigDir, workspace)
    const effectiveModel = overrides?.model ?? session.model ?? fallbackModel
    const effectiveEffort = overrides?.effort ?? session.effort ?? fallbackEffort
    // Respawn keeps the session's own mode — a headless session respawns
    // headless, a tmux session respawns into tmux.
    const useTmux = resolveUseTmux(session.useTmux)

    const handle = await adapter.spawn({
      projectId: session.projectId,
      agentType: session.agentType,
      initialPrompt: session.initialPrompt,
      workspace,
      configDir: effectiveConfigDir,
      model: effectiveModel,
      effort: effectiveEffort,
      detached: session.detached,
      useTmux,
      mcpConfigPath,
    })

    // Transition terminal → spawning first (state machine now allows this),
    // then overwrite the mutable identity fields with the new Claude session.
    await this.transition(uuid, 'spawning')
    const updated: SessionMetadata = {
      ...session,
      status: 'spawning',
      claudeSessionUuid: handle.claudeUuid,
      tmuxName: handle.tmuxName,
      jsonlPath: handle.jsonlPath,
      configDir: effectiveConfigDir,
      cwdSlug: mangleCwd(workspace),
      useTmux,
      model: effectiveModel,
      effort: effectiveEffort,
      endedAt: null,
      idleSince: null,
      finalResponse: null,
      tokenUsage: null,
      costUsd: null,
      failureReason: undefined,
    }
    await writeJson(this.sessionPath(uuid), updated)

    // Kick off the async completion — waitTuiReady → paste → running.
    this.completeSpawn(uuid, adapter, handle, session.initialPrompt, {
      projectId: session.projectId,
      agentType: session.agentType,
      initialPrompt: session.initialPrompt,
      workspace,
      configDir: effectiveConfigDir,
      model: effectiveModel,
      effort: effectiveEffort,
      detached: session.detached,
      useTmux,
    }).catch(async (err: unknown) => {
      const msg = (err as Error).message ?? String(err)
      console.error(`[session-manager] completeSpawn during respawn failed for ${uuid}: ${msg}`)
      try {
        const rec = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
        if (rec && rec.status !== 'failed') {
          await this.transition(uuid, 'failed').catch(() => {})
        }
      } catch { /* ignore */ }
    })

    return updated
  }

  /** Public wrapper around findLiveHarnessProcess so routes can reuse the
   *  cross-process check without importing the internal helper. */
  async findLiveHarnessProcessPublic(harnessSessionId: string): Promise<{ pid: number; cmd: string } | null> {
    return findLiveHarnessProcess(harnessSessionId)
  }

  /**
   * Adopt an existing harness session (started outside orchestron — e.g. via
   * `claude --resume` in a terminal, or a nafu-bg-claude/claw-bg-claude
   * background job) into a new orchestron session record. Spawns a fresh
   * tmux window with the harness's native resume flag so the session becomes
   * live-manageable via the dashboard (interrupt, send input, kill, reopen).
   *
   * Validation blocks creation when:
   * - The harness transcript doesn't exist at the expected path for the
   *   given project's workspace + configDir (usually means the UUID was
   *   started in a different cwd, or was typed wrong).
   * - An active orchestron session already tracks this harness UUID —
   *   spawning a second tmux `--resume` against the same JSONL would race
   *   the writer and corrupt the transcript.
   *
   * `initialPrompt` is populated from the first user event in the transcript
   * so the dashboard shows something meaningful; the prompt is NOT re-sent
   * to the resumed session (the conversation already has its history).
   */
  async adopt(config: {
    projectId: string
    agentType: import('@agent-hq-orchestron/shared').AgentType
    workspace: string
    configDir?: string
    model?: string
    effort?: import('@agent-hq-orchestron/shared').EffortLevel
    harnessSessionId: string
  }): Promise<SessionMetadata> {
    return this.withLock(`adopt:${config.harnessSessionId}`, () => this._adoptUnlocked(config))
  }

  private async _adoptUnlocked(config: {
    projectId: string
    agentType: import('@agent-hq-orchestron/shared').AgentType
    workspace: string
    configDir?: string
    model?: string
    effort?: import('@agent-hq-orchestron/shared').EffortLevel
    /** The UUID the harness assigned to the existing conversation the user
     *  wants to bring into orchestron. Matches claudeSessionUuid on the new
     *  record — same field for both harnesses. */
    harnessSessionId: string
  }): Promise<SessionMetadata> {
    const active = await this.countActiveSessions()
    if (active >= this.maxConcurrent) throw new PoolFullError(this.maxConcurrent)

    if (config.agentType !== 'claude' && config.agentType !== 'codex') {
      throw new Error(`Adopt is not supported for agent type '${config.agentType}'`)
    }
    if (!config.harnessSessionId || !/^[0-9a-fA-F-]{8,}$/.test(config.harnessSessionId)) {
      throw new Error(`Invalid harness session id: '${config.harnessSessionId}'`)
    }

    // Uniqueness — active session with this claudeSessionUuid means a
    // resume from a second tmux would race the JSONL writer.
    const all = await this.list()
    const ACTIVE: SessionStatus[] = ['spawning', 'waiting', 'running', 'idle', 'needs_input', 'sleeping']
    const dup = all.find((s) => s.claudeSessionUuid === config.harnessSessionId && ACTIVE.includes(s.status))
    if (dup) {
      throw new Error(`Harness session ${config.harnessSessionId.slice(0, 8)} is already adopted by orchestron session ${dup.id.slice(0, 8)} (status: ${dup.status}). Archive or kill it first, or reopen that record instead.`)
    }

    // Cross-process check: even if orchestron has no record, some other
    // supervisor (nafu-bg-claude, a manual `claude --resume` in a terminal,
    // another orchestron instance) may already be resuming this UUID. Two
    // writers on the same JSONL/rollout corrupt the transcript.
    const liveProc = await findLiveHarnessProcess(config.harnessSessionId)
    if (liveProc) {
      throw new Error(`Harness session ${config.harnessSessionId.slice(0, 8)} is currently held by PID ${liveProc.pid} (cmd: ${liveProc.cmd.slice(0, 120)}…). Stop that process first — a second tmux --resume against the same transcript would race the writer and corrupt it.`)
    }

    // Verify the harness has a record of this session on disk / in SQLite.
    // Also read the first user prompt so the dashboard has a title.
    let initialPrompt = ''
    let expectedJsonlPath = ''
    if (config.agentType === 'claude') {
      const { claudeTranscriptPath, effectiveClaudeConfigDir } = await import('../adapters/claude.js')
      const effCfg = effectiveClaudeConfigDir(config.configDir)
      expectedJsonlPath = claudeTranscriptPath(config.workspace, effCfg, config.harnessSessionId)
      const { existsSync } = await import('node:fs')
      if (!existsSync(expectedJsonlPath)) {
        throw new Error(`Claude transcript not found at ${expectedJsonlPath}. Confirm the UUID and that the session was started in this project's workspace (${config.workspace}).`)
      }
      initialPrompt = readFirstUserPromptFromJsonl(expectedJsonlPath) ?? '(adopted claude session — first prompt unknown)'
    } else {
      // codex — check rollout dir first, fall back to thread_history SQLite
      // (interactive TUI sessions don't write rollout files).
      const { findCodexRolloutPath, effectiveCodexHome } = await import('../adapters/codex.js')
      const rolloutPath = await findCodexRolloutPath(config.configDir, config.harnessSessionId)
      if (rolloutPath) {
        expectedJsonlPath = rolloutPath
        // Codex rollout has a totally different JSONL schema than Claude —
        // use the codex-specific parser (skips CLI-injected wrappers like
        // <environment_context> so the returned text is what the user typed).
        initialPrompt = readFirstUserPromptFromCodexRollout(rolloutPath) ?? '(adopted codex session — first prompt unknown)'
      } else {
        const codexHome = effectiveCodexHome(config.configDir)
        const dbPath = path.join(codexHome, 'thread_history_1.sqlite')
        // Verify the thread exists in SQLite (TUI-only sessions never write
        // rollout jsonl). Real schema is thread_items(item_type=..., item_json)
        // — earlier draft used `type='user_input'` which doesn't exist.
        let exists = false
        try {
          const db = new Database(dbPath, { readonly: true, fileMustExist: true })
          const row = db.prepare(
            `SELECT 1 FROM thread_items WHERE thread_id = ? LIMIT 1`,
          ).get(config.harnessSessionId) as { '1': number } | undefined
          db.close()
          exists = !!row
        } catch (err) {
          throw new Error(`Codex session ${config.harnessSessionId} not found in rollout dir (${codexHome}/sessions/...) nor SQLite (${dbPath}): ${(err as Error).message}`)
        }
        if (!exists) {
          throw new Error(`Codex session ${config.harnessSessionId} not found in rollout dir nor SQLite thread_items. Confirm the UUID.`)
        }
        // TUI-only session — extract first userMessage from SQLite.
        initialPrompt = readFirstUserPromptFromCodexSqlite(dbPath, config.harnessSessionId) ?? '(adopted codex TUI-only session — first prompt unknown)'
      }
    }

    const effectiveConfigDir = config.agentType === 'claude'
      ? (await import('../adapters/claude.js')).effectiveClaudeConfigDir(config.configDir)
      : config.configDir
    const effectiveModel = filterModelForHarness(config.model, config.agentType)

    await this.ensureMemorySymlink(config.agentType, effectiveConfigDir, config.workspace)

    const adapter = this.registry.getOrThrow(config.agentType)
    const uuid = crypto.randomUUID()
    const mcpConfigPath = await this.ensureSessionMcpConfig(uuid, config.agentType)
    const handle = await adapter.resume(config.harnessSessionId, {
      workspace: config.workspace,
      configDir: config.configDir,
      model: effectiveModel,
      effort: config.effort,
      mcpConfigPath,
    })

    const now = new Date().toISOString()
    const session: SessionMetadata = {
      id: uuid,
      projectId: config.projectId,
      agentType: config.agentType,
      model: config.model,
      effort: config.effort,
      status: 'spawning',
      parentSessionId: null,
      detached: false,
      claudeSessionUuid: config.harnessSessionId,
      tmuxName: handle.tmuxName,
      jsonlPath: handle.jsonlPath || expectedJsonlPath,
      configDir: effectiveConfigDir,
      initialPrompt,
      finalResponse: null,
      tokenUsage: null,
      costUsd: null,
      startedAt: now,
      endedAt: null,
      lastActivityAt: now,
      metadata: { adopted: true, adoptedAt: now, adoptedFromUuid: config.harnessSessionId },
    }
    await writeJson(this.sessionPath(uuid), session)

    // Same completion path reopen uses — wait TUI ready → transition to idle.
    // We don't re-send the prompt; the resumed conversation has its own
    // history and paste would be interpreted as a new user turn.
    this.completeReopen(uuid, adapter, handle, {
      claudeSessionUuid: config.harnessSessionId,
      workspace: config.workspace,
      configDir: config.configDir,
      model: effectiveModel,
      effort: config.effort,
    }).catch(async (err: unknown) => {
      const msg = (err as Error).message ?? String(err)
      console.error(`[session-manager] adopt completeReopen failed for ${uuid}: ${msg}`)
      try {
        await this.transition(uuid, 'failed').catch(() => {})
        const failed = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
        if (failed) {
          failed.failureReason = msg
          await writeJson(this.sessionPath(uuid), failed)
        }
      } catch { /* ignore */ }
    })

    return session
  }

  async reopen(uuid: string, workspace: string, configDir?: string, fallbackModel?: string, fallbackEffort?: import('@agent-hq-orchestron/shared').EffortLevel, overrides?: { model?: string; effort?: import('@agent-hq-orchestron/shared').EffortLevel }): Promise<SessionMetadata> {
    return this.withLock(`uuid:${uuid}`, () => this._reopenUnlocked(uuid, workspace, configDir, fallbackModel, fallbackEffort, overrides))
  }

  private async _reopenUnlocked(uuid: string, workspace: string, configDir?: string, fallbackModel?: string, fallbackEffort?: import('@agent-hq-orchestron/shared').EffortLevel, overrides?: { model?: string; effort?: import('@agent-hq-orchestron/shared').EffortLevel }): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    const REOPENABLE: SessionStatus[] = ['succeeded', 'killed', 'failed']
    if (!REOPENABLE.includes(session.status)) {
      throw new Error(`Cannot reopen session in ${session.status} state`)
    }

    // Reopen means "resume this conversation in an interactive tmux", i.e. a
    // cross-mode jump. Not supported in Phase 1 and deliberately conservative:
    // for Claude the two modes do share one JSONL store, so it would likely
    // work, but Codex does not — `codex exec` writes a rollout file while the
    // interactive TUI reads thread_history SQLite, so an exec thread is not
    // guaranteed to be visible to `codex resume`. Rather than ship a button
    // that silently works for one harness and not the other, both are gated
    // until cross-mode resume is tested per harness (Phase 2). Respawn, which
    // starts a fresh headless run from the same prompt, stays available.
    if (!resolveUseTmux(session.useTmux)) {
      throw new Error(
        'Cannot reopen a headless session — interactive resume across modes is not supported yet. Use Respawn to run it again.',
      )
    }

    // Refuse when the underlying transcript doesn't exist — happens when the
    // original spawn failed before the agent wrote its first turn.
    // For codex interactive TUI sessions, transcript lives in SQLite (no jsonlPath);
    // skip the file check and verify SQLite has a thread entry instead.
    if (session.agentType === 'codex' && !session.jsonlPath) {
      if (!session.claudeSessionUuid) {
        throw new Error(
          `Cannot reopen: codex session has no thread id — initial spawn failed before processing. Start a fresh session instead.`,
        )
      }
      // Verify thread exists in SQLite
      const base = session.configDir && session.configDir !== '~'
        ? (session.configDir.startsWith('~/') ? path.join(os.homedir(), session.configDir.slice(2)) : session.configDir)
        : path.join(os.homedir(), '.codex')
      const dbPath = path.join(base, 'thread_history_1.sqlite')
      let hasThread = false
      try {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true })
        const row = db.prepare('SELECT 1 FROM thread_items WHERE thread_id = ? LIMIT 1').get(session.claudeSessionUuid) as { '1': number } | undefined
        db.close()
        hasThread = !!row
      } catch { /* SQLite not accessible */ }
      if (!hasThread) {
        throw new Error(
          `Cannot reopen: codex thread ${session.claudeSessionUuid} not found in SQLite. Start a fresh session instead.`,
        )
      }
    } else {
      // Claude / codex-exec path: check JSONL rollout file exists.
      const { existsSync } = await import('node:fs')
      if (!existsSync(session.jsonlPath)) {
        throw new Error(
          `Cannot reopen: original conversation has no transcript on disk (${session.claudeSessionUuid}). ` +
          `The initial spawn likely failed before writing any turn. Start a fresh session with the same prompt instead.`,
        )
      }
    }

    // Precedence for model/effort: caller override > session's own value >
    // project default. Overrides let the user pick a different model/effort
    // just for this reopen without permanently mutating the record.
    const effectiveModel = overrides?.model ?? session.model ?? fallbackModel
    const effectiveEffort = overrides?.effort ?? session.effort ?? fallbackEffort

    const adapter = this.registry.getOrThrow(session.agentType)
    await this.ensureMemorySymlink(session.agentType, configDir ?? session.configDir, workspace)
    // Regenerate MCP config on every reopen so token/URL updates take effect.
    const mcpConfigPath = await this.ensureSessionMcpConfig(uuid)
    const handle = await adapter.resume(session.claudeSessionUuid, {
      workspace,
      configDir,
      model: effectiveModel,
      effort: effectiveEffort,
      mcpConfigPath,
    })

    // Manually rewrite session record — reopen changes tmuxName + jsonlPath
    // + endedAt (cleared) but keeps id, claudeSessionUuid, initialPrompt, etc.
    // Persist the effective model/effort so the UI shows them going forward.
    const updated: SessionMetadata = {
      ...session,
      model: effectiveModel,
      effort: effectiveEffort,
      status: 'spawning',
      tmuxName: handle.tmuxName,
      jsonlPath: handle.jsonlPath,
      endedAt: null,
    }
    await writeJson(this.sessionPath(uuid), updated)

    // Complete the spawn lifecycle (wait TUI ready → transition to idle/waiting).
    // We DON'T re-send the initial prompt on reopen — the resumed session
    // already has all history; user drives via /input for new turns.
    this.completeReopen(uuid, adapter, handle, {
      claudeSessionUuid: session.claudeSessionUuid,
      workspace,
      configDir: configDir ?? session.configDir,
      model: effectiveModel,
      effort: effectiveEffort,
    }).catch(async (err: unknown) => {
      const msg = (err as Error).message ?? String(err)
      console.error(`[session-manager] completeReopen failed for ${uuid}: ${msg}`)
      try {
        await this.transition(uuid, 'failed').catch(() => {})
        const failed = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
        if (failed) {
          failed.failureReason = msg
          await writeJson(this.sessionPath(uuid), failed)
        }
      } catch { /* ignore */ }
    })

    return updated
  }

  private async completeReopen(
    uuid: string,
    adapter: import('@agent-hq-orchestron/shared').AgentAdapter,
    handle: import('@agent-hq-orchestron/shared').TmuxHandle,
    resumeCtx?: {
      claudeSessionUuid: string
      workspace: string
      configDir?: string
      model?: string
      effort?: import('@agent-hq-orchestron/shared').EffortLevel
    },
  ): Promise<void> {
    let currentHandle = handle
    let attempt = 0
    const MAX_ATTEMPTS = 2

    while (true) {
      try {
        await adapter.waitTuiReady(currentHandle, 30_000)
        break
      } catch (err: unknown) {
        const msg = (err as Error).message ?? ''
        const paneDied = msg.includes('can\'t find pane') || msg.includes('no such pane')
        attempt += 1
        if (!paneDied || attempt >= MAX_ATTEMPTS || !resumeCtx) throw err
        console.warn(`[session-manager] tmux pane died during reopen for ${uuid}, retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})`)
        await adapter.kill(currentHandle).catch(() => {})
        const mcpConfigPath = await this.ensureSessionMcpConfig(uuid)
        const fresh = await adapter.resume(resumeCtx.claudeSessionUuid, {
          workspace: resumeCtx.workspace,
          configDir: resumeCtx.configDir,
          model: resumeCtx.model,
          effort: resumeCtx.effort,
          mcpConfigPath,
        })
        currentHandle = fresh
        // Update the session record with the new tmux/jsonl handle.
        const rec = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
        if (rec) {
          await writeJson(this.sessionPath(uuid), {
            ...rec,
            tmuxName: fresh.tmuxName,
            jsonlPath: fresh.jsonlPath,
          })
        }
      }
    }
    // Reopen goes STRAIGHT to idle — no fresh prompt to send.
    await this.transition(uuid, 'waiting')
    await this.transition(uuid, 'running')
    await this.transition(uuid, 'idle')
  }

  /**
   * Clone/fork a session — spawn a NEW orchestron session that inherits the
   * original's Claude conversation (via --resume). Creates a new orchestron
   * UUID + new tmux; original session record is untouched.
   */
  async clone(uuid: string, spawnConfig: Pick<SpawnConfig, 'workspace' | 'configDir'>, extraPrompt?: string, fallbackModel?: string, fallbackEffort?: import('@agent-hq-orchestron/shared').EffortLevel, overrides?: { model?: string; effort?: import('@agent-hq-orchestron/shared').EffortLevel }): Promise<SessionMetadata> {
    return this.withLock(`uuid:${uuid}`, () => this._cloneUnlocked(uuid, spawnConfig, extraPrompt, fallbackModel, fallbackEffort, overrides))
  }

  private async _cloneUnlocked(uuid: string, spawnConfig: Pick<SpawnConfig, 'workspace' | 'configDir'>, extraPrompt?: string, fallbackModel?: string, fallbackEffort?: import('@agent-hq-orchestron/shared').EffortLevel, overrides?: { model?: string; effort?: import('@agent-hq-orchestron/shared').EffortLevel }): Promise<SessionMetadata> {
    const active = await this.countActiveSessions()
    if (active >= this.maxConcurrent) {
      throw new PoolFullError(this.maxConcurrent)
    }

    const original = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!original) throw new Error(`Session not found: ${uuid}`)

    // Fork spawns an interactive tmux against the source conversation, so it
    // is the same cross-mode jump reopen() refuses. Gated for the same
    // reason and until the same Phase 2 verification.
    if (!resolveUseTmux(original.useTmux)) {
      throw new Error(
        'Cannot fork a headless session — interactive resume across modes is not supported yet. Use Respawn to run it again.',
      )
    }

    // Refuse when the source has no transcript to fork from — harness-aware
    // (mirrors the reopen check).
    if (original.agentType === 'codex' && !original.jsonlPath) {
      // Codex interactive TUI writes to SQLite (thread_history_1.sqlite), not
      // a rollout JSONL. Verify the thread row exists.
      if (!original.claudeSessionUuid) {
        throw new Error(
          `Cannot fork: codex session has no thread id — initial spawn failed before processing. Start a fresh session instead.`,
        )
      }
      const codexHome = original.configDir && original.configDir !== '~'
        ? (original.configDir.startsWith('~/') ? path.join(os.homedir(), original.configDir.slice(2)) : original.configDir)
        : path.join(os.homedir(), '.codex')
      const dbPath = path.join(codexHome, 'thread_history_1.sqlite')
      let hasThread = false
      try {
        const db = new Database(dbPath, { readonly: true, fileMustExist: true })
        const row = db.prepare('SELECT 1 FROM thread_items WHERE thread_id = ? LIMIT 1').get(original.claudeSessionUuid) as { '1': number } | undefined
        db.close()
        hasThread = !!row
      } catch { /* SQLite not accessible */ }
      if (!hasThread) {
        throw new Error(
          `Cannot fork: codex thread ${original.claudeSessionUuid} not found in SQLite (${dbPath}). Start a fresh session instead.`,
        )
      }
    } else {
      // Claude / codex-exec path: JSONL rollout file must exist on disk.
      const { existsSync } = await import('node:fs')
      if (!existsSync(original.jsonlPath)) {
        throw new Error(
          `Cannot fork: original conversation has no transcript on disk (${original.claudeSessionUuid}). ` +
          `Nothing to inherit. Start a fresh session instead.`,
        )
      }
    }

    // Overrides let the user pick different model/effort for the fork
    // without touching the original. Falls back to original's, then project.
    const effectiveModel = overrides?.model ?? original.model ?? fallbackModel
    const effectiveEffort = overrides?.effort ?? original.effort ?? fallbackEffort

    const newUuid = crypto.randomUUID()
    const adapter = this.registry.getOrThrow(original.agentType)
    await this.ensureMemorySymlink(original.agentType, spawnConfig.configDir ?? original.configDir, spawnConfig.workspace)
    // Fresh MCP config keyed to the CLONE's uuid so its ORCHESTRON_SESSION_ID
    // reflects the child, not the parent.
    const mcpConfigPath = await this.ensureSessionMcpConfig(newUuid)
    // Spawn via adapter.resume — reuses the ORIGINAL claudeSessionUuid so
    // Claude loads that context. Fresh tmux name.
    const handle = await adapter.resume(original.claudeSessionUuid, {
      workspace: spawnConfig.workspace,
      configDir: spawnConfig.configDir,
      model: effectiveModel,
      effort: effectiveEffort,
      mcpConfigPath,
    })

    const now = new Date().toISOString()
    const session: SessionMetadata = {
      id: newUuid,
      projectId: original.projectId,
      agentType: original.agentType,
      model: effectiveModel,
      effort: effectiveEffort,
      status: 'spawning',
      parentSessionId: original.id,   // record fork lineage
      detached: original.detached,
      claudeSessionUuid: original.claudeSessionUuid,   // share Claude session
      tmuxName: handle.tmuxName,
      jsonlPath: handle.jsonlPath,
      initialPrompt: extraPrompt ? extraPrompt : `(fork of ${original.id.slice(0, 8)})`,
      finalResponse: null,
      tokenUsage: null,
      costUsd: null,
      startedAt: now,
      endedAt: null,
      lastActivityAt: now,
      metadata: { forkedFrom: original.id },
    }

    await writeJson(this.sessionPath(newUuid), session)

    // Complete lifecycle: wait TUI ready, optionally send extraPrompt, transition
    this.completeReopen(newUuid, adapter, handle, {
      claudeSessionUuid: original.claudeSessionUuid,
      workspace: spawnConfig.workspace,
      configDir: spawnConfig.configDir ?? original.configDir,
      model: effectiveModel,
      effort: effectiveEffort,
    })
      .then(async () => {
        if (extraPrompt) {
          // Send the fork's optional new prompt after resume settles
          const inputAllowed: SessionStatus[] = ['idle', 'needs_input', 'waiting']
          const cur = await readJson<SessionMetadata | null>(this.sessionPath(newUuid), null)
          if (cur && inputAllowed.includes(cur.status)) {
            await adapter.sendPrompt(handle, extraPrompt)
            await this.transition(newUuid, 'running').catch(() => {})
            this.watchForTurnEnd(newUuid, handle.jsonlPath)
          }
        }
      })
      .catch(async (err: unknown) => {
        const msg = (err as Error).message ?? String(err)
        console.error(`[session-manager] clone completion failed for ${newUuid}: ${msg}`)
        try {
          await this.transition(newUuid, 'failed').catch(() => {})
          const failed = await readJson<SessionMetadata | null>(this.sessionPath(newUuid), null)
          if (failed) {
            failed.failureReason = msg
            await writeJson(this.sessionPath(newUuid), failed)
          }
        } catch { /* ignore */ }
      })

    return session
  }

  async kill(uuid: string): Promise<SessionMetadata> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    const watcher = this.turnWatchers.get(uuid)
    if (watcher) {
      watcher.close()
      this.turnWatchers.delete(uuid)
    }

    const adapter = this.registry.getOrThrow(session.agentType)
    await adapter.kill(handleFor(session))

    return this.transition(uuid, 'killed')
  }

  /**
   * Permanently remove the orchestron session record and its per-session MCP
   * config (both live + `.bak`). Distinct from `kill` — kill terminates the
   * live tmux and keeps the record in `killed` state for review; deleteRecord
   * removes the record entirely so it no longer appears in list/dashboard.
   *
   * Preserves everything the harness owns:
   * - <CLAUDE_CONFIG_DIR>/projects/<mangled-cwd>/<uuid>.jsonl transcript
   * - <CLAUDE_CONFIG_DIR>/file-history/<uuid>/* edit history
   * - codex rollout jsonl / SQLite thread_history
   * so the same session can be adopted back later via the Adopt flow.
   *
   * Preserves orchestron aggregates that reference the session id:
   * - metrics/sessions.jsonl (historical record)
   * - delegation/*.jsonl (parent/child edges become harmless orphans)
   *
   * State gate: only allowed for terminal states (`succeeded`, `killed`,
   * `failed`) or `sleeping` (no live tmux). For active states the caller
   * must kill first — refuses with a helpful error otherwise. If sleeping
   * still has a lingering tmux window (orphan-scan raced), kills tmux best-
   * effort before wiping the record.
   */
  async deleteRecord(uuid: string): Promise<{ deleted: string[] }> {
    return this.withLock(`uuid:${uuid}`, () => this._deleteRecordUnlocked(uuid))
  }

  private async _deleteRecordUnlocked(uuid: string): Promise<{ deleted: string[] }> {
    const session = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
    if (!session) throw new Error(`Session not found: ${uuid}`)

    const DELETABLE: SessionStatus[] = ['succeeded', 'killed', 'failed', 'sleeping']
    if (!DELETABLE.includes(session.status)) {
      throw new Error(`Cannot delete session in ${session.status} state. Kill it first (its record will move to 'killed' which is deletable).`)
    }

    // Close any in-memory watchers so the fs.watch handle isn't dangling.
    const watcher = this.turnWatchers.get(uuid)
    if (watcher) {
      watcher.close()
      this.turnWatchers.delete(uuid)
    }
    const timer = this.idleSweepers.get(uuid)
    if (timer) {
      clearTimeout(timer)
      this.idleSweepers.delete(uuid)
    }

    // Sleeping sessions have no tmux by construction, but an orphaned tmux
    // could still be alive if the boot-time scan missed it. Best-effort kill
    // via the adapter to avoid leaving a detached tmux writing to the
    // harness's JSONL after the record is gone.
    if (session.tmuxName) {
      try {
        const adapter = this.registry.getOrThrow(session.agentType)
        await adapter.kill(handleFor(session))
      } catch { /* tmux may already be gone — fine */ }
    }

    const { unlink } = await import('node:fs/promises')
    const deleted: string[] = []
    const candidates = [
      this.sessionPath(uuid),
      `${this.sessionPath(uuid)}.bak`,
      this.mcpConfigPath(uuid),
      `${this.mcpConfigPath(uuid)}.bak`,
    ]
    for (const p of candidates) {
      try {
        await unlink(p)
        deleted.push(p)
      } catch { /* file may not exist (e.g. no .bak yet, no mcp config) */ }
    }

    return { deleted }
  }

  /**
   * On boot, resume turn-end watchers for any session still marked `running`.
   * Watchers are in-memory only; without this, a server restart leaves
   * previously-running sessions unable to auto-transition to `awaiting_input`.
   * Uses startOffset=0 so a turn already ended in the JSONL still triggers.
   */
  async resumeWatchers(): Promise<void> {
    const sessions = await this.list()
    // One-time migration: legacy `awaiting_input` sessions become `idle` under
    // the new state model (backward-compat). If we later detect a question in
    // their last assistant text, the next watcher will bump them to needs_input.
    for (const s of sessions) {
      const legacyStatus = s.status as unknown as string
      if (legacyStatus === 'awaiting_input') {
        const migrated: SessionMetadata = { ...s, status: 'idle' }
        await writeJson(this.sessionPath(s.id), migrated).catch(() => {})
      }
    }
    // Re-read after migration
    const fresh = await this.list()
    for (const s of fresh) {
      // Headless has no turn_duration event to watch for, and its `running`
      // sessions are handled as boot orphans just below.
      if (s.status === 'running' && resolveUseTmux(s.useTmux)) {
        this.watchForTurnEnd(s.id, s.jsonlPath, { fromStart: true })
      }
    }

    // Headless boot orphans. A headless turn is owned by an in-memory exit
    // promise inside the adapter; when the API process dies that promise dies
    // with it, and nothing will ever land the turn — the record would sit at
    // `running` forever. The child itself is not detached, so it is normally
    // gone too. Land the session in `idle` rather than `failed`: the turn's
    // output is already in the harness's own transcript, the conversation is
    // still resumable, and the user can just send the next turn.
    for (const s of fresh) {
      if (s.status !== 'running' || resolveUseTmux(s.useTmux)) continue
      console.warn(`[session-manager] boot orphan-scan: headless session ${s.id.slice(0, 8)} was mid-turn at prior shutdown, landing idle`)
      try {
        await this.transition(s.id, 'idle')
        const rec = await readJson<SessionMetadata | null>(this.sessionPath(s.id), null)
        if (rec) {
          rec.failureReason = 'orchestron API restarted while a headless turn was in flight; the turn was not observed to completion. Check the transcript, then send the next turn.'
          await writeJson(this.sessionPath(s.id), rec)
        }
      } catch { /* best-effort */ }
    }
    // Orphan cleanup: sessions marked `spawning` or `waiting` at API boot
    // time got orphaned by the previous process. Their in-flight
    // completeSpawn promise died with the old node process; no watcher
    // resumes them. If we leave them alone they stay stuck forever
    // (pane in tmux may be alive OR gone — either way orchestron doesn't
    // own the completion path any more). Best action: mark them `failed`
    // with a clear reason so the dashboard shows them as recoverable
    // (kill / delete-record / reopen with a fresh spawn), and best-
    // effort kill the tmux to release resources.
    for (const s of fresh) {
      if (s.status === 'spawning' || s.status === 'waiting') {
        const headless = !resolveUseTmux(s.useTmux)
        console.warn(`[session-manager] boot orphan-scan: session ${s.id.slice(0, 8)} was ${s.status} at prior shutdown, marking failed`)
        try {
          if (s.tmuxName) {
            const adapter = this.registry.get(s.agentType)
            if (adapter) {
              await adapter.kill(handleFor(s)).catch(() => {})
            }
          }
          await this.transition(s.id, 'failed').catch(() => {})
          const failed = await readJson<SessionMetadata | null>(this.sessionPath(s.id), null)
          if (failed) {
            failed.failureReason = headless
              ? `orchestron API restarted while the session was still ${s.status}; the headless child was never observed. Respawn to run the prompt again.`
              : `orchestron API restarted while session was still ${s.status}; tmux orphaned. Delete this record and spawn a fresh one.`
            await writeJson(this.sessionPath(s.id), failed)
          }
        } catch { /* best-effort */ }
      }
    }
  }

  async list(filter?: { status?: string; projectId?: string; from?: string; to?: string }): Promise<SessionMetadata[]> {
    const files = await listDir(this.sessionsDir)
    const sessions: SessionMetadata[] = []
    const { existsSync } = await import('node:fs')
    const { resolveClaudeTranscriptPath } = await import('../adapters/claude.js')

    await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => {
          const uuid = f.replace(/\.json$/, '')
          const record = await readJson<SessionMetadata | null>(this.sessionPath(uuid), null)
          if (!record) return
          // Runtime hint: does the transcript still exist on disk? Consumed
          // by the UI to decide if Reopen/Fork are viable (they need the
          // conversation to resume from).
          // - Claude: JSONL file at record.jsonlPath must exist.
          // - Codex interactive: writes to SQLite (~/.codex/thread_history_1.sqlite),
          //   jsonlPath is empty. Use claudeSessionUuid (thread_id) presence as
          //   the indicator — the capture step only populates it after codex
          //   has written to SQLite, so a non-empty thread id == transcript exists.
          // Claude: prefer the recorded path, but fall back to rebuilding it
          // from configDir + cwdSlug + uuid so a record whose jsonlPath was
          // never filled in (spawn died early) or whose workspace moved
          // isn't reported as transcript-less while the file is right there.
          record.hasTranscript = record.agentType === 'codex'
            ? record.claudeSessionUuid !== ''
            : existsSync(resolveClaudeTranscriptPath(record, existsSync))
          sessions.push(record)
        }),
    )

    const filtered = sessions.filter(s => {
      if (filter?.status && s.status !== filter.status) return false
      if (filter?.projectId && s.projectId !== filter.projectId) return false
      if (filter?.from && s.startedAt < filter.from) return false
      if (filter?.to && s.startedAt > filter.to) return false
      return true
    })

    // Order by lastActivityAt desc — reflects the last meaningful event
    // (state transition, user input received, turn ended, wake-up). Falls
    // back to endedAt ?? startedAt for records written before the field
    // existed (pre-2026-09-06 sessions) so old sessions still sort sensibly.
    return filtered.sort((a, b) => {
      const at = a.lastActivityAt ?? a.endedAt ?? a.startedAt
      const bt = b.lastActivityAt ?? b.endedAt ?? b.startedAt
      return at < bt ? 1 : at > bt ? -1 : 0
    })
  }

  private async countActiveSessions(): Promise<number> {
    const all = await this.list()
    // Only sessions holding a LIVE tmux count toward the pool cap.
    // Terminal (succeeded/failed/killed) records are just JSON on disk.
    // Sleeping records are also cheap — tmux was released by the idle
    // sweeper, they wake on next `--resume` — so accumulating them
    // shouldn't block new spawns. Real wake-time overflow is bounded by
    // how many sleeping sessions the user ends up reopening at once,
    // which in practice is small enough not to need its own cap.
    const NON_LIVE: SessionStatus[] = ['succeeded', 'failed', 'killed', 'sleeping']
    // A headless session at rest is the same kind of cheap. Between turns its
    // child process is gone — `idle` / `needs_input` there holds no tmux, no
    // pty and no pid, so counting it would let a pile of finished one-shots
    // block new spawns for nothing. It counts again the moment a turn is
    // actually in flight (`spawning` / `running`).
    const HEADLESS_AT_REST: SessionStatus[] = ['idle', 'needs_input']
    return all.filter((s) => {
      if (NON_LIVE.includes(s.status)) return false
      if (!resolveUseTmux(s.useTmux) && HEADLESS_AT_REST.includes(s.status)) return false
      return true
    }).length
  }
}
