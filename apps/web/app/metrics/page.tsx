'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CostChart } from '@/components/CostChart'
import { ProjectBreakdown } from '@/components/ProjectBreakdown'
import { SessionBreakdown } from '@/components/SessionBreakdown'
import { DateRangePicker } from '@/components/DateRangePicker'
import { fetchJson } from '@/lib/fetcher'
import { Skeleton } from '@/components/Skeleton'
import { BarChart3, Coins, Hash, Activity, TrendingUp, FolderKanban, MessageSquare } from 'lucide-react'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'

interface MetricsBucket {
  key: string
  sessions: number
  tokens: number
  cost_usd: number
  avg_duration_ms: number
}

interface MetricsQueryResult {
  buckets: MetricsBucket[]
  total: { sessions: number; tokens: number; cost_usd: number }
}

function defaultRange() {
  const to = new Date()
  const from = new Date(Date.now() - 30 * 86_400_000)
  return {
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  }
}

function StatTile({ icon, value, label, color = 'text-zinc-900 dark:text-zinc-100', loading }: {
  icon: React.ReactNode
  value: React.ReactNode
  label: string
  color?: string
  loading?: boolean
}) {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-1.5 text-zinc-400">
        {icon}
        <p className="text-[10px] sm:text-xs uppercase tracking-wide">{label}</p>
      </div>
      {loading ? (
        <Skeleton className="h-7 w-16" />
      ) : (
        <p className={`text-xl sm:text-2xl font-bold tabular-nums ${color}`}>{value}</p>
      )}
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
        <span className="text-zinc-400">{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

export default function MetricsPage() {
  const [range, setRange] = useState(defaultRange)

  const params = new URLSearchParams({ groupBy: 'day', from: range.from, to: range.to })
  const paramsProject = new URLSearchParams({ groupBy: 'project', from: range.from, to: range.to })
  const paramsSession = new URLSearchParams({ groupBy: 'session', from: range.from, to: range.to })

  const { data: dayData, isLoading: dayLoading } = useQuery<MetricsQueryResult>({
    queryKey: ['metrics', 'day', range],
    queryFn: () => fetchJson(`/api/metrics?${params}`),
  })

  const { data: projectData, isLoading: projLoading } = useQuery<MetricsQueryResult>({
    queryKey: ['metrics', 'project', range],
    queryFn: () => fetchJson(`/api/metrics?${paramsProject}`),
  })

  const { data: sessionData, isLoading: sessLoading } = useQuery<MetricsQueryResult>({
    queryKey: ['metrics', 'session', range],
    queryFn: () => fetchJson(`/api/metrics?${paramsSession}`),
  })

  const { data: sessionsList } = useQuery<SessionMetadata[]>({
    queryKey: ['sessions'],
    queryFn: async () => {
      const r = await fetchJson<{ sessions: SessionMetadata[] }>('/api/sessions')
      return r.sessions
    },
  })

  const dailyPoints = (dayData?.buckets ?? []).map((b) => ({
    date: b.key,
    cost: b.cost_usd,
    sessions: b.sessions,
  }))

  const { data: projectsList = [] } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['projects-lite'],
    queryFn: async () => {
      const r = await fetchJson<{ projects: Array<{ id: string; name: string }> }>('/api/projects')
      return r.projects.map((p) => ({ id: p.id, name: p.name }))
    },
  })

  const nameFor = (id: string) => projectsList.find((p) => p.id === id)?.name ?? id.slice(0, 8)

  const projectRows = (projectData?.buckets ?? []).map((b) => ({
    project: nameFor(b.key),
    cost: b.cost_usd,
    sessions: b.sessions,
    tokens: b.tokens,
  }))

  const sessionRows = (sessionData?.buckets ?? []).map((b) => ({
    sessionId: b.key,
    cost: b.cost_usd,
    tokens: b.tokens,
    avgDurationMs: b.avg_duration_ms,
  }))

  const total = dayData?.total ?? { sessions: 0, tokens: 0, cost_usd: 0 }
  const avgDurMs = (dayData?.buckets ?? []).reduce((acc, b) => acc + b.avg_duration_ms * b.sessions, 0) /
    Math.max(1, total.sessions)
  const avgDurMin = avgDurMs / 60_000

  const hasData = total.sessions > 0

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Metrics</h1>
          <p className="text-sm text-zinc-500 mt-0.5">{range.from} → {range.to}</p>
        </div>
        <DateRangePicker
          from={range.from}
          to={range.to}
          onChange={(from, to) => setRange({ from, to })}
        />
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
        <StatTile
          icon={<Activity className="w-3.5 h-3.5" />}
          label="Sessions"
          value={total.sessions.toLocaleString()}
          loading={dayLoading}
        />
        <StatTile
          icon={<Hash className="w-3.5 h-3.5" />}
          label="Tokens"
          value={total.tokens >= 1000 ? `${(total.tokens / 1000).toFixed(1)}k` : total.tokens.toString()}
          loading={dayLoading}
        />
        <StatTile
          icon={<Coins className="w-3.5 h-3.5" />}
          label="Cost"
          value={`$${total.cost_usd.toFixed(2)}`}
          color="text-emerald-600 dark:text-emerald-400"
          loading={dayLoading}
        />
        <StatTile
          icon={<TrendingUp className="w-3.5 h-3.5" />}
          label="Avg duration"
          value={hasData ? (avgDurMin < 1 ? `${(avgDurMin * 60).toFixed(0)}s` : `${avgDurMin.toFixed(1)}m`) : '—'}
          loading={dayLoading}
        />
      </div>

      {/* Daily cost chart */}
      <Section title="Daily Cost" icon={<BarChart3 className="w-4 h-4" />}>
        {dayLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : dailyPoints.length === 0 ? (
          <div className="text-center py-8 text-sm text-zinc-500">No sessions in this range</div>
        ) : (
          <CostChart data={dailyPoints} />
        )}
      </Section>

      {/* Project breakdown */}
      <Section title="Per-Project Breakdown" icon={<FolderKanban className="w-4 h-4" />}>
        {projLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : projectRows.length === 0 ? (
          <div className="text-center py-8 text-sm text-zinc-500">No project activity in this range</div>
        ) : (
          <ProjectBreakdown data={projectRows} />
        )}
      </Section>

      {/* Session breakdown */}
      <Section title="Per-Session Cost" icon={<MessageSquare className="w-4 h-4" />}>
        {sessLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <SessionBreakdown data={sessionRows} sessions={sessionsList} />
        )}
      </Section>
    </div>
  )
}
