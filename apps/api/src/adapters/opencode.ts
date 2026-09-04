import type { AgentAdapter, SpawnConfig, ResumeConfig, TmuxHandle } from '@agent-hq-orchestron/shared'

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = 'opencode'

  spawn(_config: SpawnConfig): Promise<TmuxHandle> {
    throw new Error('opencode adapter not yet implemented — enable in config first')
  }

  resume(_sessionUuid: string, _config: ResumeConfig): Promise<TmuxHandle> {
    throw new Error('opencode adapter not yet implemented — enable in config first')
  }

  sendPrompt(_handle: TmuxHandle, _prompt: string): Promise<void> {
    throw new Error('opencode adapter not yet implemented — enable in config first')
  }

  waitTuiReady(_handle: TmuxHandle, _timeoutMs: number): Promise<void> {
    throw new Error('opencode adapter not yet implemented — enable in config first')
  }

  kill(_handle: TmuxHandle): Promise<void> {
    throw new Error('opencode adapter not yet implemented — enable in config first')
  }
}
