'use client'

import { useState, KeyboardEvent, useEffect, useRef, ClipboardEvent, DragEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/fetcher'
import type { SessionStatus } from '@agent-hq-orchestron/shared'
import { Paperclip, X, FileText, Image as ImageIcon, FileCode, File as FileIcon, Square } from 'lucide-react'

interface Props {
  uuid: string
  status: SessionStatus
}

interface AttachedFile {
  id: string           // client-local uid
  file: File
  preview?: string     // for images
}

interface UploadedFile {
  path: string
  name: string
  size: number
  mime: string
}

// Queue-during-run: allow sending while Claude is still thinking; the TUI
// buffers the paste and processes it as the next turn.
const ENABLED: SessionStatus[] = ['needs_input', 'idle', 'waiting', 'running', 'sleeping']
const HINT: Partial<Record<SessionStatus, string>> = {
  spawning: 'Session is spawning…',
  waiting: 'Session ready — type your first message',
  running: 'Queue next turn (Claude is still thinking)',
  needs_input: 'Type your reply',
  idle: 'Send a follow-up',
  sleeping: 'Session is sleeping — send to wake it up (~3s cold start)',
  completing: 'Session is completing…',
  completed: 'Session ended',
  succeeded: 'Session succeeded (archived)',
  failed: 'Session failed',
  killed: 'Session killed',
}

function fileIcon(mime: string, name: string) {
  if (mime.startsWith('image/')) return <ImageIcon className="w-4 h-4" />
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|sh|rb|md|json|yaml|yml|toml|html|css)$/i.test(name)) {
    return <FileCode className="w-4 h-4" />
  }
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return <FileText className="w-4 h-4" />
  return <FileIcon className="w-4 h-4" />
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

