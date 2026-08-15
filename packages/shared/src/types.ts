export type AgentType = 'claude' | 'codex' | 'opencode'

export type SessionStatus = 'active' | 'waiting' | 'completed' | 'failed'

export interface SessionMetadata {
  id: string
  projectId: string
  agentType: AgentType
  status: SessionStatus
  parentSessionId: string | null
  claudeSessionUuid: string
  tmuxName: string
  jsonlPath: string
  initialPrompt: string
  finalResponse: string | null
  tokenUsage: { input: number; output: number } | null
  costUsd: number | null
  startedAt: string
  endedAt: string | null
  metadata: Record<string, unknown>
}

export interface ProjectMetadata {
  id: string
  name: string
  path: string
  agentType: AgentType
  createdAt: string
  config: Record<string, unknown>
}

export interface DelegationEdges {
  version: 1
  edges: Array<{ parent: string; child: string; createdAt: string }>
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

export interface HealthStatus {
  ok: boolean
  tmux: string
  storage: string
}
