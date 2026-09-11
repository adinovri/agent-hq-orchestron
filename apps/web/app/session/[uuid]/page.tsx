'use client'

import { use, useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { SessionHeader } from '@/components/SessionHeader'
import { TranscriptPanePoll } from '@/components/TranscriptPanePoll'
import { SessionActionDialog, type SessionActionKind } from '@/components/SessionActionDialog'
import type { EffortLevel } from '@agent-hq-orchestron/shared'
import { InputBox } from '@/components/InputBox'
import { KillConfirmDialog } from '@/components/KillConfirmDialog'
import { PendingPromptBanner } from '@/components/PendingPromptBanner'
import { InquiryCard } from '@/components/InquiryCard'
import { DeleteRecordDialog } from '@/components/DeleteRecordDialog'
import { SessionMetadataEditDialog } from '@/components/SessionMetadataEditDialog'
import { fetchJson, apiFetch } from '@/lib/fetcher'
import { noticeIfCoerced, noticeMutationError } from '@/lib/notice'
import { throwIfNotOk, mutationErrorMessage } from '@/lib/api-error'
import { confirmSessionAction, settleSessionAction } from '@/lib/session-action-dialog'
import {
  resolveInquiryCard,
  INQUIRY_ANSWER_GRACE_MS,
  type AnsweredInquiry,
} from '@/lib/inquiry-card'
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
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deletingRecord, setDeletingRecord] = useState(false)
  const [editMetaOpen, setEditMetaOpen] = useState(false)
  const [answeredInquiry, setAnsweredInquiry] = useState<AnsweredInquiry | null>(null)
  // Per-dialog last-failure text. Cleared in `onMutate` so a retry does not
  // start with the previous attempt's message still under the button (NF27).
  const [killError, setKillError] = useState<string | null>(null)
  const [deleteRecordError, setDeleteRecordError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [editMetaError, setEditMetaError] = useState<string | null>(null)

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

  // Resolve parent's prompt preview for the parent-chip hover title.
  // Cheap lookup — sessions list is already fetched by the dashboard's
  // long-poll cache, so hitting the same query key here just replays it.
  const { data: allSessions = [] } = useQuery<SessionMetadata[]>({
    queryKey: ['sessions'],
    queryFn: async () => {
      const r = await fetchJson<{ sessions: SessionMetadata[] }>('/api/sessions')
      return r.sessions
    },
    enabled: !!session?.parentSessionId,
  })
  const parentPrompt = session?.parentSessionId
    ? (allSessions.find((s) => s.id === session.parentSessionId)?.initialPrompt ?? '').trim().slice(0, 100)
    : undefined

  // The grace window that keeps the answered inquiry card on screen needs its
  // own clock. Nothing else re-renders this page at the moment it expires —
  // the session poll runs on its own 3s cadence — so without this timer the
  // card would linger until the next tick instead of leaving when it said it
  // would. Held while `pendingInquiry` is still set: the server has not caught
  // up yet, and dropping the snapshot there would flip the card back to an
  // open form after the operator already sent an answer.
  const pendingInquiry = session?.pendingInquiry ?? null
  useEffect(() => {
    if (!answeredInquiry || pendingInquiry) return
    const remaining = answeredInquiry.at + INQUIRY_ANSWER_GRACE_MS - Date.now()
    if (remaining <= 0) {
      setAnsweredInquiry(null)
      return
    }
    const timer = setTimeout(() => setAnsweredInquiry(null), remaining)
    return () => clearTimeout(timer)
  }, [answeredInquiry, pendingInquiry])

  // NF27. This used to be the most misleading mutation on the page: no
  // `res.ok` check, so react-query treated a 500 as a fulfilled promise, and
  // `setKillOpen(false)` sat in `onSettled`, which runs on both outcomes. A
  // failed kill therefore closed the dialog exactly like a successful one and
  // left the session running, with the only trace in the network tab. Closing
  // is `onSuccess`'s job; `onSettled` keeps only what is true either way.
  const killMutation = useMutation({
    mutationFn: async () => { await throwIfNotOk(await apiFetch(`/api/sessions/${uuid}`, { method: 'DELETE' })) },
    onMutate: () => { setKilling(true); setKillError(null) },
    onSuccess: () => setKillOpen(false),
    onError: (err) => setKillError(mutationErrorMessage(err)),
    onSettled: () => {
      setKilling(false)
      qc.invalidateQueries({ queryKey: ['session', uuid] })
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  // Fires straight from the header's ✓ — there is no dialog to keep open, so
  // a failure says so in a toast. Before NF27 it had no `res.ok` check either:
  // a 409 ("Cannot archive a running session") stopped the spinner, changed
  // nothing, and explained nothing.
  const archiveMutation = useMutation({
    mutationFn: async () => { await throwIfNotOk(await apiFetch(`/api/sessions/${uuid}/archive`, { method: 'POST' })) },
    onMutate: () => setArchiving(true),
    onError: (err) => noticeMutationError('Mark as succeeded', mutationErrorMessage(err)),
    onSettled: () => {
      setArchiving(false)
      qc.invalidateQueries({ queryKey: ['session', uuid] })
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  const deleteRecordMutation = useMutation({
    mutationFn: async () => {
      const res = await throwIfNotOk(await apiFetch(`/api/sessions/${uuid}/record`, { method: 'DELETE' }))
      return res.json()
    },
    onMutate: () => { setDeletingRecord(true); setDeleteRecordError(null) },
    onError: (err) => setDeleteRecordError(mutationErrorMessage(err)),
    onSuccess: () => {
      setDeleteOpen(false)
      qc.invalidateQueries({ queryKey: ['sessions'] })
      router.push('/dashboard')
    },
    onSettled: () => setDeletingRecord(false),
  })

  const [actionDialog, setActionDialog] = useState<SessionActionKind | null>(null)

  const reopenMutation = useMutation({
    mutationFn: async (opts: { model?: string; effort?: EffortLevel; useTmux?: boolean } = {}) => {
      const res = await throwIfNotOk(await apiFetch(`/api/sessions/${uuid}/reopen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      }))
      return res.json() as Promise<SessionMetadata>
    },
    onMutate: () => { setReopening(true); setActionError(null) },
    onError: (err) => {
      setActionError(mutationErrorMessage(err))
      settleSessionAction('error', () => setActionDialog(null))
    },
    // Reopening a headless session while the switch is off brings it back in
    // tmux — worth saying, since the dialog did not offer the choice.
    onSuccess: (data) => {
      noticeIfCoerced(data)
      settleSessionAction('success', () => setActionDialog(null))
    },
    onSettled: () => {
      setReopening(false)
      qc.invalidateQueries({ queryKey: ['session', uuid] })
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  const cloneMutation = useMutation({
    mutationFn: async (opts: { prompt?: string; model?: string; effort?: EffortLevel; useTmux?: boolean } = {}) => {
      const res = await throwIfNotOk(await apiFetch(`/api/sessions/${uuid}/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      }))
      return res.json() as Promise<SessionMetadata>
    },
    onMutate: () => { setCloning(true); setActionError(null) },
    onError: (err) => {
      setActionError(mutationErrorMessage(err))
      settleSessionAction('error', () => setActionDialog(null))
    },
    onSuccess: (data) => {
      noticeIfCoerced(data)
      settleSessionAction('success', () => setActionDialog(null))
      qc.invalidateQueries({ queryKey: ['sessions'] })
      // Navigate to the new session
      router.push(`/session/${data.id}`)
    },
    onSettled: () => setCloning(false),
  })

  const editMetadataMutation = useMutation({
    mutationFn: async (opts: { model?: string; effort?: EffortLevel | ''; useTmux?: boolean }) => {
      const res = await throwIfNotOk(await apiFetch(`/api/sessions/${uuid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      }))
      return res.json() as Promise<SessionMetadata>
    },
    onMutate: () => setEditMetaError(null),
    onError: (err) => setEditMetaError(mutationErrorMessage(err)),
    onSuccess: (data) => {
      // Saved as tmux when the global headless switch is off — say so
      // rather than letting the record silently disagree with the request.
      noticeIfCoerced(data)
      setEditMetaOpen(false)
      qc.invalidateQueries({ queryKey: ['session', uuid] })
      qc.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  const [respawning, setRespawning] = useState(false)
  const respawnMutation = useMutation({
    mutationFn: async (opts: { model?: string; effort?: EffortLevel; useTmux?: boolean } = {}) => {
      const res = await throwIfNotOk(await apiFetch(`/api/sessions/${uuid}/respawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      }))
      return res.json() as Promise<SessionMetadata>
    },
    onMutate: () => { setRespawning(true); setActionError(null) },
    onError: (err) => {
      setActionError(mutationErrorMessage(err))
      settleSessionAction('error', () => setActionDialog(null))
    },
    onSuccess: (data) => {
      // Respawn is the lifecycle action that migrates a headless record to
      // tmux while the switch is off, so it is the one most likely to
      // surprise someone who set the session up headless.
      noticeIfCoerced(data)
      settleSessionAction('success', () => setActionDialog(null))
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

  // Survives the moment the server clears `pendingInquiry`, so a submitted
  // card switches to "Answer sent" instead of vanishing mid-confirmation.
  const inquiryCard = resolveInquiryCard({
    pending: session.pendingInquiry,
    answered: answeredInquiry,
    readOnly,
    now: Date.now(),
  })

  return (
    <div className="flex flex-col h-full">
      <SessionHeader
        session={session}
        descendantCount={descendantCount}
        parentPrompt={parentPrompt || undefined}
        readOnly={readOnly}
        onKill={() => { setKillError(null); setKillOpen(true) }}
        onArchive={() => {
          if (confirm('Mark this session as succeeded? Tmux will be terminated and the transcript will remain read-only for review.')) {
            archiveMutation.mutate()
          }
        }}
        onReopen={() => { setActionError(null); setActionDialog('reopen') }}
        onClone={() => { setActionError(null); setActionDialog('fork') }}
        onRespawn={() => { setActionError(null); setActionDialog('respawn') }}
        killing={killing}
        archiving={archiving}
        reopening={reopening}
        cloning={cloning}
        respawning={respawning}
        projectName={projectName}
        projectPath={projectPath}
        projectDefaultModel={currentProject?.defaultModel}
        projectDefaultEffort={currentProject?.defaultEffort}
        onDeleteRecord={() => { setDeleteRecordError(null); setDeleteOpen(true) }}
        deletingRecord={deletingRecord}
        onEditMetadata={() => { setEditMetaError(null); setEditMetaOpen(true) }}
      />

      {session.pendingPrompt && !readOnly && (
        <PendingPromptBanner uuid={uuid} prompt={session.pendingPrompt} />
      )}

      {/* Headless counterpart of the banner above: a structured question the
        * agent returned in its final response, answered as text that becomes
        * the next turn. The two are mutually exclusive in practice — a
        * pendingPrompt is scraped off a live tmux pane. */}
      {inquiryCard && (
        <InquiryCard
          uuid={uuid}
          inquiry={inquiryCard.inquiry}
          answered={inquiryCard.answered}
          onAnswered={(inquiry) => setAnsweredInquiry({ inquiry, at: Date.now() })}
        />
      )}

      <div className="flex-1 overflow-hidden">
        <TranscriptPanePoll uuid={uuid} status={session.status} agentType={session.agentType} />
      </div>

      {!readOnly && <InputBox uuid={uuid} status={session.status} agentType={session.agentType} useTmux={session.useTmux} />}

      <KillConfirmDialog
        open={killOpen}
        onClose={() => { setKillOpen(false); setKillError(null) }}
        onConfirm={() => killMutation.mutate()}
        descendantCount={descendantCount}
        killing={killing}
        error={killError}
      />

      <DeleteRecordDialog
        open={deleteOpen}
        session={session}
        workspacePath={projectPath}
        onClose={() => { setDeleteOpen(false); setDeleteRecordError(null) }}
        onConfirm={() => deleteRecordMutation.mutate()}
        deleting={deletingRecord}
        error={deleteRecordError}
      />

      <SessionMetadataEditDialog
        open={editMetaOpen}
        agentType={session.agentType}
        status={session.status}
        currentModel={session.model}
        currentEffort={session.effort}
        currentUseTmux={session.useTmux}
        defaultModel={currentProject?.defaultModel}
        defaultEffort={currentProject?.defaultEffort}
        pending={editMetadataMutation.isPending}
        error={editMetaError}
        onClose={() => { setEditMetaOpen(false); setEditMetaError(null) }}
        onConfirm={(opts) => editMetadataMutation.mutate(opts)}
      />

      <SessionActionDialog
        open={actionDialog !== null}
        kind={actionDialog ?? 'reopen'}
        agentType={session.agentType}
        currentModel={session.model}
        currentEffort={session.effort}
        defaultModel={currentProject?.defaultModel}
        defaultEffort={currentProject?.defaultEffort}
        currentUseTmux={session.useTmux}
        pending={reopening || cloning || respawning}
        error={actionError}
        onClose={() => { setActionDialog(null); setActionError(null) }}
        // NF24: this used to close the dialog first and mutate second, so
        // `pending` never reached a mounted dialog. Closing now belongs to
        // each mutation's onSuccess, via settleSessionAction.
        onConfirm={(opts) =>
          confirmSessionAction(actionDialog, opts, {
            reopen: (o) => reopenMutation.mutate({ model: o.model, effort: o.effort, useTmux: o.useTmux }),
            fork: (o) => cloneMutation.mutate({ prompt: o.prompt, model: o.model, effort: o.effort, useTmux: o.useTmux }),
            respawn: (o) => respawnMutation.mutate({ model: o.model, effort: o.effort, useTmux: o.useTmux }),
          })
        }
      />
    </div>
  )
}
