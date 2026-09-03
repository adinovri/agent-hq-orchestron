'use client'

import { useState } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

interface ProjectRow {
  project: string
  cost: number
  sessions: number
  tokens: number
}

type SortKey = 'cost' | 'sessions' | 'tokens'

interface Props {
  data: ProjectRow[]
}

export function ProjectBreakdown({ data }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('cost')
  const sorted = [...data].sort((a, b) => b[sortKey] - a[sortKey])

  return (
    <div className="space-y-4">
      {/* Bar chart */}
      {sorted.length > 0 && (
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={sorted} margin={{ top: 4, right: 16, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.08)" />
            <XAxis dataKey="project" tick={{ fontSize: 10 }} />
            <YAxis tick={{ fontSize: 10 }} tickFormatter={(v: number) => `$${v.toFixed(2)}`} />
            <Tooltip formatter={(v) => [`$${Number(v).toFixed(4)}`, 'Cost']} />
            <Bar dataKey="cost" fill="#3b82f6" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 dark:border-zinc-800">
              {(['project', 'cost', 'sessions', 'tokens'] as const).map((col) => (
                <th
                  key={col}
                  onClick={() => col !== 'project' && setSortKey(col as SortKey)}
                  className={`text-left py-2 px-3 text-xs font-medium text-zinc-500 ${
                    col !== 'project' ? 'cursor-pointer hover:text-zinc-800 dark:hover:text-zinc-200' : ''
                  } ${sortKey === col ? 'text-zinc-900 dark:text-zinc-100' : ''}`}
                >
                  {col.charAt(0).toUpperCase() + col.slice(1)}
                  {sortKey === col && ' ↓'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.project} className="border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900">
                <td className="py-2 px-3 font-mono text-xs">{r.project}</td>
                <td className="py-2 px-3">${r.cost.toFixed(4)}</td>
                <td className="py-2 px-3">{r.sessions}</td>
                <td className="py-2 px-3">{r.tokens.toLocaleString()}</td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={4} className="py-8 text-center text-zinc-400 text-xs">No data</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
