import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { readJsonlFrom } from '@agent-hq-orchestron/file-store'

export interface TailerEvent {
  type: string
  sessionUuid: string
  event: unknown
}

const OFFSET_DEBOUNCE_MS = 50

export class TranscriptTailer extends EventEmitter {
  private readonly offsetPath: string
  private offset = 0
  private watcher: fs.FSWatcher | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(
    private readonly sessionUuid: string,
    private readonly jsonlPath: string,
    private readonly dataDir: string,
    startOffset = 0,
  ) {
    super()
    this.offset = startOffset
    this.offsetPath = path.join(dataDir, 'sessions', `${sessionUuid}.offset`)
  }

  async start(): Promise<void> {
    // Restore persisted offset if available and no explicit start given
    if (this.offset === 0) {
      try {
        const raw = await fsPromises.readFile(this.offsetPath, 'utf8')
        this.offset = parseInt(raw.trim(), 10) || 0
      } catch {
        // no prior offset — start from 0
      }
    }

    // Drain any existing content first
    await this.drain()

    // Watch for new content
    this.watcher = fs.watch(path.dirname(this.jsonlPath), { persistent: false }, async (event, filename) => {
      if (this.closed) return
      if (filename && !this.jsonlPath.endsWith(filename)) return
      this.scheduleDrain()
    })

    this.watcher.on('error', () => this.close())
  }

  private scheduleDrain() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.drain().catch(() => {}), OFFSET_DEBOUNCE_MS)
  }

  private async drain(): Promise<void> {
    const { lines, newOffset } = await readJsonlFrom(this.jsonlPath, this.offset)

    for (const line of lines) {
      if (this.closed) break
      this.emit('event', { type: 'transcript', sessionUuid: this.sessionUuid, event: line } satisfies TailerEvent)
    }

    if (newOffset !== this.offset) {
      this.offset = newOffset
      await this.persistOffset()
    }
  }

  private async persistOffset(): Promise<void> {
    const dir = path.dirname(this.offsetPath)
    await fsPromises.mkdir(dir, { recursive: true })
    await fsPromises.writeFile(this.offsetPath, String(this.offset), 'utf8')
  }

  close(): void {
    this.closed = true
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }
}
