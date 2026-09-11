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
  message?: { id?: string; model?: string; usage?: AssistantEventUsage }
}

export interface SessionUsageRollup {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
  /** Sum of per-event costs, each priced at the model that produced that event. */
  costUsd: number
  /** Model of the last assistant event that named a real one — session-level
   *  attribution only. `<synthetic>` marker rows do not advance it. */
  lastModel: string
  /** Timestamp of the last assistant event carrying usage. */
  lastTs: string
  /** Rows skipped because an earlier row already billed the same `message.id`. */
  duplicateRows: number
}

/** Claude Code's marker model for machinery rows (the resume reply). Not a real
 *  model: it names no rate and must not become an attribution bucket key. */
const SYNTHETIC_MODEL = '<synthetic>'

/** The event's model, or `undefined` when it names none — treating the
 *  `<synthetic>` marker as naming none, so every caller falls back to the
 *  session's model the same way it already does for a row with no field. */
function eventModel(ev: AssistantEvent): string | undefined {
  const m = ev.message?.model
  return m && m !== SYNTHETIC_MODEL ? m : undefined
}

function sameUsage(a: AssistantEventUsage, b: AssistantEventUsage): boolean {
  return (a.input_tokens ?? 0) === (b.input_tokens ?? 0)
    && (a.output_tokens ?? 0) === (b.output_tokens ?? 0)
    && (a.cache_read_input_tokens ?? 0) === (b.cache_read_input_tokens ?? 0)
    && (a.cache_creation_input_tokens ?? 0) === (b.cache_creation_input_tokens ?? 0)
}

/**
 * Roll one session's JSONL up into tokens + cost.
 *
 * Two things this deliberately does NOT do the naive way:
 *
 *  1. **Dedup by `message.id`.** Claude Code writes a single assistant message as
 *     two rollout rows when the response carries a `thinking` block — one row for
 *     the thinking content, one for the text/tool_use — and both rows repeat the
 *     *same* `message.id` with the *same* `usage` object. Summing both bills the
 *     same API call twice; on the headless path nearly every turn splits, so the
 *     total came out at exactly 2x. We keep the first row that carries usage for
 *     each id. Rows without an id cannot be deduped and are all counted.
 *
 *  2. **Price per event, not per session.** Cost used to be the whole token total
 *     multiplied by the rate of the *last* billed event's model. A session that
 *     changed model mid-way (metadata edit, respawn) priced every earlier token at
 *     the final rate — off by up to 5x (opus/sonnet) or 18.75x (opus/haiku) in
 *     either direction. Each event is now priced at its own model, falling back to
 *     the session's recorded model when the row omits one.
 *
 *  3. **Ignore `<synthetic>` as a model.** Claude Code writes the resume reply
 *     *"No response requested."* as an assistant row carrying
 *     `"model":"<synthetic>"` and an all-zero `usage`. That is a marker, not a
 *     model: it names no rate in the pricing table, so it would price at
 *     `DEFAULT_PRICING` (Sonnet) if it ever carried usage, and — worse — it
 *     would advance `lastModel`, which is the `groupBy=model` bucket key. A
 *     session whose last usage-bearing row was synthetic would have been filed
 *     under a bucket literally named `<synthetic>`. Nothing prevented that
 *     except ordering luck: the resume pair is injected *before* each new turn,
 *     so a real reply normally lands last. Such a row is now treated exactly
 *     like a row with no `model` field at all — the session's own model.
 *
 * `lastModel` / `lastTs` still advance on duplicate rows: they describe when the
 * session last emitted and under which model, which a duplicate row answers just
 * as truthfully as the row it duplicates. Only `<synthetic>` is filtered, and
 * only as a *model*; the row still advances `lastTs`, because the session really
 * did emit at that moment.
 */
export function rollupSessionUsage(
  raw: string,
  sessionModel: string | undefined,
  startedAt: string,
  sessionLabel = '',
): SessionUsageRollup {
  const fallbackModel = sessionModel ?? 'unknown'
  const out: SessionUsageRollup = {
    input: 0, output: 0, cacheRead: 0, cacheCreation: 0,
    costUsd: 0, lastModel: fallbackModel, lastTs: startedAt, duplicateRows: 0,
  }
  const billed = new Map<string, AssistantEventUsage>()

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let ev: AssistantEvent
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.type !== 'assistant' || !ev.message?.usage) continue
    const u = ev.message.usage

    const evModel = eventModel(ev)
    if (evModel) out.lastModel = evModel
    if (ev.timestamp) out.lastTs = ev.timestamp

    const id = ev.message.id
    if (id !== undefined) {
      const prior = billed.get(id)
      if (prior) {
        // Same id, different numbers — the shape we assume is broken. Bill the
        // first row anyway (guessing which is authoritative would be worse) and
        // say so, loudly enough to find in the logs.
        if (!sameUsage(prior, u)) {
          console.warn(
            `[metrics] assistant message ${id}${sessionLabel ? ` in ${sessionLabel}` : ''} repeats with different usage; ` +
            `billing the first occurrence only`,
          )
        }
        out.duplicateRows += 1
        continue
      }
      billed.set(id, u)
    }

    const input = u.input_tokens ?? 0
    const output = u.output_tokens ?? 0
    const cacheRead = u.cache_read_input_tokens ?? 0
    const cacheCreation = u.cache_creation_input_tokens ?? 0

    out.input += input
    out.output += output
    out.cacheRead += cacheRead
    out.cacheCreation += cacheCreation
    out.costUsd += computeCost(
      { input, output, cacheRead, cacheCreation },
      evModel ?? fallbackModel,
    )
  }

  return out
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

    const usage = rollupSessionUsage(raw, s.model, s.startedAt, s.id)

    if (usage.input === 0 && usage.output === 0 && usage.cacheRead === 0 && usage.cacheCreation === 0) continue

    const endedAt = s.endedAt ?? usage.lastTs
    const endedMs = new Date(endedAt).getTime()
    if (endedMs < fromMs || endedMs > toMs) continue

    const startedMs = new Date(s.startedAt).getTime()

    perSession.push({
      sessionUuid: s.id,
      projectId: s.projectId,
      adapter: s.agentType,
      model: usage.lastModel,
      endedAt,
      tokens: usage.input + usage.output + usage.cacheRead + usage.cacheCreation,
      costUsd: usage.costUsd,
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
