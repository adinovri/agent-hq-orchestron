import { existsSync, readFileSync } from 'node:fs'
import { resolveConfigPath, LEGACY_TOKEN_KEY } from '@agent-hq-orchestron/shared'

/**
 * Flags every API-touching command carries, and the shape the action
 * handlers receive them in.
 *
 * `url` and `token` are deliberately NOT given Commander defaults. A
 * Commander default is indistinguishable from a value the user typed, which
 * is what left the CLI pointing at three different ports at once before this
 * batch: `session`/`project` defaulted to :8080, `schedule` to :4000, and the
 * server this repo actually ships binds :8090 by config. Leaving them absent
 * lets `resolveApiBase` fall through to the same config file the API reads.
 */
export interface CommonOpts {
  url?: string
  /** Deprecated spelling kept so existing `schedule --host` scripts still run. */
  host?: string
  token?: string
  json?: boolean
}

/** Raw parse of ~/.orchestron/config.json (or whatever ORCHESTRON_CONFIG /
 *  ORCHESTRON_DATA_DIR point at). Never throws — a missing or malformed
 *  config just means "no hints available", which the caller handles with its
 *  own fallbacks. */
export function readRawConfig(): Record<string, unknown> {
  try {
    const p = resolveConfigPath()
    if (!existsSync(p)) return {}
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** `http://127.0.0.1:8080` — the value the shared ConfigSchema defaults to
 *  when the file says nothing. Matches what `session list` used before this
 *  batch, so a host with no config behaves exactly as it always did. */
export const FALLBACK_BASE = 'http://127.0.0.1:8080'

/**
 * Where the API lives, in precedence order:
 *
 *   1. `--url` (or the deprecated `--host`)
 *   2. `$ORCHESTRON_URL`
 *   3. `bindHost` + `port` from config.json — the same file the API binds from
 *   4. {@link FALLBACK_BASE}
 *
 * Trailing slashes are stripped so callers can concatenate `/api/...` without
 * producing a double slash (which Fastify 404s on).
 */
export function resolveApiBase(opts: CommonOpts = {}, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = opts.url ?? opts.host ?? env['ORCHESTRON_URL']
  if (explicit) return stripSlash(explicit)

  const cfg = readRawConfig()
  const host = typeof cfg['bindHost'] === 'string' && cfg['bindHost'] ? (cfg['bindHost'] as string) : null
  const port = typeof cfg['port'] === 'number' ? (cfg['port'] as number) : null
  if (host || port) {
    return stripSlash(`http://${host ?? '127.0.0.1'}:${port ?? 8080}`)
  }
  return FALLBACK_BASE
}

function stripSlash(u: string): string {
  return u.replace(/\/+$/, '')
}

/**
 * The bearer, in precedence order: `--token`, `$ORCHESTRON_TOKEN`, the
 * config's `remoteToken`, then the legacy `token` key.
 *
 * The legacy key is read but never written — see B6-F1, where `token rotate`
 * wrote the key nobody reads. Reading it here means a CLI pointed at a config
 * that predates the rename still authenticates.
 */
export function resolveToken(opts: CommonOpts = {}, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (opts.token) return opts.token
  const fromEnv = env['ORCHESTRON_TOKEN']
  if (fromEnv) return fromEnv
  const cfg = readRawConfig()
  const remote = cfg['remoteToken']
  if (typeof remote === 'string' && remote.length > 0) return remote
  const legacy = cfg[LEGACY_TOKEN_KEY]
  if (typeof legacy === 'string' && legacy.length > 0) return legacy
  return undefined
}

/** A non-2xx response, carrying enough to render both the human line and the
 *  `{ok:false}` JSON envelope without a second round of guessing. */
export class ApiError extends Error {
  readonly status: number
  readonly body: string
  constructor(status: number, body: string, url: string) {
    super(`HTTP ${status}${body ? `: ${extractMessage(body)}` : ''} (${url})`)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

/** Fastify error bodies are `{"error": ...}`, where the value is a string for
 *  hand-written replies and a zod `flatten()` object for schema rejections.
 *  Render both as one line rather than dumping JSON at the operator. */
export function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown }
    const err = parsed.error ?? parsed.message
    if (typeof err === 'string') return err
    if (err && typeof err === 'object') return JSON.stringify(err)
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return body.slice(0, 400)
}

export interface RequestInitLite {
  method?: string
  /** Serialised as JSON with the matching content-type. Omit for GET/DELETE. */
  body?: unknown
  /** Pre-built body (FormData, string) — used verbatim, no content-type added. */
  rawBody?: RequestInit['body']
  headers?: Record<string, string>
  /** Return the raw Response instead of parsing. For streaming downloads. */
  raw?: boolean
}

/**
 * One fetch wrapper for every command. Adds the bearer, serialises JSON,
 * turns a non-2xx into an {@link ApiError}, and tolerates the 204/empty
 * bodies that DELETE and a few POSTs return.
 */
export async function apiRequest<T>(
  opts: CommonOpts,
  path: string,
  init: RequestInitLite = {},
): Promise<T> {
  const url = `${resolveApiBase(opts)}${path}`
  const token = resolveToken(opts)
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  if (token) headers['Authorization'] = `Bearer ${token}`

  let body: RequestInit['body']
  if (init.rawBody !== undefined) {
    body = init.rawBody
  } else if (init.body !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
    body = JSON.stringify(init.body)
  }

  const res = await fetch(url, { method: init.method ?? 'GET', headers, body })
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ''), url)
  if (init.raw) return res as unknown as T

  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as unknown as T
  }
}

/** Like {@link apiRequest} but hands back the live Response so the caller can
 *  stream it to disk and read the response headers (export uses both). */
export async function apiRaw(opts: CommonOpts, path: string, init: RequestInitLite = {}): Promise<Response> {
  return apiRequest<Response>(opts, path, { ...init, raw: true })
}
