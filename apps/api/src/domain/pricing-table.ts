export interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
  cacheReadPer1M?: number
  cacheCreationPer1M?: number
}

const PRICING: Record<string, ModelPricing> = {
  // Claude Sonnet 4.6
  'claude-sonnet-4-6': {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheReadPer1M: 0.30,
    cacheCreationPer1M: 3.75,
  },
  // Claude Opus 5
  'claude-opus-5': {
    inputPer1M: 15.0,
    outputPer1M: 75.0,
    cacheReadPer1M: 1.50,
    cacheCreationPer1M: 18.75,
  },
  // Claude Haiku 4.5
  'claude-haiku-4-5': {
    inputPer1M: 0.80,
    outputPer1M: 4.0,
    cacheReadPer1M: 0.08,
    cacheCreationPer1M: 1.0,
  },
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