export function InputBox({ uuid, status }: Props) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [lastSent, setLastSent] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const qc = useQueryClient()

  useEffect(() => {
    if (['needs_input', 'idle', 'completed', 'succeeded', 'failed', 'killed'].includes(status)) {
      setLastSent(null)
    }
  }, [status])

  // Cleanup preview URLs on unmount / attachment change
  useEffect(() => {
    return () => {
      attachments.forEach(a => a.preview && URL.revokeObjectURL(a.preview))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addFiles = (files: FileList | File[]) => {
    const arr = Array.from(files)
    if (arr.length === 0) return
    const next: AttachedFile[] = arr.map(f => ({
      id: crypto.randomUUID(),
      file: f,
      preview: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
    }))
    setAttachments(prev => [...prev, ...next].slice(0, 10))
  }

  const removeFile = (id: string) => {
    setAttachments(prev => {
      const target = prev.find(a => a.id === id)
      if (target?.preview) URL.revokeObjectURL(target.preview)
      return prev.filter(a => a.id !== id)
    })
  }

  const interruptMutation = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`/api/sessions/${uuid}/interrupt`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      return res.json()
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session', uuid] }),
  })

  const sendMutation = useMutation({
    mutationFn: async ({ prompt, files }: { prompt: string; files: AttachedFile[] }) => {
      let uploaded: UploadedFile[] = []
      if (files.length > 0) {
        const fd = new FormData()
        files.forEach(a => fd.append('file', a.file, a.file.name))
        const upRes = await apiFetch(`/api/sessions/${uuid}/upload`, {
          method: 'POST',
          body: fd,
        })
        if (!upRes.ok) throw new Error(`Upload failed: HTTP ${upRes.status} ${await upRes.text()}`)
        const upJson = (await upRes.json()) as { files: UploadedFile[] }
        uploaded = upJson.files
      }

      let finalPrompt = prompt
      if (uploaded.length > 0) {
        const list = uploaded.map(f => `- ${f.path}  (${f.name}, ${formatSize(f.size)}, ${f.mime})`).join('\n')
        finalPrompt = `${prompt}\n\nAttached files (saved on server, use Read tool to inspect):\n${list}`
      }

      const res = await apiFetch(`/api/sessions/${uuid}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: finalPrompt }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      return { session: await res.json(), uploaded, finalPrompt }
    },
    onSuccess: (data) => {
      setLastSent(data.finalPrompt)
      setText('')
      // Revoke preview URLs
      attachments.forEach(a => a.preview && URL.revokeObjectURL(a.preview))
      setAttachments([])
      qc.invalidateQueries({ queryKey: ['session', uuid] })
    },
  })

  const enabled = ENABLED.includes(status) && !sendMutation.isPending
  const hint = HINT[status] ?? ''

  const submit = () => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || !enabled) return
    sendMutation.mutate({ prompt: trimmed || '(see attached files)', files: attachments })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      submit()
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.files)
    if (items.length > 0) {
      e.preventDefault()
      addFiles(items)
    }
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files)
  }

  const isAwaiting = status === 'needs_input'
  const isThinking = status === 'running' || status === 'spawning'

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`border-t px-3 py-2 transition-colors ${
        dragOver ? 'border-blue-400 bg-blue-50/50 dark:bg-blue-950/30' :
        isAwaiting ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/20' :
        'border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900'
      }`}
    >
      {lastSent && (
        <div className="flex items-start gap-1.5 mb-2 text-xs text-zinc-500 border-l-2 border-blue-400 pl-2 py-1 bg-blue-50 dark:bg-blue-950/20">
          <span className="font-medium text-blue-600 dark:text-blue-400 shrink-0">Sent:</span>
          <span className="break-words">{lastSent.length > 200 ? lastSent.slice(0, 200) + '…' : lastSent}</span>
        </div>
      )}
      {isThinking && (
        <div className="flex items-center justify-between gap-2 mb-2 text-xs">
          <div className="flex items-center gap-2 text-zinc-500">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            <span>{status === 'spawning' ? 'Starting Claude…' : 'Claude is thinking…'}</span>
          </div>
          {status === 'running' && (
            <button
              type="button"
              onClick={() => interruptMutation.mutate()}
              disabled={interruptMutation.isPending}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950 text-[11px] transition disabled:opacity-50"
              title="Interrupt current turn (sends Escape to Claude)"
            >
              <Square className="w-2.5 h-2.5" fill="currentColor" />
              {interruptMutation.isPending ? 'Interrupting…' : 'Interrupt'}
            </button>
          )}
        </div>
      )}
      {isAwaiting && (
        <div className="text-xs font-medium text-amber-700 dark:text-amber-400 mb-1">
          Needs your input
        </div>
      )}

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {attachments.map(a => (
            <div key={a.id} className="relative inline-flex items-center gap-1.5 pl-1.5 pr-6 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 text-xs">
              {a.preview ? (
                <img src={a.preview} alt={a.file.name} className="w-6 h-6 object-cover rounded" />
              ) : (
                <span className="text-zinc-500 dark:text-zinc-400">{fileIcon(a.file.type, a.file.name)}</span>
              )}
              <span className="text-zinc-700 dark:text-zinc-300 max-w-[140px] truncate" title={a.file.name}>{a.file.name}</span>
              <span className="text-zinc-400 text-[10px]">{formatSize(a.file.size)}</span>
              <button
                onClick={() => removeFile(a.id)}
                type="button"
                className="absolute right-0.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-950 text-zinc-400 hover:text-red-600"
                title="Remove"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-end">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={!enabled}
          placeholder={hint || 'Type a message…'}
          rows={2}
          className="flex-1 resize-none rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1.5 text-sm disabled:bg-zinc-50 disabled:text-zinc-400 dark:disabled:bg-zinc-950 dark:disabled:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <div className="flex flex-col gap-1 shrink-0">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!enabled}
            title="Attach files (or drag/paste)"
            className="rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed h-8 w-8 flex items-center justify-center transition"
          >
            <Paperclip className="w-3.5 h-3.5 text-zinc-600 dark:text-zinc-300" />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            onClick={submit}
            disabled={!enabled || (!text.trim() && attachments.length === 0)}
            className="rounded bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-300 dark:disabled:bg-zinc-700 text-white text-sm font-medium px-3 py-1.5 transition"
          >
            {sendMutation.isPending ? '…' : 'Send'}
          </button>
        </div>
      </div>
      {sendMutation.isError && (
        <div className="text-xs text-red-600 mt-1">{(sendMutation.error as Error).message}</div>
      )}
      <div className="text-[10px] text-zinc-400 mt-1">
        Ctrl+Enter to send · drag/paste/📎 for files (max 10 · 20MB each)
      </div>
    </div>
  )
}
