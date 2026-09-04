'use client'

import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { SessionEvent } from '@agent-hq-orchestron/shared'

const MAX_EVENTS = 500

interface Props {
  uuid: string
}

interface TranscriptEntry {
  id: number
  role: 'assistant' | 'tool' | 'system'
  content: string
  timestamp: string
}

function parseEvent(raw: string): TranscriptEntry | null {
  try {
    const ev: SessionEvent = JSON.parse(raw)
    let content = ''
    let role: TranscriptEntry['role'] = 'system'

    if (ev.type === 'assistant') {
      const data = ev.data as { content?: Array<{ type: string; text?: string }> }
      const texts = (data?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (!texts) return null
      content = texts
      role = 'assistant'
    } else if (ev.type === 'tool_use') {
      const data = ev.data as { name?: string; input?: unknown }
      content = `**Tool:** \`${data?.name}\`\n\`\`\`json\n${JSON.stringify(data?.input, null, 2)}\n\`\`\``
      role = 'tool'
    } else if (ev.type === 'tool_result') {
      const data = ev.data as { content?: string | Array<{ text?: string }> }
      const text = typeof data?.content === 'string'
        ? data.content
        : Array.isArray(data?.content)
          ? data.content.map((c) => c.text ?? '').join('')
          : ''
      if (!text) return null
      content = `**Tool result:**\n\`\`\`\n${text.slice(0, 2000)}${text.length > 2000 ? '\n…(truncated)' : ''}\n\`\`\``
      role = 'tool'
    } else if (ev.type === 'end_turn') {
      content = '*Session ended*'
      role = 'system'
    } else {
      return null
    }

    return { id: Math.random(), role, content, timestamp: ev.timestamp }
  } catch {
    return null
  }
}

const ROLE_STYLES: Record<TranscriptEntry['role'], string> = {
  assistant: 'bg-white dark:bg-zinc-900 border-l-2 border-blue-400',
  tool: 'bg-zinc-50 dark:bg-zinc-950 border-l-2 border-amber-400',
  system: 'bg-zinc-50 dark:bg-zinc-950 border-l-2 border-zinc-300',
}

export function TranscriptPane({ uuid }: Props) {
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [connected, setConnected] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let token: string | null = null
    try { token = sessionStorage.getItem('orchestron_token') } catch { /* ignore */ }
    const url = `/api/sessions/${uuid}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const es = new EventSource(url)

    es.onopen = () => setConnected(true)

    es.onmessage = (e) => {
      const entry = parseEvent(e.data)
      if (!entry) return
      setEntries((prev) => {
        const next = [...prev, entry]
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
      })
    }

    es.onerror = () => {
      setConnected(false)
    }

    return () => { es.close() }
  }, [uuid])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500">
        <span className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-zinc-400'}`} />
        {connected ? 'Streaming live' : 'Disconnected'}
        {entries.length > 0 && ` · ${entries.length} events`}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {entries.length === 0 && (
          <div className="text-center py-12 text-zinc-400 text-sm">
            {connected ? 'Waiting for transcript events…' : 'Connecting…'}
          </div>
        )}
        {entries.map((e) => (
          <div key={e.id} className={`rounded p-3 text-sm ${ROLE_STYLES[e.role]}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-zinc-500 uppercase">{e.role}</span>
              <span className="text-xs text-zinc-400">{new Date(e.timestamp).toLocaleTimeString()}</span>
            </div>
            <div className="prose prose-sm dark:prose-invert max-w-none break-words overflow-x-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {e.content}
              </ReactMarkdown>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
