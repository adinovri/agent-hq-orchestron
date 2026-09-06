'use client'

import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { fetchJson } from '@/lib/fetcher'
import type { SessionStatus, AgentType } from '@agent-hq-orchestron/shared'
import { harnessLabel } from '@/lib/models'
import { Wrench, User, MessageSquare, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { AskUserQuestionCard } from './AskUserQuestionCard'

interface Entry {
  seq: number
  timestamp: string
  kind: 'user' | 'assistant' | 'tool_use' | 'tool_result'
  toolName?: string
  content: string
}

interface ContextStats {
  lastInputTokens: number
  lastCacheReadTokens: number
  lastCacheCreationTokens: number
  lastOutputTokens: number
  lastEffectiveContext: number
  assistantTurns: number
  compactionCount: number
  lastCompactedAt?: string
  /** Adapter-reported context limit (Codex sends model_context_window; Claude
   *  doesn't expose one, so we fall back to a 200K native default). */
  contextWindow?: number
}

interface TranscriptResponse {
  entries: Entry[]
  size: number
  contextStats: ContextStats | null
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`
  return String(n)
}

interface Props {
  uuid: string
  status?: SessionStatus
  agentType?: AgentType
}

function EntryView({ entry, uuid, answered }: { entry: Entry; uuid: string; answered: boolean }) {
  const [expanded, setExpanded] = useState(entry.kind !== 'tool_result')

  if (entry.kind === 'tool_use' && entry.toolName === 'AskUserQuestion') {
    return <AskUserQuestionCard uuid={uuid} contentJson={entry.content} answered={answered} />
  }

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
    // Parse the JSON input and extract the most useful field for display
    let summary: string | null = null
    let details: string | null = null
    try {
      const input = JSON.parse(entry.content) as Record<string, unknown>
      const tool = entry.toolName ?? ''
      if (tool === 'Bash' && typeof input.command === 'string') {
        summary = input.command
      } else if ((tool === 'Read' || tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit') && typeof input.file_path === 'string') {
        summary = input.file_path
      } else if (tool === 'Grep' && typeof input.pattern === 'string') {
        summary = input.pattern + (input.path ? `  (in ${input.path})` : '')
      } else if (tool === 'Glob' && typeof input.pattern === 'string') {
        summary = input.pattern
      } else if (tool === 'WebFetch' && typeof input.url === 'string') {
        summary = input.url
      } else if (tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate') {
        summary = typeof input.subject === 'string' ? input.subject : JSON.stringify(input).slice(0, 100)
      } else {
        summary = JSON.stringify(input).slice(0, 120)
      }
      details = entry.content
    } catch {
      summary = entry.content.slice(0, 120)
    }

    return (
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 w-7 h-7 rounded-full bg-amber-100 dark:bg-amber-950 flex items-center justify-center text-amber-700 dark:text-amber-300">
          <Wrench className="w-3.5 h-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <button onClick={() => setExpanded(v => !v)} className="w-full text-left flex items-start gap-1.5 group">
            <span className="shrink-0 mt-0.5">
              {expanded ? <ChevronDown className="w-3 h-3 text-zinc-500" /> : <ChevronRight className="w-3 h-3 text-zinc-500" />}
            </span>
            <code className="shrink-0 px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 font-mono text-[11px]">
              {entry.toolName ?? '?'}
            </code>
            <code className="min-w-0 font-mono text-xs text-zinc-700 dark:text-zinc-300 group-hover:text-zinc-900 dark:group-hover:text-zinc-100 truncate">
              {summary}
            </code>
          </button>
          {expanded && details && (
            <pre className="mt-1.5 text-[11px] bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded p-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-zinc-600 dark:text-zinc-400">
              {details}
            </pre>
          )}
        </div>
      </div>
    )
  }
  // tool_result — indent visually to show it belongs to the preceding tool_use
  return (
    <div className="flex items-start gap-2.5 pl-8">
      <div className="shrink-0 w-1 self-stretch bg-emerald-200 dark:bg-emerald-900 rounded" />
      <div className="flex-1 min-w-0">
        <button onClick={() => setExpanded(v => !v)} className="w-full text-left flex items-center gap-1.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-700">
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <span className="text-emerald-700 dark:text-emerald-400">↳ result</span>
          <span className="text-zinc-400">({entry.content.length.toLocaleString()} chars)</span>
        </button>
        {expanded && (
          <pre className="mt-1 text-[11px] bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded p-2 overflow-x-auto whitespace-pre-wrap font-mono text-zinc-700 dark:text-zinc-300 max-h-64 overflow-y-auto">
            {entry.content}
          </pre>
        )}
      </div>
    </div>
  )
}

/**
 * Compact context-usage badge. Claude native context is 200K, but sessions
 * on the 1M-tier can exceed that between compactions — so we show absolute
 * tokens against 200K (native ceiling) and color the bar by how close we
 * are to the next likely auto-compact.
 */
function ContextIndicator({ stats }: { stats: ContextStats }) {
  // Prefer adapter-reported limit (Codex), fall back to Claude's 200K native.
  const limit = stats.contextWindow ?? 200_000
  const ctx = stats.lastEffectiveContext
  const pct = Math.min(999, Math.round((ctx / limit) * 100))
  const barColor =
    pct < 60 ? 'bg-emerald-500' :
    pct < 85 ? 'bg-amber-500' :
    'bg-red-500'

  const tip = [
    `Last turn effective context: ${ctx.toLocaleString()} tokens`,
    `  input: ${stats.lastInputTokens}`,
    `  cache read: ${stats.lastCacheReadTokens}`,
    `  cache creation: ${stats.lastCacheCreationTokens}`,
    `Turns: ${stats.assistantTurns}`,
    `Compactions: ${stats.compactionCount}${stats.lastCompactedAt ? ` (last ${new Date(stats.lastCompactedAt).toLocaleString()})` : ''}`,
    stats.contextWindow
      ? `Model context window: ${stats.contextWindow.toLocaleString()}`
      : `Native ceiling shown: ${limit.toLocaleString()} — session may run on 1M tier`,
  ].join('\n')

  return (
    <span
      className="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-0.5 rounded border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 tabular-nums font-mono"
      title={tip}
    >
      <span className="text-[10px] uppercase tracking-wide text-zinc-400">ctx</span>
      <span className="text-zinc-700 dark:text-zinc-300">{formatTokens(ctx)}</span>
      <span className="text-zinc-400 dark:text-zinc-600">/{formatTokens(limit)}</span>
      <span className={`inline-block h-1.5 w-8 rounded-full overflow-hidden bg-zinc-200 dark:bg-zinc-800`}>
        <span className={`block h-full ${barColor}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      {stats.compactionCount > 0 && (
        <span
          className="text-[10px] px-1 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-500"
          title={`Compacted ${stats.compactionCount}× so far`}
        >
          ⤴{stats.compactionCount}
        </span>
      )}
    </span>
  )
}

