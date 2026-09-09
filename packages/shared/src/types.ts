export type AgentType = 'claude' | 'codex' | 'opencode'

export type SessionStatus =
  | 'spawning'
  | 'waiting'
  | 'running'
  | 'needs_input'     // Agent posed a question — user answer required
  | 'idle'            // Turn done, session alive, no explicit question
  | 'sleeping'        // Idle beyond threshold, tmux released. Wakes on send.
  | 'succeeded'       // User marked done + session archived (terminal, read-only)
  | 'failed'
  | 'killed'

export interface TokenUsage {
  input: number
  output: number
  cacheRead?: number
  cacheCreation?: number
}

export interface SessionMetadata {
  id: string
  projectId: string
  agentType: AgentType
  model?: string
  effort?: EffortLevel
  status: SessionStatus
  parentSessionId: string | null
  detached: boolean
  claudeSessionUuid: string
  tmuxName: string
  jsonlPath: string
  initialPrompt: string
  finalResponse: string | null
  tokenUsage: TokenUsage | null
  costUsd: number | null
  startedAt: string
  endedAt: string | null
  /** ISO timestamp of the last meaningful activity — state transition,
   *  user input received, turn ended, wake-up. Used as the primary sort
   *  key on the dashboard so live sessions bubble up on real events, not
   *  just spawn time. Falls back to `endedAt ?? startedAt` for records
   *  written before this field existed. */
  lastActivityAt?: string
  /** Timestamp when the session most recently entered idle/needs_input. Used
   *  by the idle-sweeper to schedule warm-shutdown at (idleSince + threshold).
   *  Cleared when the session transitions back to an active state. */
  idleSince?: string | null
  /** Effective CLAUDE_CONFIG_DIR captured at spawn time — the directory
   *  where Claude CLI writes this session's JSONL. Persisted so wake-up /
   *  reopen / clone target the same config dir even if the API process's
   *  env changes across restarts. */
  configDir?: string
  /** Mangled workspace path (`/a/b` → `-a-b`) captured at spawn time. Together
   *  with `configDir` + `claudeSessionUuid` it reconstructs the harness-native
   *  transcript path `<configDir>/projects/<cwdSlug>/<uuid>.jsonl` without
   *  re-deriving it from a project record that may since have moved. */
  cwdSlug?: string
  /** False when this session runs headless (`claude -p` / `codex exec`) —
   *  a one-shot subprocess with no tmux and no live TUI.
   *
   *  ALWAYS read as `session.useTmux ?? true`. Records written before this
   *  field existed have it `undefined`, and those are all tmux sessions —
   *  a bare truthiness check (`!session.useTmux`) would silently reclassify
   *  every legacy session as headless. */
  useTmux?: boolean
  failureReason?: string
  metadata: Record<string, unknown>
  /** Runtime hint (not persisted): does the underlying Claude JSONL exist
   *  on disk? Populated by the API layer during list/get. Consumers use this
   *  to decide whether reopen/fork will succeed — false means resume will
   *  fail and the only recovery is respawn. */
  hasTranscript?: boolean
  /** Set when the pane-scan sweep sees an interactive selector modal in the
   *  Claude TUI (permission approval, AskUserQuestion fallback, etc). Populated
   *  by SessionManager.sweepAskUserPrompts and cleared when the modal is
   *  answered. Frontend renders it as an approval banner in session detail. */
  pendingPrompt?: PendingPrompt | null
  /** Structured question raised by the last headless turn, parsed from the
   *  agent's schema-constrained final response. Set alongside the
   *  `needs_input` transition and cleared when the next turn starts.
   *
   *  Distinct from `pendingPrompt`, which is scraped off a live tmux pane and
   *  is answered by a keystroke. An inquiry is answered by text, which starts
   *  a whole new `-p --resume` turn. */
  pendingInquiry?: Inquiry | null
}

/** One field of a structured inquiry raised by a headless agent.
 *
 *  Shape is dictated by the strict-mode JSON schema handed to the harness
 *  (see `ORCHESTRON_RESULT_SCHEMA`), which is why `options` is present and
 *  nullable rather than optional: Codex/OpenAI strict mode requires every
 *  property to appear in `required`, so "absent" has to be spelled `null`. */
export interface InquiryField {
  name: string
  label: string
  type: 'text' | 'choice' | 'boolean'
  /** Choices for `type: 'choice'`. `null` for every other type. */
  options: string[] | null
}

