import { createWriteStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Commander's `--flag <v>` collector for repeatable options. */
export function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value]
}

/** `--var name=value` pairs into the record the template renderer wants. */
export function parseVarAssignments(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of pairs) {
    const eq = raw.indexOf('=')
    if (eq <= 0) throw new Error(`--var expects name=value, got ${JSON.stringify(raw)}`)
    out[raw.slice(0, eq)] = raw.slice(eq + 1)
  }
  return out
}

export interface Attachment {
  name: string
  blob: Blob
}

/**
 * Load files for a multipart upload.
 *
 * Read whole rather than streamed on purpose: the API caps an upload well
 * below anything worth streaming, and `FormData` in undici needs a `Blob`
 * with a known length anyway. A missing file fails here, before any request
 * goes out, so a typo'd `--attachment` cannot spawn a session and *then*
 * error.
 */
export async function readAttachments(paths: string[]): Promise<Attachment[]> {
  const out: Attachment[] = []
  for (const p of paths) {
    try {
      await stat(p)
    } catch {
      throw new Error(`attachment not found: ${p}`)
    }
    const buf = await readFile(p)
    out.push({ name: basename(p), blob: new Blob([buf]) })
  }
  return out
}

export interface ExportResult {
  path: string
  format: 'jsonl' | 'tar.gz'
  bytes: number
  sourceUuid: string | null
}

/**
 * Stream an export response to disk and report what arrived.
 *
 * The format is the SERVER's decision, not the caller's: a claude session (or
 * a codex one with a rollout on disk) exports as raw `.jsonl`, while a
 * codex TUI-only session exports as a `.tar.gz` of its SQLite rows. There is
 * no request parameter that changes this, so `--format` is an assertion —
 * it fails the command when what came back is not what the caller planned to
 * hand to the next step, instead of writing a tarball into a file named
 * `.jsonl`.
 */
export async function writeExport(res: Response, outPath: string, expected?: string): Promise<ExportResult> {
  const contentType = res.headers.get('content-type') ?? ''
  const format: 'jsonl' | 'tar.gz' = contentType.includes('gzip') ? 'tar.gz' : 'jsonl'

  if (expected) {
    const want = expected.trim().toLowerCase().replace(/^\./, '')
    const normalised = want === 'tgz' ? 'tar.gz' : want
    if (normalised !== 'jsonl' && normalised !== 'tar.gz') {
      throw new Error(`--format expects jsonl or tar.gz, got ${JSON.stringify(expected)}`)
    }
    if (normalised !== format) {
      throw new Error(
        `server exported ${format}, not ${normalised} — the bundle format follows the session's harness and transcript, not the flag`,
      )
    }
  }

  if (!res.body) throw new Error('export response had no body')
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(outPath))
  const { size } = await stat(outPath)
  return {
    path: outPath,
    format,
    bytes: size,
    sourceUuid: res.headers.get('x-orchestron-source-uuid'),
  }
}

/** Extension-based guess used only for the human line on import. */
export function bundleKind(file: string): 'jsonl' | 'tar.gz' | 'unknown' {
  if (file.endsWith('.tar.gz') || file.endsWith('.tgz')) return 'tar.gz'
  if (extname(file) === '.jsonl') return 'jsonl'
  return 'unknown'
}
