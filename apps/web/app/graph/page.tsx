'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { DelegationGraph } from '@/components/DelegationGraph'
import { fetchJson } from '@/lib/fetcher'
import type { SessionMetadata, DelegationEdges } from '@agent-hq-orchestron/shared'

export default function GraphPage({
  searchParams,
}: {
  searchParams: Promise<{ root?: string }>
}) {
  const [resolvedRoot, setResolvedRoot] = useState<string | undefined>(undefined)

  // resolve async searchParams once
  searchParams.then((sp) => {
    if (sp.root && sp.root !== resolvedRoot) setResolvedRoot(sp.root)
  })

  const [rootInput, setRootInput] = useState('')

  const root = resolvedRoot ?? rootInput.trim() || undefined

  const { data: sessions = [] } = useQuery<SessionMetadata[]>({
    queryKey: ['sessions'],
    queryFn: () => fetchJson('/api/sessions'),
    refetchInterval: 5_000,
  })

  const { data: delegation, isLoading } = useQuery<DelegationEdges>({
    queryKey: ['delegation', root],
    queryFn: () => fetchJson(`/api/delegation/${root}`),
    enabled: !!root,
  })

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <h1 className="text-sm font-semibold shrink-0">Delegation Graph</h1>
        <input
          type="text"
          placeholder="Root session UUID…"
          value={resolvedRoot ?? rootInput}
          onChange={(e) => setRootInput(e.target.value)}
          className="flex-1 max-w-xs h-8 px-3 rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-zinc-400"
        />
        {isLoading && <span className="text-xs text-zinc-400">Loading…</span>}
        <span className="text-xs text-zinc-400 ml-auto">Click a node to view session</span>
      </div>

      {/* Graph */}
      <div className="flex-1 overflow-hidden">
        <DelegationGraph
          sessions={sessions}
          delegationEdges={delegation?.edges ?? []}
          rootUuid={root}
        />
      </div>
    </div>
  )
}
