import path from 'node:path'
import { readJson, writeJson, listDir } from '@agent-hq-orchestron/file-store'
import { promises as fs } from 'node:fs'

export interface NoteEntry {
  key: string
  value: unknown
  updatedAt: string
  updatedBy?: string    // session uuid, optional (for audit trail)
  tags?: string[]
}

/**
 * Shared key-value store — any session (or the UI) can read/write notes.
 * Intended for cross-session coordination: agent A checks foo, writes
 * result to 'note:foo-check', agent B reads before deciding what to do.
 */
export class NotesStore {
  private readonly notesDir: string

  constructor(dataDir: string) {
    this.notesDir = path.join(dataDir, 'notes')
  }

  private safeKey(key: string): string {
    // Allow letters, digits, _-. and : (namespacing); reject slashes for path safety
    if (!/^[\w\-.:]{1,200}$/.test(key)) {
      throw new Error(`Invalid note key: must match [\\w\\-.:] and be 1–200 chars`)
    }
    return key.replace(/[/\\]/g, '_')
  }

  private notePath(key: string): string {
    return path.join(this.notesDir, `${this.safeKey(key)}.json`)
  }

  async get(key: string): Promise<NoteEntry | null> {
    return readJson<NoteEntry | null>(this.notePath(key), null)
  }

  async set(entry: Omit<NoteEntry, 'updatedAt'>): Promise<NoteEntry> {
    const full: NoteEntry = { ...entry, updatedAt: new Date().toISOString() }
    await fs.mkdir(this.notesDir, { recursive: true, mode: 0o700 })
    await writeJson(this.notePath(entry.key), full)
    return full
  }

  async delete(key: string): Promise<void> {
    await fs.unlink(this.notePath(key)).catch(() => { /* ignore */ })
  }

  async list(prefix?: string): Promise<NoteEntry[]> {
    const files = await listDir(this.notesDir).catch(() => [])
    const entries: NoteEntry[] = []
    await Promise.all(
      files.filter((f) => f.endsWith('.json')).map(async (f) => {
        const key = f.replace(/\.json$/, '')
        if (prefix && !key.startsWith(prefix)) return
        const e = await readJson<NoteEntry | null>(path.join(this.notesDir, f), null)
        if (e) entries.push(e)
      })
    )
    return entries.sort((a, b) => a.key.localeCompare(b.key))
  }
}
