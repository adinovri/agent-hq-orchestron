'use client'

import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { SessionStatus } from '@agent-hq-orchestron/shared'
import { Wrench, User, MessageSquare, ChevronDown, ChevronRight, Wifi, WifiOff, RefreshCw } from 'lucide-react'

const MAX_EVENTS = 500

interface Props {
  uuid: string
  status?: SessionStatus
}

interface TranscriptEntry {
  id: number
  kind: 'user' | 'assistant' | 'tool_use' | 'tool_result'
  content: string
  toolName?: string
  timestamp: string
}

// Claude JSONL event shape: {type, message: {role, content: [...]}, timestamp, ...}
// where content is an array of blocks {type: 'text'|'tool_use'|'tool_result', text?, name?, input?, content?}
interface ClaudeMessageBlock {
  type: string
  text?: string
  name?: string
  input?: unknown
  content?: string | Array<{ text?: string }>
}
interface ClaudeEvent {
  type: string
  message?: { role?: string; content?: ClaudeMessageBlock[] | string }
  timestamp?: string
}

function parseEvent(raw: string): TranscriptEntry[] {
  try {
    const ev: ClaudeEvent = JSON.parse(raw)
    const ts = ev.timestamp ?? new Date().toISOString()
    const out: TranscriptEntry[] = []

    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message!.content as ClaudeMessageBlock[]) {
        if (b.type === 'text' && b.text) {
          out.push({ id: Math.random(), kind: 'assistant', content: b.text, timestamp: ts })
        } else if (b.type === 'tool_use') {
          const inputStr = JSON.stringify(b.input ?? {}, null, 2)
          out.push({
            id: Math.random(),
            kind: 'tool_use',
            toolName: b.name,
            content: inputStr.slice(0, 4000) + (inputStr.length > 4000 ? '\n…(truncated)' : ''),
            timestamp: ts,
          })
        }
      }
    } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message!.content as ClaudeMessageBlock[]) {
        if (b.type === 'tool_result') {
          const text = typeof b.content === 'string'
            ? b.content
            : Array.isArray(b.content)
              ? b.content.map((c) => c.text ?? '').join('')
              : ''
          if (text) {
            out.push({
              id: Math.random(),
              kind: 'tool_result',
              content: text.slice(0, 4000) + (text.length > 4000 ? '\n…(truncated)' : ''),
              timestamp: ts,
            })
          }
        }
      }
    } else if (ev.type === 'user' && typeof ev.message?.content === 'string') {
      out.push({ id: Math.random(), kind: 'user', content: ev.message.content, timestamp: ts })
    }

    return out
  } catch {
    return []
  }
}

function entryKey(e: TranscriptEntry): string {
  return `${e.timestamp}|${e.kind}|${e.toolName ?? ''}|${e.content.length}|${e.content.slice(0, 80)}`
}

