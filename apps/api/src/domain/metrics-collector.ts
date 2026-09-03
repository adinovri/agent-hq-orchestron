import path from 'node:path'
import fs from 'node:fs'
import { appendJsonl, readJsonlFrom } from '@agent-hq-orchestron/file-store'
import type { SessionMetadata, MetricsRecord, AgentType, TokenUsage } from '@agent-hq-orchestron/shared'
import { computeCost } from './pricing-table.js'

export interface MetricsBucket {
  key: string
  sessions: number
  tokens: number
  cost_usd: number
  avg_duration_ms: number
}

export interface MetricsQueryResult {
  buckets: MetricsBucket[]
  total: {
    sessions: number
    tokens: number
    cost_usd: number
  }
}

export type GroupBy = 'project' | 'adapter' | 'model' | 'day'

export interface MetricsQuery {
  groupBy: GroupBy
  from?: string   // YYYY-MM-DD
  to?: string     // YYYY-MM-DD
  projectId?: string
  adapter?: AgentType
}

export class MetricsCollector {
  private readonly _dataDir: string
  private readonly _metricsPath: string

  constructor(dataDir: string) {
    this._dataDir = dataDir
    this._metricsPath = path.join(dataDir, 'metrics', 'sessions.jsonl')
  }

  async record(session: SessionMetadata): Promise<void> {
    if (!session.tokenUsage || !session.endedAt) return

    const startedAt = new Date(session.startedAt).getTime()
    const endedAt = new Date(session.endedAt).getTime()
    const durationMs = Math.max(0, endedAt - startedAt)

    const cost = computeCost(session.tokenUsage, session.model)

    const record: MetricsRecord = {
      sessionUuid: session.id,
      projectId: session.projectId,
      adapter: session.agentType,
      model: session.model,
      tokens: session.tokenUsage,
      costUsd: cost,
      durationMs,
      endedAt: session.endedAt,
    }

    await appendJsonl(this._metricsPath, record)
  }

  async query(q: MetricsQuery): Promise<MetricsQueryResult> {
    const { lines } = await readJsonlFrom(this._metricsPath, 0)
    const records = lines as MetricsRecord[]

    const fromMs = q.from ? new Date(q.from).getTime() : 0
    const toMs = q.to ? new Date(q.to + 'T23:59:59.999Z').getTime() : Infinity

    const filtered = records.filter((r) => {
      const t = new Date(r.endedAt).getTime()
      if (t < fromMs || t > toMs) return false
      if (q.projectId && r.projectId !== q.projectId) return false
      if (q.adapter && r.adapter !== q.adapter) return false
      return true
    })

    const bucketMap = new Map<string, {
      sessions: number
      tokens: number
      cost_usd: number
      total_duration_ms: number
    }>()

    for (const r of filtered) {
      const key = extractKey(r, q.groupBy)
      const existing = bucketMap.get(key)
      const totalTokens = (r.tokens.input ?? 0) + (r.tokens.output ?? 0)
      if (existing) {
        existing.sessions += 1
        existing.tokens += totalTokens
        existing.cost_usd += r.costUsd
        existing.total_duration_ms += r.durationMs
      } else {
        bucketMap.set(key, {
          sessions: 1,
          tokens: totalTokens,
          cost_usd: r.costUsd,
          total_duration_ms: r.durationMs,
        })
      }
    }

    const buckets: MetricsBucket[] = Array.from(bucketMap.entries()).map(([key, v]) => ({
      key,
      sessions: v.sessions,
      tokens: v.tokens,
      cost_usd: v.cost_usd,
      avg_duration_ms: v.sessions > 0 ? v.total_duration_ms / v.sessions : 0,
    }))

    const total = {
      sessions: filtered.length,
      tokens: filtered.reduce((s, r) => s + (r.tokens.input ?? 0) + (r.tokens.output ?? 0), 0),
      cost_usd: filtered.reduce((s, r) => s + r.costUsd, 0),
    }

    return { buckets, total }
  }
}

function extractKey(r: MetricsRecord, groupBy: GroupBy): string {
  switch (groupBy) {
    case 'project': return r.projectId
    case 'adapter': return r.adapter
    case 'model': return r.model ?? 'unknown'
    case 'day': return r.endedAt.slice(0, 10) // YYYY-MM-DD
  }
}
