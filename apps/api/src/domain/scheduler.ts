import path from 'node:path'
import { readJson, writeJson, listDir } from '@agent-hq-orchestron/file-store'
import { CronExpressionParser } from 'cron-parser'
import type { ScheduleEntry } from '@agent-hq-orchestron/shared'

// The record itself lives in shared so the web list page and the API agree on
// one shape. Re-exported here because every existing importer reaches for it
// through the scheduler module.
export type { ScheduleEntry }

export class ScheduleNotFoundError extends Error {
  constructor(id: string) {
    super(`Schedule not found: ${id}`)
    this.name = 'ScheduleNotFoundError'
  }
}

/**
 * Pull the spawned session's UUID out of a POST /api/sessions response body.
 *
 * Takes the raw text rather than calling `resp.json()` so a fire never fails
 * on a body that isn't the session record: the scheduler's job is to spawn,
 * and the UUID is a convenience for the caller (the "Run now" button wants
 * somewhere to navigate). A body we can't read means "no target", not "the
 * run broke" — hence `null` instead of a throw.
 *
 * `id` is the field name because SessionRecord.id *is* the harness UUID; see
 * the transcript-path comment in shared/types.ts.
 */
export function spawnedSessionUuid(raw: string): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { id?: unknown }
    return typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : null
  } catch {
    return null
  }
}

export class Scheduler {
  private readonly schedulesDir: string
  private readonly apiBaseUrl: string
  private readonly authToken: string | null
  private timers: Map<string, ReturnType<typeof setTimeout>> = new Map()

  constructor(dataDir: string, apiBaseUrl: string, authToken?: string | null) {
    this.schedulesDir = path.join(dataDir, 'schedules')
    this.apiBaseUrl = apiBaseUrl
    this.authToken = authToken ?? null
  }

  private schedulePath(id: string): string {
    return path.join(this.schedulesDir, `${id}.json`)
  }

  async list(): Promise<ScheduleEntry[]> {
    const files = await listDir(this.schedulesDir)
    const entries: ScheduleEntry[] = []
    await Promise.all(
      files
        .filter(f => f.endsWith('.json'))
        .map(async f => {
          const id = f.replace(/\.json$/, '')
          const entry = await readJson<ScheduleEntry | null>(this.schedulePath(id), null)
          if (entry) entries.push(entry)
        })
    )
    return entries
  }

  async get(id: string): Promise<ScheduleEntry> {
    const entry = await readJson<ScheduleEntry | null>(this.schedulePath(id), null)
    if (!entry) throw new ScheduleNotFoundError(id)
    return entry
  }

  async create(entry: ScheduleEntry): Promise<ScheduleEntry> {
    await writeJson(this.schedulePath(entry.id), entry)
    if (entry.enabled) this.scheduleTimer(entry)
    return entry
  }

  async update(id: string, patch: Partial<ScheduleEntry>): Promise<ScheduleEntry> {
    const existing = await this.get(id)
    const updated = { ...existing, ...patch, id }
    await writeJson(this.schedulePath(id), updated)
    this.clearTimer(id)
    if (updated.enabled) this.scheduleTimer(updated)
    return updated
  }

  async delete(id: string): Promise<void> {
    const entry = await this.get(id)
    this.clearTimer(entry.id)
    const { promises: fs } = await import('node:fs')
    await fs.unlink(this.schedulePath(id)).catch(() => {})
  }

  /**
   * Fire a schedule once, out of band. Returns the spawned session's UUID so
   * the caller can point the user at it, or `null` when the spawn response
   * carried no id (see `spawnedSessionUuid`) — the run still happened.
   */
  async run(id: string): Promise<string | null> {
    const entry = await this.get(id)
    return this.fireEntry(entry)
  }

  async start(): Promise<void> {
    const entries = await this.list()
    for (const entry of entries) {
      if (entry.enabled) this.scheduleTimer(entry)
    }
  }

  stop(): void {
    for (const [id] of this.timers) {
      this.clearTimer(id)
    }
  }

