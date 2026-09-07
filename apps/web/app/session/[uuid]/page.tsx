'use client'

import { use, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { SessionHeader } from '@/components/SessionHeader'
import { TranscriptPanePoll } from '@/components/TranscriptPanePoll'
import { SessionActionDialog, type SessionActionKind } from '@/components/SessionActionDialog'
import type { EffortLevel } from '@agent-hq-orchestron/shared'
import { InputBox } from '@/components/InputBox'
import { KillConfirmDialog } from '@/components/KillConfirmDialog'
import { PendingPromptBanner } from '@/components/PendingPromptBanner'
import { fetchJson, apiFetch } from '@/lib/fetcher'
import type { SessionMetadata, DelegationEdges, ProjectMetadata } from '@agent-hq-orchestron/shared'

interface PageProps {
  params: Promise<{ uuid: string }>
}

export default function SessionDetailPage({ params }: PageProps) {
  const { uuid } = use(params)
  const router = useRouter()
  const qc = useQueryClient()
  const [killOpen, setKillOpen] = useState(false)
  const [killing, setKilling] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [reopening, setReopening] = useState(false)
  const [cloning, setCloning] = useState(false)

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

  const { data: projects = [] } = useQuery<ProjectMetadata[]>({
    queryKey: ['projects'],
    queryFn: async () => {
      const r = await fetchJson<{ projects: ProjectMetadata[] }>('/api/projects')
      return r.projects
    },
  })

  const descendantCount = delegation?.edges?.length ?? 0
  const currentProject = projects.find((p) => p.id === session?.projectId)
  const projectName = currentProject?.name
  const projectPath = currentProject?.path

  const killMutation = useMutation({
    mutationFn: () => apiFetch(`/api/sessions/${uuid}`, { method: 'DELETE' }),
    onMutate: () => setKilling(true),
    onSettled: () => {
      setKilling(false)
      setKillOpen(false)
      qc.invalidateQueries({ queryKey: ['session', uuid] })
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  const archiveMutation = useMutation({
    mutationFn: () => apiFetch(`/api/sessions/${uuid}/archive`, { method: 'POST' }),
    onMutate: () => setArchiving(true),
    onSettled: () => {
      setArchiving(false)
      qc.invalidateQueries({ queryKey: ['session', uuid] })
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  const [actionDialog, setActionDialog] = useState<SessionActionKind | null>(null)

  const reopenMutation = useMutation({
    mutationFn: (opts: { model?: string; effort?: EffortLevel } = {}) =>
      apiFetch(`/api/sessions/${uuid}/reopen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      }),
    onMutate: () => setReopening(true),
    onSettled: () => {
      setReopening(false)
      qc.invalidateQueries({ queryKey: ['session', uuid] })
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  const cloneMutation = useMutation({
    mutationFn: async (opts: { prompt?: string; model?: string; effort?: EffortLevel } = {}) => {
      const res = await apiFetch(`/api/sessions/${uuid}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      return res.json() as Promise<SessionMetadata>
    },
    onMutate: () => setCloning(true),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['sessions'] })
      // Navigate to the new session
      router.push(`/session/${data.id}`)
    },
    onSettled: () => setCloning(false),
  })

  const [respawning, setRespawning] = useState(false)
  const respawnMutation = useMutation({
    mutationFn: async (opts: { model?: string; effort?: EffortLevel } = {}) => {
      const res = await apiFetch(`/api/sessions/${uuid}/respawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      return res.json() as Promise<SessionMetadata>
    },
    onMutate: () => setRespawning(true),
    onSuccess: () => {
      // Respawn is now in-place — same session id, just refresh queries so
      // the header + transcript pick up the new claudeSessionUuid + status.
      qc.invalidateQueries({ queryKey: ['session', uuid] })
      qc.invalidateQueries({ queryKey: ['sessions'] })
      qc.invalidateQueries({ queryKey: ['transcript', uuid] })
    },
    onSettled: () => setRespawning(false),
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
        onArchive={() => {
          if (confirm('Mark this session as succeeded? Tmux will be terminated and the transcript will remain read-only for review.')) {
            archiveMutation.mutate()
          }
        }}
        onReopen={() => setActionDialog('reopen')}
        onClone={() => setActionDialog('fork')}
        onRespawn={() => setActionDialog('respawn')}
        killing={killing}
        archiving={archiving}
        reopening={reopening}
        cloning={cloning}
        respawning={respawning}
        projectName={projectName}
        projectPath={projectPath}
        projectDefaultModel={currentProject?.defaultModel}
        projectDefaultEffort={currentProject?.defaultEffort}
      />

      {session.pendingPrompt && !readOnly && (
        <PendingPromptBanner uuid={uuid} prompt={session.pendingPrompt} />
      )}

      <div className="flex-1 overflow-hidden">
        <TranscriptPanePoll uuid={uuid} status={session.status} agentType={session.agentType} />
      </div>

      {!readOnly && <InputBox uuid={uuid} status={session.status} agentType={session.agentType} />}

      <KillConfirmDialog
        open={killOpen}
        onClose={() => setKillOpen(false)}
        onConfirm={() => killMutation.mutate()}
        descendantCount={descendantCount}
        killing={killing}
      />

      <SessionActionDialog
        open={actionDialog !== null}
        kind={actionDialog ?? 'reopen'}
        agentType={session.agentType}
        currentModel={session.model}
        currentEffort={session.effort}
        defaultModel={currentProject?.defaultModel}
        defaultEffort={currentProject?.defaultEffort}
        pending={reopening || cloning || respawning}
        onClose={() => setActionDialog(null)}
        onConfirm={(opts) => {
          const action = actionDialog
          setActionDialog(null)
          if (action === 'reopen') {
            reopenMutation.mutate({ model: opts.model, effort: opts.effort })
          } else if (action === 'fork') {
            cloneMutation.mutate({ prompt: opts.prompt, model: opts.model, effort: opts.effort })
          } else if (action === 'respawn') {
            respawnMutation.mutate({ model: opts.model, effort: opts.effort })
          }
        }}
      />
    </div>
  )
}
