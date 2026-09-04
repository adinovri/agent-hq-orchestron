export type AgentType = 'claude' | 'codex' | 'opencode'

export type SessionStatus =
  | 'spawning'
  | 'waiting'
  | 'running'
  | 'awaiting_input'
  | 'completing'
  | 'completed'
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
  failureReason?: string
  metadata: Record<string, unknown>
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

export interface SpawnConfig {
  projectId: string
  agentType: AgentType
  initialPrompt: string
  parentSessionId?: string
  workspace: string
  model?: string
  configDir?: string
  detached?: boolean
}

export interface ResumeConfig {
  workspace: string
  model?: string
  configDir?: string
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
