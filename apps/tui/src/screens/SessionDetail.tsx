import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import fs from 'node:fs'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'
import type { ApiConfig } from '../hooks/useApi.js'
import { useApi, apiPost, apiDelete, apiPatch, apiGetBuffer } from '../hooks/useApi.js'
import { ComposeBox } from '../components/ComposeBox.js'
import { AskUserCard } from '../components/AskUserCard.js'
import { MetadataEditDialog } from '../components/MetadataEditDialog.js'
import { ExportDialog } from '../components/ExportDialog.js'
import { KillConfirmWizard } from '../components/KillConfirmWizard.js'
import { ReopenModeWizard } from '../components/ReopenModeWizard.js'

interface Props {
  session: SessionMetadata
  config: ApiConfig
  onBack: () => void
  onStatus: (msg: string, isError?: boolean) => void
  onDiagnostics: (uuid: string) => void
  onDelegation: (uuid: string) => void
}

interface TranscriptEntry {
  seq: number
  timestamp: string
  kind: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'aside'
  toolName?: string
  content: string
}

interface TranscriptResponse {
  entries: TranscriptEntry[]
  size: number
}

type ModalMode =
  | 'none'
  | 'kill_wizard'
  | 'reopen_wizard'
  | 'fork_wizard'
  | 'respawn_wizard'
  | 'confirm_archive'
  | 'export'
  | 'metadata'
  | 'compose'
  | 'ask_user'

interface RoleStyle {
  prefix: string
  color: string
  dim: boolean
}

const ROLE_STYLE: Record<string, RoleStyle> = {
  assistant: { prefix: '◆', color: 'cyan', dim: false },
  user: { prefix: '▸', color: 'white', dim: false },
  tool_use: { prefix: '⚙', color: 'gray', dim: true },
  tool_result: { prefix: '↳', color: 'gray', dim: true },
  aside: { prefix: '⚠', color: 'yellow', dim: false },
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const { default: clipboard } = await import('clipboardy')
    await clipboard.write(text)
    return true
  } catch {
    return false
  }
}

function findPendingAskUser(entries: TranscriptEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === 'tool_use' && e.toolName === 'AskUserQuestion') {
      const hasResult = entries.slice(i + 1).some((later) => later.kind === 'tool_result')
      if (!hasResult) return i
    }
  }
  return -1
}