function TranscriptEntryView({ entry }: { entry: TranscriptEntry }) {
  const [expanded, setExpanded] = useState(entry.kind !== 'tool_result')

  if (entry.kind === 'user') {
    return (
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 w-7 h-7 rounded-full bg-blue-100 dark:bg-blue-950 flex items-center justify-center text-blue-700 dark:text-blue-300">
          <User className="w-3.5 h-3.5" />
        </div>
        <div className="flex-1 min-w-0 bg-blue-50 dark:bg-blue-950/40 rounded-lg px-3 py-2 text-sm text-zinc-800 dark:text-zinc-100 whitespace-pre-wrap break-words">
          {entry.content}
        </div>
      </div>
    )
  }

  if (entry.kind === 'assistant') {
    return (
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 w-7 h-7 rounded-full bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-700 dark:text-zinc-200">
          <MessageSquare className="w-3.5 h-3.5" />
        </div>
        <div className="flex-1 min-w-0 prose prose-sm dark:prose-invert max-w-none break-words overflow-x-auto">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {entry.content}
          </ReactMarkdown>
        </div>
      </div>
    )
  }

  if (entry.kind === 'tool_use') {
    return (
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 w-7 h-7 rounded-full bg-amber-100 dark:bg-amber-950 flex items-center justify-center text-amber-700 dark:text-amber-300">
          <Wrench className="w-3.5 h-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <button
            onClick={() => setExpanded((v) => !v)}
            className="w-full text-left flex items-center gap-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:text-zinc-800 dark:hover:text-zinc-100"
          >
            {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            <span>Tool</span>
            <code className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 font-mono text-[11px]">
              {entry.toolName ?? '?'}
            </code>
          </button>
          {expanded && (
            <pre className="mt-1.5 text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-zinc-700 dark:text-zinc-300">
              {entry.content}
            </pre>
          )}
        </div>
      </div>
    )
  }

  // tool_result
  return (
    <div className="flex items-start gap-2.5">
      <div className="shrink-0 w-7 h-7 rounded-full bg-emerald-50 dark:bg-emerald-950/60 flex items-center justify-center text-emerald-700 dark:text-emerald-300">
        <Wrench className="w-3.5 h-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full text-left flex items-center gap-1.5 text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
        >
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <span>Result</span>
          <span className="text-zinc-400">({entry.content.length.toLocaleString()} chars)</span>
        </button>
        {expanded && (
          <pre className="mt-1.5 text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-zinc-700 dark:text-zinc-300 max-h-64 overflow-y-auto">
            {entry.content}
          </pre>
        )}
      </div>
    </div>
  )
}

export function TranscriptPane({ uuid, status }: Props) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [connected, setConnected] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [debugCounts, setDebugCounts] = useState({ raw: 0, parsed: 0 })
  const bottomRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptRef = useRef(0)
  const connectedRef = useRef(false)
  const lastEventAtRef = useRef<number>(Date.now())
  const seenRef = useRef<Set<string>>(new Set())
  const debugRawRef = useRef(0)
  const debugParsedRef = useRef(0)

  const isThinking = status === 'running' || status === 'spawning'
  const isEmpty = entries.length === 0

  const forceRefresh = () => {
    seenRef.current.clear()
    setEntries([])
    setNonce((n) => n + 1)
  }

  useEffect(() => {
    let closed = false

    const connect = () => {
      if (closed) return

      if (esRef.current) {
        esRef.current.close()
        esRef.current = null
      }

      let token: string | null = null
      try {
        token = localStorage.getItem('orchestron_token') || sessionStorage.getItem('orchestron_token')
      } catch { /* ignore */ }
      const url = `/api/sessions/${uuid}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`
      const es = new EventSource(url)
      esRef.current = es
      lastEventAtRef.current = Date.now()

      es.onopen = () => {
        setConnected(true)
        connectedRef.current = true
        attemptRef.current = 0
        lastEventAtRef.current = Date.now()
      }

      const handleTranscript = (e: MessageEvent) => {
        lastEventAtRef.current = Date.now()
        debugRawRef.current += 1
        const newEntries = parseEvent(e.data)
        debugParsedRef.current += newEntries.length
        // Batch state updates
        setDebugCounts({ raw: debugRawRef.current, parsed: debugParsedRef.current })
        if (newEntries.length === 0) return
        const fresh: TranscriptEntry[] = []
        for (const entry of newEntries) {
          const key = entryKey(entry)
          if (seenRef.current.has(key)) continue
          seenRef.current.add(key)
          fresh.push(entry)
        }
        if (fresh.length === 0) return
        setEntries((prev) => {
          const next = [...prev, ...fresh]
          return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
        })
      }
      es.addEventListener('transcript', handleTranscript)
      es.onmessage = handleTranscript

      es.onerror = () => {
        setConnected(false)
        connectedRef.current = false
        if (closed) return
        // Don't stack up reconnects — health-check will kick in if needed.
        // Only schedule a reconnect if we don't already have one pending AND
        // the EventSource has actually closed (not just transiently erroring).
        if (reconnectTimerRef.current) return
        if (es.readyState !== EventSource.CLOSED) return
        const delay = Math.min(2000 * Math.pow(2, attemptRef.current), 30_000)
        attemptRef.current += 1
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null
          connect()
        }, delay)
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        // Any wake-up = probe the connection health. If we haven't seen an
        // event in 45s AND stream should be active, force reconnect.
        const stale = Date.now() - lastEventAtRef.current > 45_000
        if (!connectedRef.current || stale) {
          attemptRef.current = 0
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
          connect()
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    // Health-check every 30s: if nothing has streamed AND status suggests
    // activity, force reconnect. Silent SSE failures otherwise leave the UI
    // stale indefinitely.
    const healthTimer = setInterval(() => {
      if (closed) return
      const idle = Date.now() - lastEventAtRef.current
      if (idle > 45_000) {
        // Server sends `: ping\n\n` every 30s, so >45s idle = probably dead.
        attemptRef.current = 0
        connect()
      }
    }, 30_000)

    connect()

    return () => {
      closed = true
      document.removeEventListener('visibilitychange', onVisibility)
      clearInterval(healthTimer)
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
      if (esRef.current) {
        esRef.current.close()
        esRef.current = null
      }
      seenRef.current.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uuid, nonce])

  useEffect(() => {
    // Two-phase scroll: immediate jump + smooth follow-up to overcome late
    // layout shifts (images/markdown rendering after entries state settles).
    // Also poke the ancestor scroll container directly in case scrollIntoView
    // finds the wrong scroll ancestor.
    const el = bottomRef.current
    if (!el) return
    const scroller = el.closest<HTMLElement>('[data-transcript-scroll]')
    const jump = () => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight
      el.scrollIntoView({ behavior: 'auto', block: 'end' })
    }
    requestAnimationFrame(jump)
    // second pass after layout has settled (markdown/highlight, images)
    const t = setTimeout(jump, 150)
    return () => clearTimeout(t)
  }, [entries])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 sm:px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 text-xs">
        {connected ? (
          <>
            <Wifi className="w-3 h-3 text-emerald-500" />
            <span className="text-zinc-500 dark:text-zinc-400">Streaming live</span>
          </>
        ) : (
          <>
            <WifiOff className="w-3 h-3 text-zinc-400" />
            <span className="text-zinc-500 dark:text-zinc-400">Reconnecting…</span>
          </>
        )}
        {entries.length > 0 && (
          <span className="text-zinc-400 dark:text-zinc-500">· {entries.length} shown</span>
        )}
        <span
          className="text-[10px] text-zinc-400 dark:text-zinc-600 font-mono"
          title="Raw SSE frames received / entries parsed / entries shown"
        >
          [{debugCounts.raw}/{debugCounts.parsed}/{entries.length}]
        </span>
        <button
          onClick={forceRefresh}
          className="ml-auto p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition"
          title="Force reload transcript"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>

      <div data-transcript-scroll className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 space-y-3">
        {isEmpty && (
          <div className="text-center py-12">
            {connected ? (
              <>
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-zinc-100 dark:bg-zinc-800 mb-3">
                  <MessageSquare className="w-5 h-5 text-zinc-400" />
                </div>
                <p className="text-sm text-zinc-500">Waiting for transcript events…</p>
              </>
            ) : (
              <p className="text-sm text-zinc-400">Connecting to session stream…</p>
            )}
          </div>
        )}
        {entries.map((e) => (
          <TranscriptEntryView key={e.id} entry={e} />
        ))}
        {isThinking && !isEmpty && (
          <div className="flex items-center gap-2.5 pl-9 py-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="inline-flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
            <span>{status === 'spawning' ? 'Starting Claude…' : 'Claude is thinking…'}</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