  /**
   * Schedule the NEXT fire via setTimeout. After firing, reschedule for the
   * following cron-computed timestamp. Uses cron-parser, which understands
   * more than this is fed: the write routes accept 5-field standard cron and
   * nothing else (see isValidCron — the `@daily` family and the 6-field
   * seconds form are rejected at the boundary), so what arrives here is
   * always `minute hour day-of-month month day-of-week`. Records written
   * before that check may still carry something wider; parse failures below
   * are handled either way.
   */
  private scheduleTimer(entry: ScheduleEntry): void {
    let nextTs: Date
    try {
      const iter = CronExpressionParser.parse(entry.cron, { currentDate: new Date() })
      nextTs = iter.next().toDate()
    } catch (err) {
      // Strip CR/LF so a schedule with a newline-bearing cron (should be
      // impossible now that the route validates via CronExpressionParser,
      // but defense-in-depth) can't forge log entries in stderr/journald.
      const safeCron = String(entry.cron).replace(/[\r\n]/g, '\\n')
      console.warn(`[Scheduler] invalid cron "${safeCron}" for schedule ${entry.id}:`, (err as Error).message)
      return
    }

    const delayMs = Math.max(0, nextTs.getTime() - Date.now())
    const timer = setTimeout(() => {
      // Fire, then reschedule for the following next-run.
      this.fireEntry(entry).catch(err =>
        console.error(`[Scheduler] error firing schedule ${entry.id}:`, err)
      )
      // Reschedule (recursively via same entry) — re-read to pick up updates.
      this.get(entry.id)
        .then((fresh) => { if (fresh.enabled) this.scheduleTimer(fresh) })
        .catch(() => { /* deleted/disabled since */ })
    }, delayMs)

    timer.unref()
    this.timers.set(entry.id, timer)

    // Persist nextRunAt for UI display (fire-and-forget, don't block)
    this.updateNextRunAt(entry.id, nextTs.toISOString()).catch(() => {})
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
  }

  private async updateNextRunAt(id: string, nextRunAt: string): Promise<void> {
    const entry = await readJson<ScheduleEntry | null>(this.schedulePath(id), null)
    if (!entry) return
    entry.nextRunAt = nextRunAt
    await writeJson(this.schedulePath(id), entry)
  }

  private async markRun(id: string): Promise<void> {
    const entry = await readJson<ScheduleEntry | null>(this.schedulePath(id), null)
    if (!entry) return
    entry.lastRunAt = new Date().toISOString()
    await writeJson(this.schedulePath(id), entry)
  }

  private async fireEntry(entry: ScheduleEntry): Promise<string | null> {
    // Overrides ride along only when the schedule actually set one. An absent
    // field must stay absent in the body: POST /api/sessions resolves each of
    // these as `body ?? project.default…`, so omitting is what makes an
    // unpinned schedule follow the project as it is *at fire time* rather than
    // as it was when the schedule was written. Sending `undefined` explicitly
    // would be equivalent here (JSON.stringify drops it) but the intent is
    // worth spelling out — and `useTmux: false` is a meaningful value, so this
    // can never collapse into a truthiness check.
    const body = {
      projectId: entry.projectId,
      ...(entry.template ? { template: entry.template, vars: entry.vars } : { prompt: entry.prompt }),
      ...(entry.model !== undefined ? { model: entry.model } : {}),
      ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
      ...(entry.useTmux !== undefined ? { useTmux: entry.useTmux } : {}),
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`

    const resp = await fetch(`${this.apiBaseUrl}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    // Read the body once, before the ok-check: the failure path wants it for
    // the error message and the success path wants the session id out of it.
    const text = await resp.text().catch(() => '')

    if (!resp.ok) {
      throw new Error(`Scheduler: POST /api/sessions returned ${resp.status} for schedule ${entry.id}: ${text.slice(0, 200)}`)
    }

    await this.markRun(entry.id)
    return spawnedSessionUuid(text)
  }
}
