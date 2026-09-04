'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { SessionHeader } from '@/components/SessionHeader'
import { TranscriptPane } from '@/components/TranscriptPane'
import { InputBox } from '@/components/InputBox'
import { KillConfirmDialog } from '@/components/KillConfirmDialog'
import { fetchJson, apiFetch } from '@/lib/fetcher'
import type { SessionMetadata, DelegationEdges } from '@agent-hq-orchestron/shared'

interface PageProps {
  params: Promise<{ uuid: string }>
}

export default function SessionDetailPage({ params }: PageProps) {
  const { uuid } = use(params)
  const router = useRouter()
  const qc = useQueryClient()
  const [killOpen, setKillOpen] = useState(false)
  const [killing, setKilling] = useState(false)

  const { data: session, isLoading } = useQuery<SessionMetadata>({
    queryKey: ['session', uuid],
    queryFn: () => fetchJson(`/api/sessions/${uuid}`),
    refetchInterval: 3_000,
  })

  const { data: delegation } = useQuery<DelegationEdges>({
    queryKey: ['delegation', uuid],
    queryFn: () => fetchJson(`/api/delegation/${uuid}`),
    enabled: !!uuid,
  })

  const descendantCount = delegation?.edges?.length ?? 0

  const killMutation = useMutation({
    mutationFn: () => apiFetch(`/api/sessions/${uuid}/kill`, { method: 'POST' }),
    onMutate: () => setKilling(true),
    onSettled: () => {
      setKilling(false)
      setKillOpen(false)
      qc.invalidateQueries({ queryKey: ['session', uuid] })
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto px-3 sm:px-4 py-4 space-y-3">
        <div className="animate-pulse space-y-2">
          <div className="h-5 w-24 bg-zinc-200 dark:bg-zinc-800 rounded" />
          <div className="h-4 w-2/3 bg-zinc-200 dark:bg-zinc-800 rounded" />
          <div className="h-3 w-1/2 bg-zinc-200 dark:bg-zinc-800 rounded" />
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 text-zinc-500">
        <p className="text-sm">Session not found</p>
        <button onClick={() => router.push('/dashboard')} className="text-sm text-blue-600 hover:underline">
          ← Back to Dashboard
        </button>
      </div>
    )
  }

  const readOnly = (session.metadata as Record<string, unknown>)?.readOnly === true

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      <SessionHeader
        session={session}
        descendantCount={descendantCount}
        readOnly={readOnly}
        onKill={() => setKillOpen(true)}
        killing={killing}
      />

      <div className="flex-1 overflow-hidden">
        <TranscriptPane uuid={uuid} status={session.status} />
      </div>

      {!readOnly && <InputBox uuid={uuid} status={session.status} />}

      <KillConfirmDialog
        open={killOpen}
        onClose={() => setKillOpen(false)}
        onConfirm={() => killMutation.mutate()}
        descendantCount={descendantCount}
        killing={killing}
      />
    </div>
  )
}
