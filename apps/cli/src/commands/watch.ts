import type { Command } from 'commander'
import pc from 'picocolors'
import { apiRequest, resolveApiBase, resolveToken, type CommonOpts } from '../helpers/api.js'
import { withCommonOptions } from '../helpers/output.js'

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'killed'])

type TranscriptEntry = {
  seq: number
  timestamp: string
  kind: 'user' | 'assistant' | 'tool_use' | 'tool_result'
  toolName?: string
  content: string
}

type TranscriptResponse = {
  entries: TranscriptEntry[]
}

type SessionResponse = {
  status: string
}

const KIND_LABEL: Record<string, (s: string) => string> = {
  user: (s) => pc.cyan('user:        ') + s,
  assistant: (s) => pc.green('assistant:   ') + s,
  tool_use: (s) => pc.yellow('tool_use:    ') + s,
  tool_result: (s) => pc.dim('tool_result: ') + s,
}

function formatEntry(entry: TranscriptEntry, raw: boolean): string {
  if (raw) return JSON.stringify(entry)
  const label = KIND_LABEL[entry.kind] ?? ((s: string) => `${entry.kind}: ${s}`)
  const name = entry.toolName ? pc.dim(`[${entry.toolName}]`) + ' ' : ''
  const preview = entry.content.length > 300 ? entry.content.slice(0, 297) + '…' : entry.content
  return label(name + preview)
}

async function fetchTranscript(
  opts: CommonOpts,
  uuid: string,
): Promise<TranscriptEntry[]> {
  const data = await apiRequest<TranscriptResponse>(opts, `/api/sessions/${uuid}/transcript`)
  return data.entries ?? []
}

async function fetchStatus(opts: CommonOpts, uuid: string): Promise<string | null> {
  try {
    const data = await apiRequest<SessionResponse>(opts, `/api/sessions/${uuid}`)
    return data.status ?? null
  } catch {
    return null
  }
}

export function registerWatch(program: Command): void {
  withCommonOptions(
    program
      .command('watch <id>')
      .description('Stream a session transcript live (poll until terminal state). Ctrl+C to stop.')
      .option('--interval <ms>', 'Poll interval in milliseconds', '3000')
      .option('--raw', 'Emit raw JSON lines instead of formatted output'),
  ).action(async (id: string, opts: CommonOpts & { interval?: string; raw?: boolean }) => {
    const intervalMs = Math.max(500, parseInt(opts.interval ?? '3000', 10))
    const raw = Boolean(opts.raw)
    const base = resolveApiBase(opts)
    const token = resolveToken(opts)
    // Re-use the same opts shape so apiRequest picks up url/token correctly
    const effectiveOpts: CommonOpts = { ...opts, url: base, token }

    if (!raw) {
      process.stderr.write(pc.cyan(`Watching session ${id} (every ${intervalMs}ms)…`) + '\n')
      process.stderr.write(pc.dim('Ctrl+C to stop.\n'))
    }

    let lastSeq = -1
    let running = true

    process.on('SIGINT', () => {
      running = false
      if (!raw) process.stderr.write(pc.gray('\n[Stopped]\n'))
      process.exitCode = 0
    })

    while (running) {
      try {
        const entries = await fetchTranscript(effectiveOpts, id)

        const newEntries = entries.filter((e) => e.seq > lastSeq)
        if (newEntries.length > 0) {
          lastSeq = newEntries[newEntries.length - 1]!.seq
          for (const entry of newEntries) {
            process.stdout.write(formatEntry(entry, raw) + '\n')
          }
        }

        const status = await fetchStatus(effectiveOpts, id)
        if (status && TERMINAL_STATUSES.has(status)) {
          if (!raw) {
            process.stderr.write(
              pc.dim(`\n[Session ${id} reached terminal state: ${status}]\n`),
            )
          }
          break
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('404') || msg.includes('not found')) {
          if (!raw) process.stderr.write(pc.gray('\n[Session not found — may have been archived]\n'))
          break
        }
        if (!raw) process.stderr.write(pc.yellow(`[warn] ${msg}\n`))
        // network hiccup — keep polling
      }

      if (!running) break
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  })
}
