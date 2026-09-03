import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { MetricsCollector } from '../src/domain/metrics-collector.js'
import { computeCost, getPricing } from '../src/domain/pricing-table.js'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'

vi.mock('@agent-hq-orchestron/file-store', () => {
  let records: unknown[] = []
  return {
    appendJsonl: vi.fn(async (_path: string, record: unknown) => {
      records.push(record)
    }),
    readJsonlFrom: vi.fn(async () => ({
      lines: records,
      newOffset: 0,
    })),
    __reset: () => { records = [] },
  }
})

import * as fileStore from '@agent-hq-orchestron/file-store'

const reset = (fileStore as unknown as { __reset: () => void }).__reset

function makeSession(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: 'sess-001',
    projectId: 'proj-alpha',
    agentType: 'claude',
    model: 'claude-sonnet-4-6',
    status: 'completed',
    parentSessionId: null,
    detached: false,
    claudeSessionUuid: 'sess-001',
    tmuxName: 'orch-xxx',
    jsonlPath: '/tmp/x.jsonl',
    initialPrompt: 'do something',
    finalResponse: 'done',
    tokenUsage: { input: 1000, output: 500, cacheRead: 0, cacheCreation: 0 },
    costUsd: 0,
    startedAt: '2026-09-01T10:00:00.000Z',
    endedAt: '2026-09-01T10:05:00.000Z',
    metadata: {},
    ...overrides,
  }
}

describe('MetricsCollector.record', () => {
  beforeEach(() => { reset(); vi.clearAllMocks() })

  it('records a completed session', async () => {
    const col = new MetricsCollector('/data')
    await col.record(makeSession())
    expect(vi.mocked(fileStore.appendJsonl)).toHaveBeenCalledTimes(1)
    const [, record] = vi.mocked(fileStore.appendJsonl).mock.calls[0]!
    expect((record as Record<string, unknown>)['sessionUuid']).toBe('sess-001')
  })

  it('skips session without tokenUsage', async () => {
    const col = new MetricsCollector('/data')
    await col.record(makeSession({ tokenUsage: null }))
    expect(vi.mocked(fileStore.appendJsonl)).not.toHaveBeenCalled()
  })

  it('skips session without endedAt', async () => {
    const col = new MetricsCollector('/data')
    await col.record(makeSession({ endedAt: null }))
    expect(vi.mocked(fileStore.appendJsonl)).not.toHaveBeenCalled()
  })
})

describe('MetricsCollector.query — rollup by project', () => {
  beforeEach(() => reset())

  it('sums 10 sessions into correct bucket totals', async () => {
    const col = new MetricsCollector('/data')

    for (let i = 0; i < 10; i++) {
      await col.record(makeSession({
        id: `sess-${i}`,
        projectId: 'proj-alpha',
        tokenUsage: { input: 1000, output: 500 },
        startedAt: '2026-09-01T10:00:00.000Z',
        endedAt: '2026-09-01T10:05:00.000Z',
      }))
    }

    const result = await col.query({ groupBy: 'project' })
    expect(result.total.sessions).toBe(10)
    expect(result.total.tokens).toBe(10 * 1500)

    const bucket = result.buckets.find(b => b.key === 'proj-alpha')!
    expect(bucket.sessions).toBe(10)
    expect(bucket.tokens).toBe(10 * 1500)
    expect(bucket.avg_duration_ms).toBe(5 * 60 * 1000)
  })
})

describe('MetricsCollector.query — date range filter', () => {
  beforeEach(() => reset())

  it('filters by from/to date range', async () => {
    const col = new MetricsCollector('/data')

    await col.record(makeSession({ id: 's1', endedAt: '2026-08-31T23:59:00.000Z' }))
    await col.record(makeSession({ id: 's2', endedAt: '2026-09-01T12:00:00.000Z' }))
    await col.record(makeSession({ id: 's3', endedAt: '2026-09-02T08:00:00.000Z' }))
    await col.record(makeSession({ id: 's4', endedAt: '2026-09-03T00:00:00.000Z' }))

    const result = await col.query({ groupBy: 'day', from: '2026-09-01', to: '2026-09-02' })
    expect(result.total.sessions).toBe(2)
  })
})

describe('cost derivation', () => {
  it('correctly computes cost from token usage', () => {
    const pricing = getPricing('claude-sonnet-4-6')
    expect(pricing.inputPer1M).toBe(3.0)
    expect(pricing.outputPer1M).toBe(15.0)

    const cost = computeCost({ input: 1_000_000, output: 1_000_000 }, 'claude-sonnet-4-6')
    expect(cost).toBeCloseTo(18.0, 4)
  })

  it('uses default pricing for unknown model', () => {
    const pricing = getPricing('unknown-model-xyz')
    expect(pricing.inputPer1M).toBe(3.0)
  })

  it('partial prefix match (versioned model name)', () => {
    const pricing = getPricing('claude-sonnet-4-6-20251022')
    expect(pricing.inputPer1M).toBe(3.0)
  })
})
