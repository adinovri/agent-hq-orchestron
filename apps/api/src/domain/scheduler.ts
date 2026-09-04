import path from 'node:path'
import { readJson, writeJson, listDir } from '@agent-hq-orchestron/file-store'

export interface ScheduleEntry {
  id: string
  cron: string
  projectId: string
  template?: string
  prompt?: string
  vars?: Record<string, string>
  enabled: boolean
  createdAt: string
}

export class ScheduleNotFoundError extends Error {
  constructor(id: string) {
    super(`Schedule not found: ${id}`)
    this.name = 'ScheduleNotFoundError'
  }
}

export class Scheduler {
  private readonly schedulesDir: string
  private readonly apiBaseUrl: string
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map()

  constructor(dataDir: string, apiBaseUrl: string) {
    this.schedulesDir = path.join(dataDir, 'schedules')
    this.apiBaseUrl = apiBaseUrl
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

  async run(id: string): Promise<void> {
    const entry = await this.get(id)
    await this.fireEntry(entry)
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

  private scheduleTimer(entry: ScheduleEntry): void {
    // Minimal cron: parse simple interval patterns or use setInterval for hourly/daily
    // For full cron expressions we'd use node-cron; this is a lightweight fallback
    const intervalMs = this.cronToIntervalMs(entry.cron)
    if (intervalMs === null) return // unsupported pattern — skip

    const timer = setInterval(() => {
      this.fireEntry(entry).catch(err =>
        console.error(`[Scheduler] error firing schedule ${entry.id}:`, err)
      )
    }, intervalMs)

    timer.unref()
    this.timers.set(entry.id, timer)
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id)
    if (timer) {
      clearInterval(timer)
      this.timers.delete(id)
    }
  }

  private cronToIntervalMs(cron: string): number | null {
    // Support common shorthand patterns
    const patterns: Record<string, number> = {
      '@hourly': 60 * 60 * 1000,
      '@daily': 24 * 60 * 60 * 1000,
      '@weekly': 7 * 24 * 60 * 60 * 1000,
      '0 * * * *': 60 * 60 * 1000,
      '0 0 * * *': 24 * 60 * 60 * 1000,
    }
    return patterns[cron] ?? null
  }

  private async fireEntry(entry: ScheduleEntry): Promise<void> {
    const body = {
      projectId: entry.projectId,
      ...(entry.template ? { template: entry.template, vars: entry.vars } : { prompt: entry.prompt }),
    }

    const resp = await fetch(`${this.apiBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!resp.ok) {
      throw new Error(`Scheduler: POST /api/sessions returned ${resp.status} for schedule ${entry.id}`)
    }
  }
}
