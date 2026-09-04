'use client'

import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

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

function parseEvent(raw: string): TranscriptEntry | null {
  try {
    const ev: ClaudeEvent = JSON.parse(raw)
    const parts: Array<{ role: TranscriptEntry['role']; content: string }> = []

    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message!.content as ClaudeMessageBlock[]) {
        if (b.type === 'text' && b.text) {
          parts.push({ role: 'assistant', content: b.text })
        } else if (b.type === 'tool_use') {
          const inputStr = JSON.stringify(b.input ?? {}, null, 2)
          parts.push({
            role: 'tool',
            content: `**Tool:** \`${b.name}\`\n\`\`\`json\n${inputStr.slice(0, 2000)}${inputStr.length > 2000 ? '\n…(truncated)' : ''}\n\`\`\``,
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
            parts.push({
              role: 'tool',
              content: `**Tool result:**\n\`\`\`\n${text.slice(0, 2000)}${text.length > 2000 ? '\n…(truncated)' : ''}\n\`\`\``,
            })
          }
        }
      }
    } else if (ev.type === 'user' && typeof ev.message?.content === 'string') {
      // User's typed prompt
      parts.push({ role: 'system', content: `**User:** ${ev.message.content}` })
    }

    if (parts.length === 0) return null

    // Combine multiple parts into single entry (first wins for role display)
    return {
      id: Math.random(),
      role: parts[0]!.role,
      content: parts.map((p) => p.content).join('\n\n'),
      timestamp: ev.timestamp ?? new Date().toISOString(),
    }
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

    const handleTranscript = (e: MessageEvent) => {
      const entry = parseEvent(e.data)
      if (!entry) return
      setEntries((prev) => {
        const next = [...prev, entry]
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
      })
    }
    // Server sends named events `event: transcript` — need addEventListener, onmessage
    // only fires for unnamed default events.
    es.addEventListener('transcript', handleTranscript)
    // Fallback for unnamed events (defensive):
    es.onmessage = handleTranscript

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
