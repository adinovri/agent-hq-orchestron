'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CostChart } from '@/components/CostChart'
import { ProjectBreakdown } from '@/components/ProjectBreakdown'
import { DateRangePicker } from '@/components/DateRangePicker'
import { fetchJson } from '@/lib/fetcher'

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

export default function MetricsPage() {
  const [range, setRange] = useState(defaultRange)

  const params = new URLSearchParams({ groupBy: 'day', from: range.from, to: range.to })
  const paramsProject = new URLSearchParams({ groupBy: 'project', from: range.from, to: range.to })

  const { data: dayData } = useQuery<MetricsQueryResult>({
    queryKey: ['metrics', 'day', range],
    queryFn: () => fetchJson(`/api/metrics?${params}`),
  })

  const { data: projectData } = useQuery<MetricsQueryResult>({
    queryKey: ['metrics', 'project', range],
    queryFn: () => fetchJson(`/api/metrics?${paramsProject}`),
  })

  const dailyPoints = (dayData?.buckets ?? []).map((b) => ({
    date: b.key,
    cost: b.cost_usd,
    sessions: b.sessions,
  }))

  const projectRows = (projectData?.buckets ?? []).map((b) => ({
    project: b.key,
    cost: b.cost_usd,
    sessions: b.sessions,
    tokens: b.tokens,
  }))

  const total = dayData?.total ?? { sessions: 0, tokens: 0, cost_usd: 0 }

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <h1 className="text-xl font-semibold">Metrics</h1>
        <DateRangePicker
          from={range.from}
          to={range.to}
          onChange={(from, to) => setRange({ from, to })}
        />
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 text-center">
          <p className="text-2xl font-bold">{total.sessions}</p>
          <p className="text-xs text-zinc-500 mt-1">Sessions</p>
        </div>
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 text-center">
          <p className="text-2xl font-bold">{(total.tokens / 1000).toFixed(1)}k</p>
          <p className="text-xs text-zinc-500 mt-1">Tokens</p>
        </div>
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 text-center">
          <p className="text-2xl font-bold">${total.cost_usd.toFixed(2)}</p>
          <p className="text-xs text-zinc-500 mt-1">Total Cost</p>
        </div>
      </div>

      {/* Daily cost chart */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold mb-3">Daily Cost</h2>
        <CostChart data={dailyPoints} />
      </div>

      {/* Project breakdown */}
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
        <h2 className="text-sm font-semibold mb-3">Per-Project Breakdown</h2>
        <ProjectBreakdown data={projectRows} />
      </div>
    </div>
  )
}
