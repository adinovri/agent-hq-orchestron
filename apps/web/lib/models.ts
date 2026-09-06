import type { AgentType } from '@agent-hq-orchestron/shared'

export interface ModelOption {
  value: string
  label: string
}

/** Claude model catalog (Claude 5 + prior generation). */
export const CLAUDE_MODELS: ModelOption[] = [
  { value: 'claude-opus-5', label: 'Opus 5 (most capable)' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1 (fast experimental)' },
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (balanced)' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5 (fast + cheap)' },
]

/** Codex model catalog (probed from ~/.codex/models_cache.json, GPT-6/5.x). */
export const CODEX_MODELS: ModelOption[] = [
  { value: 'gpt-6-astra', label: 'GPT-6-Astra (most capable, default)' },
  { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark (coding-tuned)' },
]

/** Return model options for a given harness. Unknown/opencode fall back
 *  to empty; caller can render a free-text input as a fallback. */
export function modelsFor(agentType: AgentType | undefined): ModelOption[] {
  if (agentType === 'claude') return CLAUDE_MODELS
  if (agentType === 'codex') return CODEX_MODELS
  return []
}

/** Effort options — harness-aware. Codex GPT-6 + 5.6 series also support
 *  `ultra` (maximum reasoning + automatic task delegation). Older codex
 *  models cap at `xhigh`. Claude covers low → max. */
export const CLAUDE_EFFORTS: ModelOption[] = [
  { value: 'low', label: 'Low (quick answers)' },
  { value: 'medium', label: 'Medium (balanced)' },
  { value: 'high', label: 'High (thorough)' },
  { value: 'xhigh', label: 'Extra high (deep reasoning)' },
  { value: 'max', label: 'Max (exhaustive)' },
]

export const CODEX_EFFORTS: ModelOption[] = [
  { value: 'low', label: 'Low (quick answers)' },
  { value: 'medium', label: 'Medium (balanced)' },
  { value: 'high', label: 'High (thorough)' },
  { value: 'xhigh', label: 'Extra high (deep reasoning)' },
  { value: 'max', label: 'Max (exhaustive)' },
  { value: 'ultra', label: 'Ultra (max + auto delegation)' },
]

export function effortsFor(agentType: AgentType | undefined): ModelOption[] {
  if (agentType === 'codex') return CODEX_EFFORTS
  return CLAUDE_EFFORTS
}