export function TranscriptPanePoll({ uuid, status, agentType }: Props) {
  const label = harnessLabel(agentType)
  const bottomRef = useRef<HTMLDivElement>(null)
  const prevCountRef = useRef(0)

  const isThinking = status === 'running' || status === 'spawning'

  const { data, isLoading, refetch, dataUpdatedAt } = useQuery<TranscriptResponse>({
    queryKey: ['transcript', uuid],
    queryFn: () => fetchJson(`/api/sessions/${uuid}/transcript`),
    refetchInterval: 2000,
    refetchIntervalInBackground: true,
  })

  const entries = data?.entries ?? []

  // Auto-scroll only when new entries arrive
  useEffect(() => {
    if (entries.length > prevCountRef.current) {
      prevCountRef.current = entries.length
      const el = bottomRef.current
      if (!el) return
      const scroller = el.closest<HTMLElement>('[data-transcript-scroll]')
      requestAnimationFrame(() => {
        if (scroller) scroller.scrollTop = scroller.scrollHeight
        el.scrollIntoView({ behavior: 'auto', block: 'end' })
      })
    }
  }, [entries.length])

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 sm:px-4 py-2 border-b border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500 dark:text-zinc-400 flex-wrap">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
        <span>Polling · {entries.length} entries</span>
        {dataUpdatedAt && (
          <span className="text-zinc-400 dark:text-zinc-600 hidden sm:inline">
            · updated {new Date(dataUpdatedAt).toLocaleTimeString()}
          </span>
        )}
        {data?.contextStats && (
          <ContextIndicator stats={data.contextStats} />
        )}
        <button
          onClick={() => refetch()}
          className="ml-auto p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition"
          title="Refetch transcript"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>

      <div data-transcript-scroll className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 space-y-3">
        {isLoading && entries.length === 0 && (
          <div className="text-center py-12 text-sm text-zinc-400">Loading transcript…</div>
        )}
        {entries.map((e, idx) => {
          // For AskUserQuestion, treat as "answered" once any tool_result appears
          // after this entry in the transcript — orchestron's entries don't expose
          // tool_use_id linkage so we use position as a good-enough heuristic
          // (a single pending AskUserQuestion is the common case).
          const answered =
            e.kind === 'tool_use' && e.toolName === 'AskUserQuestion'
              ? entries.slice(idx + 1).some((later) => later.kind === 'tool_result')
              : false
          return <EntryView key={e.seq} entry={e} uuid={uuid} answered={answered} />
        })}
        {isThinking && entries.length > 0 && (
          <div className="flex items-center gap-2.5 pl-9 py-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="inline-flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            </span>
            <span>{status === 'spawning' ? `Starting ${label}…` : `${label} is thinking…`}</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
