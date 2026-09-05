import path from 'node:path'
import fs from 'node:fs'
import { readFile } from 'node:fs/promises'
import { appendJsonl, readJsonlFrom } from '@agent-hq-orchestron/file-store'
import type { SessionMetadata, MetricsRecord, AgentType, TokenUsage } from '@agent-hq-orchestron/shared'
import { computeCost } from './pricing-table.js'
import type { SessionManager } from './session-manager.js'

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

export type GroupBy = 'project' | 'adapter' | 'model' | 'day' | 'session'

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
  private readonly _sessionManager: SessionManager | null

  constructor(dataDir: string, sessionManager?: SessionManager) {
    this._dataDir = dataDir
    this._metricsPath = path.join(dataDir, 'metrics', 'sessions.jsonl')
    this._sessionManager = sessionManager ?? null
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
    // Prefer on-demand aggregation from Claude JSONL — that's the actual
    // source of truth for token usage (record() flow is not wired yet).
    if (this._sessionManager) {
      return queryFromJsonl(this._sessionManager, q)
    }
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
    case 'session': return r.sessionUuid
    case 'day': return r.endedAt.slice(0, 10) // YYYY-MM-DD
  }
}

// On-demand JSONL parser — the record()/store path is unwired, so we compute
// metrics fresh from each session's JSONL on every query.
interface AssistantEventUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}
interface AssistantEvent {
  type?: string
  timestamp?: string
  message?: { model?: string; usage?: AssistantEventUsage }
}

async function queryFromJsonl(sm: SessionManager, q: MetricsQuery): Promise<MetricsQueryResult> {
  const sessions = await sm.list()

  const fromMs = q.from ? new Date(q.from).getTime() : 0
  const toMs = q.to ? new Date(q.to + 'T23:59:59.999Z').getTime() : Infinity

  // Parse each session's JSONL, extract assistant events with usage,
  // sum tokens + cost per session, then aggregate.
  interface SessionMetrics {
    sessionUuid: string
    projectId: string
    adapter: AgentType
    model: string
    endedAt: string
    tokens: number
    costUsd: number
    durationMs: number
  }
  const perSession: SessionMetrics[] = []

  for (const s of sessions) {
    if (q.projectId && s.projectId !== q.projectId) continue
    if (q.adapter && s.agentType !== q.adapter) continue

    let raw = ''
    try { raw = await readFile(s.jsonlPath, 'utf8') } catch { continue }

    let totalInput = 0
    let totalOutput = 0
    let totalCacheRead = 0
    let totalCacheCreation = 0
    let lastModel = s.model ?? 'unknown'
    let lastTs = s.startedAt

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let ev: AssistantEvent
      try { ev = JSON.parse(line) } catch { continue }
      if (ev.type !== 'assistant' || !ev.message?.usage) continue
      const u = ev.message.usage
      totalInput += u.input_tokens ?? 0
      totalOutput += u.output_tokens ?? 0
      totalCacheRead += u.cache_read_input_tokens ?? 0
      totalCacheCreation += u.cache_creation_input_tokens ?? 0
      if (ev.message.model) lastModel = ev.message.model
      if (ev.timestamp) lastTs = ev.timestamp
    }

    if (totalInput === 0 && totalOutput === 0 && totalCacheRead === 0 && totalCacheCreation === 0) continue

    const endedAt = s.endedAt ?? lastTs
    const endedMs = new Date(endedAt).getTime()
    if (endedMs < fromMs || endedMs > toMs) continue

    const cost = computeCost(
      { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheCreation: totalCacheCreation },
      lastModel,
    )
    const startedMs = new Date(s.startedAt).getTime()

    perSession.push({
      sessionUuid: s.id,
      projectId: s.projectId,
      adapter: s.agentType,
      model: lastModel,
      endedAt,
      tokens: totalInput + totalOutput + totalCacheRead + totalCacheCreation,
      costUsd: cost,
      durationMs: Math.max(0, endedMs - startedMs),
    })
  }

  // Group
  const bucketMap = new Map<string, { sessions: number; tokens: number; cost_usd: number; total_duration_ms: number }>()
  for (const r of perSession) {
    let key: string
    switch (q.groupBy) {
      case 'project': key = r.projectId; break
      case 'adapter': key = r.adapter; break
      case 'model': key = r.model; break
      case 'session': key = r.sessionUuid; break
      case 'day':
      default: key = r.endedAt.slice(0, 10)
    }
    const cur = bucketMap.get(key) ?? { sessions: 0, tokens: 0, cost_usd: 0, total_duration_ms: 0 }
    cur.sessions += 1
    cur.tokens += r.tokens
    cur.cost_usd += r.costUsd
    cur.total_duration_ms += r.durationMs
    bucketMap.set(key, cur)
  }

  const buckets: MetricsBucket[] = Array.from(bucketMap.entries())
    .map(([key, v]) => ({
      key,
      sessions: v.sessions,
      tokens: v.tokens,
      cost_usd: v.cost_usd,
      avg_duration_ms: v.sessions > 0 ? v.total_duration_ms / v.sessions : 0,
    }))
    .sort((a, b) => q.groupBy === 'session' || q.groupBy === 'day'
      ? b.key.localeCompare(a.key) // newest first for time-ish keys
      : b.cost_usd - a.cost_usd) // else by cost desc

  const total = {
    sessions: perSession.length,
    tokens: perSession.reduce((s, r) => s + r.tokens, 0),
    cost_usd: perSession.reduce((s, r) => s + r.costUsd, 0),
  }

  return { buckets, total }
}
