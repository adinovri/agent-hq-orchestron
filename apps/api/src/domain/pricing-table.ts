export interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
  cacheReadPer1M?: number
  cacheCreationPer1M?: number
}

// Standard tier rates used for models whose exact per-token pricing we
// haven't verified yet — same-generation successors inherit the tier
// pricing so cost tracking stays reasonable until we confirm and split
// them out.
const SONNET_TIER: ModelPricing = { inputPer1M: 3.0, outputPer1M: 15.0, cacheReadPer1M: 0.30, cacheCreationPer1M: 3.75 }
const OPUS_TIER:   ModelPricing = { inputPer1M: 15.0, outputPer1M: 75.0, cacheReadPer1M: 1.50, cacheCreationPer1M: 18.75 }
const HAIKU_TIER:  ModelPricing = { inputPer1M: 0.80, outputPer1M: 4.0,  cacheReadPer1M: 0.08, cacheCreationPer1M: 1.0 }

const PRICING: Record<string, ModelPricing> = {
  // Claude 5 family
  'claude-opus-5':    OPUS_TIER,
  'claude-sonnet-5':  SONNET_TIER,
  'claude-fable-5-2': HAIKU_TIER,    // Fable = fast-tier (best guess until confirmed)
  'claude-fable-5':   HAIKU_TIER,
  'claude-fable-5-1': HAIKU_TIER,
  // Prior generation
  'claude-opus-4-8':  OPUS_TIER,
  'claude-sonnet-4-6': SONNET_TIER,
  'claude-haiku-4-5': HAIKU_TIER,
  // Legacy aliases
  'claude-sonnet': {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.30,
    cacheCreationPer1M: 3.75,
  },
  'claude-opus': {
    inputPer1M: 15.0,
    outputPer1M: 75.0,
    cacheReadPer1M: 1.50,
    cacheCreationPer1M: 18.75,
  },
  'claude-haiku': {
    inputPer1M: 0.80,
    outputPer1M: 4.0,
    cacheReadPer1M: 0.08,
    cacheCreationPer1M: 1.0,
  },
}

const DEFAULT_PRICING: ModelPricing = {
  inputPer1M: 3.0,
  outputPer1M: 15.0,
}

export function getPricing(model: string | undefined): ModelPricing {
  if (!model) return DEFAULT_PRICING

  // exact match
  if (PRICING[model]) return PRICING[model]!

  // partial match on prefix (e.g. "claude-sonnet-4-6-20251022" → "claude-sonnet-4-6")
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return pricing
  }

  return DEFAULT_PRICING
}

export function computeCost(
  tokens: { input: number; output: number; cacheRead?: number; cacheCreation?: number },
  model: string | undefined,
): number {
  const p = getPricing(model)
  const inputCost = (tokens.input / 1_000_000) * p.inputPer1M
  const outputCost = (tokens.output / 1_000_000) * p.outputPer1M
  const cacheReadCost = tokens.cacheRead && p.cacheReadPer1M
    ? (tokens.cacheRead / 1_000_000) * p.cacheReadPer1M
    : 0
  const cacheCreationCost = tokens.cacheCreation && p.cacheCreationPer1M
    ? (tokens.cacheCreation / 1_000_000) * p.cacheCreationPer1M
    : 0
  return inputCost + outputCost + cacheReadCost + cacheCreationCost
}