/** A headless agent's request for user input, parsed out of the structured
 *  final response. Presence of one is what moves a finished headless turn to
 *  `needs_input` instead of `idle`. */
export interface Inquiry {
  message: string
  fields: InquiryField[]
}

/** The whole structured document a headless turn returns when
 *  `headlessStructuredOutput` is on. `inquiry` is null on a turn that needs
 *  nothing from the user. */
export interface HeadlessResultDocument {
  summary: string
  inquiry: Inquiry | null
}

/** Snapshot of an interactive selector modal captured from the tmux pane.
 *  `options` is the numbered choices as displayed (1-indexed labels). `title`
 *  and `detail` are the free-text lines above the options, if any (e.g. the
 *  Bash command being approved). */
export interface PendingPrompt {
  kind: 'permission' | 'question'
  title: string
  detail?: string
  options: string[]
  capturedAt: string
}

export interface AgentConfig {
  adapter?: AgentType
  model?: string
  env?: Record<string, string>
  extraArgs?: string[]
  gitHost?: 'gh' | 'bb'
}

export interface ProjectMetadata {
  id: string
  name: string
  path: string
  agentType: AgentType
  defaultModel?: string
  defaultEffort?: EffortLevel
  /** Project-level default for the tmux/headless toggle. Unset means tmux
   *  (see DEFAULT_USE_TMUX). Read via `resolveUseTmux()`, never bare. */
  defaultUseTmux?: boolean
  group?: string | null
  tags?: string[]
  agentConfig?: AgentConfig
  createdAt: string
  config: Record<string, unknown>
}

/** Internal delegation-tracker storage shape (persisted on disk). Used
 *  by the tracker + list operations; NOT what the /api/delegation/:root
 *  endpoint returns to clients (that reshapes into React-Flow-native
 *  format below). */
export interface DelegationEdge {
  parent: string
  child: string
  spawnPrompt?: string
  createdAt: string
}

/** API response shape from GET /api/delegation/:rootUuid. Edges use the
 *  React Flow-native `source`/`target` keys so the client can pass them
 *  straight through without a translation step (which is where the old
 *  `{parent, child}` client code silently produced `undefined` → dagre
 *  crash → `/graph` blank page). */
export interface DelegationGraphEdge {
  id: string
  source: string
  target: string
  label?: string
}

export interface DelegationEdges {
  nodes: SessionMetadata[]
  edges: DelegationGraphEdge[]
}

export interface Snapshot {
  sessionUuid: string
  prSource: string
  baseRef: string
  worktreePath: string
  readOnly: boolean
  createdAt: string
}

export interface TemplateVariable {
  type: 'string' | 'number' | 'boolean'
  required: boolean
  prompt?: string
  default?: string | number | boolean
}

export interface TemplateFrontmatter {
  name: string
  description?: string
  variables?: Record<string, TemplateVariable>
}

export type HookEvent =
  | 'pre-spawn'
  | 'post-transcript-chunk'
  | 'on-session-end'
  | 'on-error'
  | 'on-schedule-fire'

export interface HookInvocation {
  id: string
  event: HookEvent
  scriptPath: string
  sessionUuid?: string
  exitCode: number
  stderr: string
  durationMs: number
  firedAt: string
}

export interface MetricsRecord {
  sessionUuid: string
  projectId: string
  adapter: AgentType
  model?: string
  tokens: TokenUsage
  costUsd: number
  durationMs: number
  endedAt: string
}