export function SessionDetail({ session, config, onBack, onStatus, onDiagnostics, onDelegation }: Props) {
  const [scrollOffset, setScrollOffset] = useState(0)
  const [modal, setModal] = useState<ModalMode>('none')
  const [busy, setBusy] = useState(false)
  const [clipboardFallback, setClipboardFallback] = useState<string | null>(null)

  const transcriptUrl = `/api/sessions/${session.id}/transcript`
  const { data, error, loading: transcriptLoading, reconnecting, reload } = useApi<TranscriptResponse>(transcriptUrl, config, 3000)

  const entries = data?.entries ?? []
  const VISIBLE = 20

  const pendingAskIdx = findPendingAskUser(entries)
  const hasPendingAsk = pendingAskIdx !== -1

  const scrollDown = useCallback(() => {
    setScrollOffset((s) => Math.min(s + 1, Math.max(0, entries.length - VISIBLE)))
  }, [entries.length])

  const scrollUp = useCallback(() => {
    setScrollOffset((s) => Math.max(0, s - 1))
  }, [])

  const doLifecycle = useCallback(
    async (action: 'reopen' | 'fork' | 'respawn' | 'archive' | 'kill', useTmux?: boolean) => {
      if (busy) return
      setBusy(true)
      setModal('none')
      try {
        if (action === 'kill') {
          await apiDelete(`/api/sessions/${session.id}`, config)
          onStatus(`Killed ${session.id.slice(0, 8)}`)
        } else if (action === 'archive') {
          await apiPost(`/api/sessions/${session.id}/archive`, {}, config)
          onStatus(`Archived ${session.id.slice(0, 8)}`)
        } else if (action === 'reopen') {
          const body = useTmux !== undefined ? { useTmux } : {}
          await apiPost(`/api/sessions/${session.id}/reopen`, body, config)
          onStatus(`Reopened ${session.id.slice(0, 8)}`)
        } else if (action === 'respawn') {
          const body = useTmux !== undefined ? { useTmux } : {}
          await apiPost(`/api/sessions/${session.id}/respawn`, body, config)
          onStatus(`Respawned ${session.id.slice(0, 8)}`)
        } else if (action === 'fork') {
          const body = useTmux !== undefined ? { useTmux } : {}
          await apiPost(`/api/sessions/${session.id}/clone`, body, config)
          onStatus(`Forked ${session.id.slice(0, 8)} — new session spawned`)
        }
        onBack()
      } catch (e) {
        onStatus(String(e), true)
      } finally {
        setBusy(false)
      }
    },
    [busy, session.id, config, onStatus, onBack],
  )

  const doExport = useCallback(
    async (filePath: string) => {
      if (busy) return
      setBusy(true)
      setModal('none')
      try {
        const { buffer, filename } = await apiGetBuffer(`/api/sessions/${session.id}/export`, config)
        const resolved = filePath.endsWith('/') ? `${filePath}${filename}` : filePath
        fs.writeFileSync(resolved, buffer)
        onStatus(`Exported to ${resolved}`)
      } catch (e) {
        onStatus(String(e), true)
      } finally {
        setBusy(false)
      }
    },
    [busy, session.id, config, onStatus],
  )

  const doMetadataEdit = useCallback(
    async (model: string | undefined, effort: string | undefined) => {
      if (busy) return
      setBusy(true)
      setModal('none')
      try {
        const body: Record<string, string> = {}
        if (model !== undefined) body.model = model
        if (effort !== undefined) body.effort = effort
        if (Object.keys(body).length === 0) {
          onStatus('No changes')
          return
        }
        await apiPatch(`/api/sessions/${session.id}`, body, config)
        onStatus(`Metadata updated for ${session.id.slice(0, 8)}`)
      } catch (e) {
        onStatus(String(e), true)
      } finally {
        setBusy(false)
      }
    },
    [busy, session.id, config, onStatus],
  )

  const doSendInput = useCallback(
    async (prompt: string) => {
      if (busy) return
      setBusy(true)
      setModal('none')
      try {
        await apiPost(`/api/sessions/${session.id}/input`, { prompt }, config)
        onStatus(`Sent to ${session.id.slice(0, 8)}`)
        reload()
      } catch (e) {
        onStatus(String(e), true)
      } finally {
        setBusy(false)
      }
    },
    [busy, session.id, config, onStatus, reload],
  )

  const doCopy = useCallback(async () => {
    const ok = await copyToClipboard(session.id)
    if (ok) {
      onStatus(`Copied UUID: ${session.id}`)
    } else {
      setClipboardFallback(session.id)
      onStatus('Clipboard unavailable — UUID displayed below, select manually')
    }
  }, [session.id, onStatus])

  useInput(
    useCallback(
      (input, key) => {
        if (busy) return
        if (modal !== 'none') {
          // wizard dialogs (kill_wizard, reopen/fork/respawn_wizard) handle their own input
          // only handle simple confirm_archive inline
          if (modal === 'confirm_archive') {
            if (input === 'y' || key.return) {
              doLifecycle('archive')
            } else {
              setModal('none')
              onStatus('Action cancelled')
            }
          }
          return
        }

        if (clipboardFallback !== null) {
          setClipboardFallback(null)
          return
        }

        if (input === 'q' || key.escape) {
          onBack()
        } else if (key.downArrow || input === 'j') {
          scrollDown()
        } else if (key.upArrow || input === 'k') {
          scrollUp()
        } else if (input === 'r') {
          setModal('reopen_wizard')
        } else if (input === 'f') {
          setModal('fork_wizard')
        } else if (input === 'R') {
          setModal('respawn_wizard')
        } else if (input === 'a') {
          setModal('confirm_archive')
        } else if (input === 's') {
          setModal('confirm_archive') // mark success = archive
        } else if (input === 'K') {
          setModal('kill_wizard')
        } else if (input === 'e') {
          setModal('export')
        } else if (input === 'y') {
          doCopy()
        } else if (input === 'M') {
          setModal('metadata')
        } else if (input === 'i') {
          setModal('compose')
        } else if (input === 'Q' && hasPendingAsk) {
          setModal('ask_user')
        } else if (input === 'd') {
          onDiagnostics(session.id)
        } else if (input === 'D') {
          onDelegation(session.id)
        }
      },
      [busy, modal, clipboardFallback, onBack, scrollDown, scrollUp, doLifecycle, doCopy, onDiagnostics, onDelegation, hasPendingAsk, onStatus, session.id],
    ),
  )

  const visible = entries.slice(scrollOffset, scrollOffset + VISIBLE)

  // Is a given tool_use entry's AskUserQuestion answered (has a subsequent tool_result)?
  const isAnswered = (entryIdx: number) => {
    const e = entries[entryIdx]
    if (e.kind !== 'tool_use' || e.toolName !== 'AskUserQuestion') return false
    return entries.slice(entryIdx + 1).some((later) => later.kind === 'tool_result')
  }

  const keybindHint = [
    'j/k=scroll',
    'i=compose',
    hasPendingAsk ? 'Q=answer' : '',
    'r=reopen',
    'f=fork',
    'R=respawn',
    'a/s=archive',
    'K=kill',
    'e=export',
    'y=copy-id',
    'M=edit-meta',
    'd=diag',
    'D=graph',
    'q=back',
  ].filter(Boolean).join('  ')

  return (
    <Box flexDirection="column">
      <Box borderStyle="single" paddingX={1} marginBottom={1} flexWrap="wrap">
        <Text bold>Session: </Text>
        <Text color="cyan">{session.id.slice(0, 8)}</Text>
        <Text color="gray">  {session.tmuxName}  </Text>
        <Text color={session.status === 'running' ? 'green' : session.status === 'needs_input' ? 'yellow' : 'gray'}>{session.status}</Text>
        {session.model && (
          <Text color="gray" dimColor>  {session.model}</Text>
        )}
        <Box flexGrow={1} />
      </Box>

      <Box paddingX={1} marginBottom={0}>
        <Text color="gray" dimColor wrap="wrap">{keybindHint}</Text>
      </Box>

      {reconnecting && <Box paddingX={1}><Text color="yellow">⟳ reconnecting…</Text></Box>}
      {error && <Box paddingX={1}><Text color="red">Error: {error}</Text></Box>}
      {transcriptLoading && !data && <Box paddingX={1}><Text color="gray" dimColor>Loading transcript…</Text></Box>}

      {/* Kill confirm wizard (2-step) */}
      {modal === 'kill_wizard' && (
        <KillConfirmWizard
          session={session}
          onConfirm={() => doLifecycle('kill')}
          onCancel={() => { setModal('none'); onStatus('Kill cancelled') }}
        />
      )}

      {/* Reopen/Fork/Respawn mode picker */}
      {(modal === 'reopen_wizard' || modal === 'fork_wizard' || modal === 'respawn_wizard') && (
        <ReopenModeWizard
          action={modal === 'reopen_wizard' ? 'reopen' : modal === 'fork_wizard' ? 'fork' : 'respawn'}
          onConfirm={(useTmux) => {
            const action = modal === 'reopen_wizard' ? 'reopen' : modal === 'fork_wizard' ? 'fork' : 'respawn'
            doLifecycle(action, useTmux)
          }}
          onCancel={() => { setModal('none'); onStatus('Action cancelled') }}
        />
      )}

      {/* Archive confirm */}
      {modal === 'confirm_archive' && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} marginX={1} marginBottom={1}>
          <Text color="yellow">Archive {session.id.slice(0, 8)}? </Text>
          <Text color="white">y/Enter=yes  any other key=cancel</Text>
        </Box>
      )}

      {/* Export dialog */}
      {modal === 'export' && (
        <ExportDialog
          suggestedFilename={`${session.id.slice(0, 8)}.jsonl`}
          onSubmit={doExport}
          onCancel={() => { setModal('none'); onStatus('Export cancelled') }}
        />
      )}

      {/* Metadata edit dialog */}
      {modal === 'metadata' && (
        <MetadataEditDialog
          currentModel={session.model}
          currentEffort={session.effort}
          onSubmit={doMetadataEdit}
          onCancel={() => { setModal('none'); onStatus('Metadata edit cancelled') }}
        />
      )}

      {/* Compose mode */}
      {modal === 'compose' && (
        <ComposeBox
          onSubmit={doSendInput}
          onCancel={() => { setModal('none'); onStatus('Compose cancelled') }}
        />
      )}

      {/* Clipboard fallback */}
      {clipboardFallback !== null && (
        <Box borderStyle="round" borderColor="cyan" paddingX={1} marginX={1} marginBottom={1}>
          <Text color="cyan">UUID (select manually): </Text>
          <Text color="white">{clipboardFallback}</Text>
          <Text color="gray">  (any key to dismiss)</Text>
        </Box>
      )}

      {/* Transcript */}
      <Box flexDirection="column" paddingX={1}>
        {visible.map((entry, visIdx) => {
          const absIdx = scrollOffset + visIdx
          const style = ROLE_STYLE[entry.kind] ?? { prefix: ' ', color: 'white', dim: false }

          // AskUserQuestion card
          if (entry.kind === 'tool_use' && entry.toolName === 'AskUserQuestion') {
            const answered = isAnswered(absIdx)
            return (
              <AskUserCard
                key={entry.seq}
                content={entry.content}
                answered={answered}
                active={modal === 'ask_user' && !answered && absIdx === pendingAskIdx}
                onSubmit={(text) => {
                  setModal('none')
                  doSendInput(text)
                }}
              />
            )
          }

          const label =
            entry.kind === 'tool_use' && entry.toolName
              ? `${style.prefix} ${entry.toolName.slice(0, 18)}`
              : style.prefix
          return (
            <Box key={entry.seq} flexDirection="row" marginBottom={0}>
              <Text color={style.color} dimColor={style.dim} bold={!style.dim}>
                {label.padEnd(entry.kind === 'tool_use' ? 21 : 3)}
              </Text>
              <Box flexGrow={1} paddingLeft={entry.kind === 'tool_result' ? 2 : 0}>
                <Text color={style.color} dimColor={style.dim} wrap="wrap">
                  {entry.content.slice(0, 160)}
                </Text>
              </Box>
            </Box>
          )
        })}
        {entries.length === 0 && !error && (
          <Text color="gray">No transcript yet — session may still be spawning…</Text>
        )}
      </Box>

      <Box marginTop={1} paddingX={1}>
        <Text color="gray">
          Entries: {entries.length}  Scroll: {scrollOffset}/{Math.max(0, entries.length - VISIBLE)}
          {data?.size != null ? `  Size: ${(data.size / 1024).toFixed(1)}KB` : ''}
          {hasPendingAsk ? '  ⚠ pending Q' : ''}
          {busy ? '  [working…]' : ''}
        </Text>
      </Box>
    </Box>
  )
}
