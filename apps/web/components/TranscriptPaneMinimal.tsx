'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Absolute-minimum transcript pane. No dedupe, no reconnect, no polish.
 * Just: EventSource → append raw event to state → render as plain text.
 * Diagnostic build to isolate whether the issue is in server, network,
 * SSE, or client-side React rendering.
 */
export function TranscriptPaneMinimal({ uuid }: { uuid: string }) {
  const [lines, setLines] = useState<string[]>([])
  const [status, setStatus] = useState('init')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let token: string | null = null
    try {
      token = localStorage.getItem('orchestron_token') || sessionStorage.getItem('orchestron_token')
    } catch { /* ignore */ }
    const url = `/api/sessions/${uuid}/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const es = new EventSource(url)

    es.onopen = () => setStatus('open')
    es.onerror = () => setStatus('error')

    const handle = (e: MessageEvent) => {
      let display = e.data
      try {
        const d = JSON.parse(e.data)
        const t = d.type ?? '?'
        const msg = d.message?.content
        let extract = ''
        if (typeof msg === 'string') extract = msg
        else if (Array.isArray(msg)) {
          extract = msg.map((b: { type?: string; text?: string; name?: string; content?: unknown }) => {
            if (b.type === 'text') return b.text
            if (b.type === 'tool_use') return `[tool:${b.name}]`
            if (b.type === 'tool_result') {
              const c = b.content
              return `[result:${typeof c === 'string' ? c.slice(0, 60) : JSON.stringify(c).slice(0, 60)}]`
            }
            if (b.type === 'thinking') return '[thinking]'
            return ''
          }).filter(Boolean).join(' | ')
        }
        display = `${d.timestamp?.slice(11, 19) ?? '?'} ${t}${extract ? ': ' + extract.slice(0, 200) : ''}`
      } catch { /* keep raw */ }
      setLines(prev => [...prev, display].slice(-500))
    }
    es.addEventListener('transcript', handle)
    es.onmessage = handle

    return () => { es.close() }
  }, [uuid])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [lines])

  return (
    <div className="flex flex-col h-full font-mono text-xs">
      <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 text-zinc-500">
        MINIMAL DIAG · status={status} · lines={lines.length}
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5 bg-zinc-50 dark:bg-zinc-950">
        {lines.map((l, i) => (
          <div key={i} className="border-b border-zinc-100 dark:border-zinc-900 py-0.5 break-all whitespace-pre-wrap">
            {l}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
