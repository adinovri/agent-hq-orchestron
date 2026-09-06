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
  failureReason?: string
  metadata: Record<string, unknown>
  /** Runtime hint (not persisted): does the underlying Claude JSONL exist
   *  on disk? Populated by the API layer during list/get. Consumers use this
   *  to decide whether reopen/fork will succeed — false means resume will
   *  fail and the only recovery is respawn. */
  hasTranscript?: boolean
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
  group?: string | null
  tags?: string[]
  agentConfig?: AgentConfig
  createdAt: string
  config: Record<string, unknown>
}

export interface DelegationEdge {
  parent: string
  child: string
  spawnPrompt?: string
  createdAt: string
}

export interface DelegationEdges {
  version: 1
  edges: DelegationEdge[]
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
}

export interface TmuxHandle {
  tmuxName: string
  claudeUuid: string
  jsonlPath: string
}

export interface AgentAdapter {
  name: string
  spawn(config: SpawnConfig): Promise<TmuxHandle>
  resume(sessionUuid: string, config: ResumeConfig): Promise<TmuxHandle>
  sendPrompt(handle: TmuxHandle, prompt: string): Promise<void>
  waitTuiReady(handle: TmuxHandle, timeoutMs: number): Promise<void>
  kill(handle: TmuxHandle): Promise<void>
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