export interface SessionEvent {
  type: 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'end_turn' | 'raw'
  sessionId: string
  timestamp: string
  data: unknown
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export interface SpawnConfig {
  projectId: string
  agentType: AgentType
  initialPrompt: string
  parentSessionId?: string
  workspace: string
  model?: string
  effort?: EffortLevel
  configDir?: string
  detached?: boolean
  /** When false, spawn headless (`claude -p` / `codex exec`) — a one-shot
   *  subprocess instead of an interactive tmux session. Unset means tmux.
   *  Consumers must read it as `useTmux ?? true`, never bare. */
  useTmux?: boolean
  /** Path to a per-session MCP config JSON. Written by session-manager
   *  and passed through so the adapter can hand it to the agent CLI
   *  (`--mcp-config <path>` for Claude). Enables auto-inject of the
   *  orchestron MCP server without user setup. */
  mcpConfigPath?: string
  /** Inline MCP config values for adapters that inject via CLI flags rather
   *  than a config file (e.g. Codex uses `-c 'mcp_servers.NAME.*=VALUE'`).
   *  Passed as a pre-serialized list of key=value strings suitable for
   *  concatenation into argv. Adapter-specific; claude ignores. */
  mcpConfigInline?: string[]
  /** Path to the structured-output JSON schema on disk. Headless only.
   *
   *  Only Codex reads the path — its `--output-schema` flag takes a FILE.
   *  Claude's `--json-schema` takes the schema INLINE as a JSON string and
   *  rejects a path outright, so the Claude adapter serialises the shared
   *  schema object itself and ignores this field. Same split as
   *  mcpConfigPath (claude, file) vs mcpConfigInline (codex, flags).
   *
   *  Unset disables structured output for the run. */
  outputSchemaPath?: string
}

export interface ResumeConfig {
  workspace: string
  model?: string
  effort?: EffortLevel
  configDir?: string
  mcpConfigPath?: string
  /** Inline MCP config values for adapters that inject via CLI flags rather
   *  than a config file (e.g. Codex uses `-c 'mcp_servers.NAME.*=VALUE'`).
   *  Passed as a pre-serialized list of key=value strings suitable for
   *  concatenation into argv. Adapter-specific; claude ignores. */
  mcpConfigInline?: string[]
  /** See SpawnConfig.outputSchemaPath. */
  outputSchemaPath?: string
  /** When false, resume headless: one `claude -p --resume <id>` /
   *  `codex exec resume <id>` child process for this turn instead of an
   *  interactive tmux. Unset means tmux, exactly as on SpawnConfig.
   *
   *  `prompt` is required in that case — a headless invocation has nothing to
   *  do without one, unlike a tmux resume which just re-enters the session
   *  and waits. */
  useTmux?: boolean
  /** The turn's prompt. Headless resume only; the tmux path pastes prompts
   *  through `sendPrompt` after the TUI is up. */
  prompt?: string
}

export interface TmuxHandle {
  /** tmux session name for interactive spawns. For headless spawns there is
   *  no tmux — this holds a synthetic `headless-<rand>` key that the adapter
   *  uses to look the child process up in its own registry. Unique per spawn
   *  either way, so it stays usable as a handle id. */
  tmuxName: string
  claudeUuid: string
  jsonlPath: string
  /** True when this handle refers to a headless child process rather than a
   *  tmux session. Adapters set it; session-manager reads it to pick the
   *  headless lifecycle. */
  headless?: boolean
}

/** Outcome of a headless (one-shot) agent invocation, resolved when the child
 *  process exits. Populated from the CLI's own stdout event stream — the
 *  harness-native JSONL stays the single source of truth for the transcript
 *  itself, so orchestron never writes a second copy. */
export interface HeadlessResult {
  /** Process exit code. `null` when the child was killed by a signal. */
  exitCode: number | null
  /** Harness-assigned session id discovered from the stream. Claude gets its
   *  id pre-assigned via `--session-id`, so this only matters for Codex,
   *  which mints a `thread_id` at `thread.started`. */
  sessionId?: string
  /** Final assistant message, when the stream reported one. */
  finalResponse?: string
  tokenUsage?: TokenUsage
  costUsd?: number
  /** Tail of the child's stderr (bounded) — surfaced as `failureReason` on a
   *  non-zero exit so a headless failure isn't a silent dead end. */
  stderr?: string
}

export interface AgentAdapter {
  name: string
  spawn(config: SpawnConfig): Promise<TmuxHandle>
  resume(sessionUuid: string, config: ResumeConfig): Promise<TmuxHandle>
  sendPrompt(handle: TmuxHandle, prompt: string): Promise<void>
  waitTuiReady(handle: TmuxHandle, timeoutMs: number): Promise<void>
  kill(handle: TmuxHandle): Promise<void>
  /** Headless only: resolve when the one-shot child process for `handle`
   *  exits. The returned promise is created at spawn time, so awaiting it
   *  late still yields the real exit code rather than racing the exit.
   *  Adapters that support headless mode implement it. */
  awaitHeadlessExit?(handle: TmuxHandle): Promise<HeadlessResult>
}

export interface WorktreeLedger {
  sessionUuid: string
  worktreePath: string
  createdAt: string
}

export interface HealthStatus {
  ok: boolean
  tmux: string
  storage: string
}
