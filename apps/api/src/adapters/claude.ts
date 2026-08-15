/**
 * Claude CLI adapter stub — Phase 1 implementation pending.
 *
 * CONSTRAINT: NEVER use `claude -p`. Must use interactive tmux + claude CLI.
 * Reason: `-p` mode consumes Anthropic API credit; tmux interactive mode uses subscription quota.
 */
import type { AgentAdapter, SpawnConfig, ResumeConfig, TmuxHandle } from '@agent-hq-orchestron/shared'

export const claudeAdapter: AgentAdapter = {
  name: 'claude',

  async spawn(_config: SpawnConfig): Promise<TmuxHandle> {
    throw new Error('claudeAdapter.spawn not yet implemented (Phase 1)')
  },

  async resume(_sessionUuid: string, _config: ResumeConfig): Promise<TmuxHandle> {
    throw new Error('claudeAdapter.resume not yet implemented (Phase 1)')
  },

  async sendPrompt(_handle: TmuxHandle, _prompt: string): Promise<void> {
    throw new Error('claudeAdapter.sendPrompt not yet implemented (Phase 1)')
  },

  async waitTuiReady(_handle: TmuxHandle, _timeoutMs: number): Promise<void> {
    throw new Error('claudeAdapter.waitTuiReady not yet implemented (Phase 1)')
  },

  async kill(_handle: TmuxHandle): Promise<void> {
    throw new Error('claudeAdapter.kill not yet implemented (Phase 1)')
  },
}
