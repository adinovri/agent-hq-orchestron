import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import writeFileAtomic from 'write-file-atomic'
import lockfile from 'proper-lockfile'

const FILE_MODE = 0o600

async function fsyncDir(dirPath: string): Promise<void> {
  const fd = await fsPromises.open(dirPath, 'r')
  try {
    await fd.sync()
  } finally {
    await fd.close()
  }
}

export async function writeJson<T>(filePath: string, value: T): Promise<void> {
  const dir = path.dirname(filePath)
  await fsPromises.mkdir(dir, { recursive: true })

  const bakPath = `${filePath}.bak`
  const json = JSON.stringify(value, null, 2)

  // Save backup of existing file before overwriting
  if (fs.existsSync(filePath)) {
    await fsPromises.copyFile(filePath, bakPath)
  }

  // Atomic write: tmp → fsync → rename
  await writeFileAtomic(filePath, json, { mode: FILE_MODE })

  await fsyncDir(dir)
}

export async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  // Try main file, then .bak recovery
  for (const tryPath of [filePath, `${filePath}.bak`]) {
    if (!fs.existsSync(tryPath)) continue
    try {
      const raw = await fsPromises.readFile(tryPath, 'utf8')
      return JSON.parse(raw) as T
    } catch {
      // corrupted — try next
    }
  }
  return fallback
}

export async function appendJsonl(filePath: string, event: unknown): Promise<void> {
  const dir = path.dirname(filePath)
  await fsPromises.mkdir(dir, { recursive: true })

  const line = JSON.stringify(event) + '\n'
  await fsPromises.appendFile(filePath, line, { mode: FILE_MODE })
}

export async function readJsonlFrom(filePath: string, offset: number): Promise<{ lines: unknown[]; newOffset: number }> {
  if (!fs.existsSync(filePath)) {
    return { lines: [], newOffset: offset }
  }

  const stats = await fsPromises.stat(filePath)
  if (stats.size <= offset) {
    return { lines: [], newOffset: offset }
  }

  const stream = fs.createReadStream(filePath, { start: offset, encoding: 'utf8' })
  let buffer = ''

  await new Promise<void>((resolve, reject) => {
    stream.on('data', (chunk) => { buffer += chunk })
    stream.on('end', resolve)
    stream.on('error', reject)
  })

  const lines: unknown[] = []
  for (const raw of buffer.split('\n')) {
    if (!raw.trim()) continue
    try {
      lines.push(JSON.parse(raw))
    } catch {
      // skip malformed lines
    }
  }

  return { lines, newOffset: stats.size }
}

export async function listDir(dirPath: string): Promise<string[]> {
  try {
    const entries = await fsPromises.readdir(dirPath)
    return entries.filter((name) => !name.startsWith('.') && !name.endsWith('.bak'))
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

export async function withLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const dir = path.dirname(filePath)
  await fsPromises.mkdir(dir, { recursive: true })

  // proper-lockfile requires the file to exist
  if (!fs.existsSync(filePath)) {
    await fsPromises.writeFile(filePath, '{}', { mode: FILE_MODE })
  }

  let release: (() => Promise<void>) | null = null
  try {
    release = await lockfile.lock(filePath, { retries: 5, stale: 10000 })
    return await fn()
  } finally {
    if (release) await release()
  }
}
