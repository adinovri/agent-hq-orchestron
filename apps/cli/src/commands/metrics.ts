import type { Command } from 'commander'
import pc from 'picocolors'
import Table from 'cli-table3'
import { apiRequest, type CommonOpts } from '../helpers/api.js'
import { action, withCommonOptions } from '../helpers/output.js'

interface MetricsBucket {
  key: string
  sessions: number
  tokens: number
  cost_usd: number
  avg_duration_ms: number
}

interface MetricsQueryResult {
  buckets: MetricsBucket[]
  total: { sessions: number; tokens: number; cost_usd: number }
}

const GROUP_BY = ['day', 'project', 'session', 'adapter', 'model'] as const

/**
 * The endpoint validates `from`/`to` against `^\d{4}-\d{2}-\d{2}$` and 400s on
 * anything longer, but every other timestamp in this system is a full ISO
 * string — including the ones a caller would naturally copy out of
 * `session list --json` to bound a query. Truncating at the `T` here means
 * both spellings work and neither produces a 400 the caller has to decode.
 *
 * Nothing else is normalised: a date that is not a date still reaches the
 * server, which has the authoritative message for it.
 */
export function toApiDate(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  const datePart = trimmed.split('T')[0]!
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    throw new Error(`${flag} expects YYYY-MM-DD (or a full ISO timestamp), got ${JSON.stringify(value)}`)
  }
  return datePart
}

/** Thousands separators only; the numbers are counts, and a compacted "1.2M"
 *  would hide the difference between 1.2M and 1.29M in a cost table. */
function num(n: number): string {
  return n.toLocaleString('en-US')
}

export function registerMetrics(program: Command): void {
  withCommonOptions(
    program
      .command('metrics')
      .description('Query token and cost metrics')
      .option(`--group-by <${GROUP_BY.join('|')}>`, 'Bucket dimension', 'day')
      .option('--from <date>', 'Start date, YYYY-MM-DD or ISO timestamp')
      .option('--to <date>', 'End date, YYYY-MM-DD or ISO timestamp')
      .option('--project <projectId>', 'Restrict to one project')
      .option('--adapter <adapter>', 'Restrict to one harness: claude|codex|opencode'),
  ).action(
    action(
      async (
        opts: CommonOpts & { groupBy: string; from?: string; to?: string; project?: string; adapter?: string },
      ) => {
        if (!(GROUP_BY as readonly string[]).includes(opts.groupBy)) {
          throw new Error(`--group-by expects one of ${GROUP_BY.join(', ')}, got ${JSON.stringify(opts.groupBy)}`)
        }
        const params = new URLSearchParams({ groupBy: opts.groupBy })
        const from = toApiDate(opts.from, '--from')
        const to = toApiDate(opts.to, '--to')
        if (from) params.set('from', from)
        if (to) params.set('to', to)
        if (opts.project) params.set('projectId', opts.project)
        if (opts.adapter) params.set('adapter', opts.adapter)

        const result = await apiRequest<MetricsQueryResult>(opts, `/api/metrics?${params.toString()}`)

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, groupBy: opts.groupBy, from: from ?? null, to: to ?? null, ...result }, null, 2) + '\n',
          )
          return
        }

        if (result.buckets.length === 0) {
          process.stdout.write(pc.dim('No metrics in range.\n'))
          return
        }
        const t = new Table({ head: [opts.groupBy, 'Sessions', 'Tokens', 'Cost', 'Avg duration'] })
        for (const b of result.buckets) {
          t.push([
            b.key,
            num(b.sessions),
            num(b.tokens),
            `$${b.cost_usd.toFixed(4)}`,
            `${(b.avg_duration_ms / 1000).toFixed(1)}s`,
          ])
        }
        t.push([
          pc.bold('TOTAL'),
          pc.bold(num(result.total.sessions)),
          pc.bold(num(result.total.tokens)),
          pc.bold(`$${result.total.cost_usd.toFixed(4)}`),
          '',
        ])
        process.stdout.write(t.toString() + '\n')
      },
    ),
  )
}
