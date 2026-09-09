import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Fastify from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import Database from 'better-sqlite3'
import { sessionsPlugin } from '../../src/routes/sessions.js'
import { SessionManager } from '../../src/domain/session-manager.js'
import { AdapterRegistry } from '../../src/adapters/registry.js'
import { ProjectRegistry } from '../../src/domain/project-registry.js'
import { DelegationTracker } from '../../src/domain/delegation-tracker.js'
import { HookRunner } from '../../src/domain/hook-runner.js'
import { TemplateResolver } from '../../src/domain/template-resolver.js'
import { HEADLESS_COERCED_REASON } from '@agent-hq-orchestron/shared'
import type { AgentAdapter, AgentType, TmuxHandle } from '@agent-hq-orchestron/shared'

/**
 * `useTmux` on POST /api/sessions/import.
 *
 * The tri-state here is against the BUNDLE, not a stored record: absent
 * means "restore the mode the bundle recorded", and only a `.tar.gz` carries
 * that. A raw `.jsonl` is the transcript and nothing else, so absent falls
 * through to tmux — the distinction the suite exists to pin, because both
 * formats land on the same adopt() call.
 */

let tmpDir: string
let configDir: string
let workspace: string

function makeAdapter(name: AgentType): AgentAdapter {
  let n = 0
  return {
    name,
    spawn: vi.fn(async (cfg) => ({
      tmuxName: `s${++n}`, claudeUuid: 'spawned', jsonlPath: '', headless: cfg.useTmux === false,
    } as TmuxHandle)),
    resume: vi.fn(async (uuid, cfg) => ({
      tmuxName: `r${++n}`, claudeUuid: uuid, jsonlPath: '', headless: cfg.useTmux === false,
    } as TmuxHandle)),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitTuiReady: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    awaitHeadlessExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
  }
}

interface Harness {
  app: ReturnType<typeof Fastify>
  projectId: string
  adapter: AgentAdapter
}

async function makeApp(agentType: AgentType = 'claude', enableHeadlessMode = true): Promise<Harness> {
  const adapter = makeAdapter(agentType)
  const adapterRegistry = new AdapterRegistry()
  adapterRegistry.register(agentType, adapter)
  const manager = new SessionManager(
    { dataDir: tmpDir, maxConcurrent: 10, enableHeadlessMode }, adapterRegistry,
  )
  manager.setProjectResolver(async () => ({ path: workspace }))
  const registry = new ProjectRegistry(tmpDir)

  const app = Fastify({ logger: false })
  await app.register(sessionsPlugin(
    manager,
    new HookRunner({ dataDir: tmpDir }),
    new TemplateResolver(tmpDir),
    new DelegationTracker(tmpDir),
    registry,
    { enableHeadlessMode },
  ))
  await app.ready()

  const envKey = agentType === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
  const project = await registry.create({
    name: 'Import', path: workspace, agentType,
    agentConfig: { env: { [envKey]: configDir } },
  })
  return { app, projectId: project.id, adapter }
}

/** Hand-rolled multipart body — fastify's inject takes the raw buffer. */
function multipart(
  fields: Record<string, string>,
  file: { name: string; type: string; buf: Buffer },
): { payload: Buffer; headers: Record<string, string> } {
  const b = `----orchestron${Math.random().toString(16).slice(2)}`
  const chunks: Buffer[] = []
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  chunks.push(Buffer.from(
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
    `Content-Type: ${file.type}\r\n\r\n`,
  ))
  chunks.push(file.buf, Buffer.from(`\r\n--${b}--\r\n`))
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${b}` },
  }
}

/** A minimal claude transcript the importer can detect and adopt. */
function claudeBundle(uuid: string): Buffer {
  return Buffer.from(JSON.stringify({
    type: 'user', sessionId: uuid, message: { role: 'user', content: 'imported prompt' },
  }) + '\n')
}

async function importClaude(h: Harness, fields: Record<string, string> = {}) {
  const uuid = crypto.randomUUID()
  const mp = multipart(
    { projectId: h.projectId, ...fields },
    { name: `orchestron-claude-${uuid}.jsonl`, type: 'application/x-ndjson', buf: claudeBundle(uuid) },
  )
  return h.app.inject({ method: 'POST', url: '/api/sessions/import', ...mp })
}

/**
 * A codex TUI bundle, optionally recording a mode. Mirrors what the export
 * route writes: metadata.json plus a dump.jsonl of thread rows.
 */
function codexBundle(uuid: string, useTmux?: boolean): Buffer {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bundle-'))
  try {
    const meta: Record<string, unknown> = {
      kind: 'orchestron-session-bundle', version: 1, agentType: 'codex',
      transcriptFormat: 'codex-tui-sqlite', sourceUuid: uuid,
      sourceWorkspace: workspace, exportedAt: new Date().toISOString(),
    }
    if (useTmux !== undefined) meta.useTmux = useTmux
    fs.writeFileSync(path.join(stage, 'metadata.json'), JSON.stringify(meta))
    fs.writeFileSync(path.join(stage, 'dump.jsonl'), JSON.stringify({
      kind: 'thread_item',
      data: {
        thread_id: uuid, turn_id: 't1', item_id: 'i1', rollout_ordinal: 0,
        created_at_ms: Date.now(), item_type: 'user_message',
        item_json: JSON.stringify({ type: 'userMessage', text: 'imported prompt' }),
      },
    }) + '\n')
    const tar = spawnSync('tar', ['-czf', '-', '-C', stage, 'metadata.json', 'dump.jsonl'], {
      maxBuffer: 32 * 1024 * 1024,
    })
    if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr?.toString()}`)
    return tar.stdout
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

/** The destination codex DB the import route inserts into. */
function seedCodexDb(): void {
  const db = new Database(path.join(configDir, 'thread_history_1.sqlite'))
  db.exec(`
    CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER,
      status TEXT, error_json TEXT, started_at TEXT, completed_at TEXT, duration_ms INTEGER,
      first_user_item_id TEXT, final_agent_item_id TEXT, rollout_byte_offset INTEGER,
      rollout_end_ordinal INTEGER, rollout_end_byte_offset INTEGER);
    CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT,
      rollout_ordinal INTEGER, created_at_ms INTEGER, item_json TEXT, item_type TEXT,
      updated_at_ordinal INTEGER);
    CREATE TABLE thread_history_projection_state (thread_id TEXT,
      next_rollout_byte_offset INTEGER, next_rollout_ordinal INTEGER);
  `)
  db.close()
}

async function importCodex(h: Harness, bundleUseTmux?: boolean, fields: Record<string, string> = {}) {
  const uuid = crypto.randomUUID()
  const mp = multipart(
    { projectId: h.projectId, ...fields },
    { name: `orchestron-codex-tui-${uuid}.tar.gz`, type: 'application/gzip', buf: codexBundle(uuid, bundleUseTmux) },
  )
  return h.app.inject({ method: 'POST', url: '/api/sessions/import', ...mp })
}

let harness: Harness | null = null

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-mode-'))
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-cfg-'))
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'import-ws-'))
})

afterEach(async () => {
  if (harness) await harness.app.close()
  harness = null
  for (const d of [tmpDir, configDir, workspace]) fs.rmSync(d, { recursive: true, force: true })
})

describe('POST /api/sessions/import — .jsonl, which records no mode', () => {
  it('imports into tmux when the field is absent', async () => {
    harness = await makeApp()
    const res = await importClaude(harness)
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
  })

  it('imports headless on an explicit false', async () => {
    harness = await makeApp()
    const res = await importClaude(harness, { useTmux: 'false' })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(false)
    expect(res.json().status).toBe('idle')
    expect(harness.adapter.resume).not.toHaveBeenCalled()
  })

  it('imports into tmux on an explicit true', async () => {
    harness = await makeApp()
    const res = await importClaude(harness, { useTmux: 'true' })
    expect(res.json().useTmux).toBe(true)
    expect(harness.adapter.resume).toHaveBeenCalledTimes(1)
  })

  it('still reports the source uuid alongside the mode', async () => {
    harness = await makeApp()
    const res = await importClaude(harness, { useTmux: 'false' })
    expect(res.json().importedFromUuid).toBeTruthy()
    expect(res.json().transcriptPath).toContain(configDir)
  })

  it('rejects a useTmux that is neither "true" nor "false"', async () => {
    harness = await makeApp()
    // Multipart has no types, so `Boolean('headless')` would silently be
    // true. The route refuses rather than guessing.
    const res = await importClaude(harness, { useTmux: 'headless' })
    expect(res.statusCode).toBe(400)
  })
})

describe('POST /api/sessions/import — .tar.gz, which records its mode', () => {
  it('restores the bundle mode when the field is absent', async () => {
    harness = await makeApp('codex')
    seedCodexDb()
    const res = await importCodex(harness, false)
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(false)
  })

  it('restores a tmux bundle as tmux', async () => {
    harness = await makeApp('codex')
    seedCodexDb()
    const res = await importCodex(harness, true)
    expect(res.json().useTmux).toBe(true)
  })

  it('lets an explicit field override what the bundle recorded', async () => {
    harness = await makeApp('codex')
    seedCodexDb()
    const res = await importCodex(harness, false, { useTmux: 'true' })
    expect(res.json().useTmux).toBe(true)
  })

  it('falls back to tmux for a bundle written before the field', async () => {
    harness = await makeApp('codex')
    seedCodexDb()
    const res = await importCodex(harness, undefined)
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
  })
})

describe('POST /api/sessions/import — the kill switch', () => {
  it('coerces an explicitly headless import and says so', async () => {
    harness = await makeApp('claude', false)
    const res = await importClaude(harness, { useTmux: 'false' })
    expect(res.statusCode).toBe(201)
    expect(res.json().useTmux).toBe(true)
    expect(res.json().coerced).toEqual({ useTmux: true, reason: HEADLESS_COERCED_REASON })
  })

  it('coerces a headless bundle too, since the bundle is a request like any other', async () => {
    harness = await makeApp('codex', false)
    seedCodexDb()
    const res = await importCodex(harness, false)
    expect(res.json().useTmux).toBe(true)
    expect(res.json().coerced?.reason).toBe(HEADLESS_COERCED_REASON)
  })

  it('does not call an ordinary import a coercion', async () => {
    harness = await makeApp('claude', false)
    const res = await importClaude(harness)
    expect(res.json().coerced).toBeUndefined()
  })
})

describe('GET /api/sessions/:uuid/export — the bundle carries the mode', () => {
  /** Force the export route down Branch B by emptying jsonlPath, the way a
   *  codex TUI session (SQLite only, no rollout) actually looks on disk. */
  async function seedTuiSession(h: Harness, useTmux: boolean): Promise<string> {
    const spawned = await h.app.inject({
      method: 'POST', url: '/api/sessions',
      payload: { projectId: h.projectId, prompt: 'exported', useTmux },
    })
    const id = spawned.json().id as string
    const recPath = path.join(tmpDir, 'sessions', `${id}.json`)
    const deadline = Date.now() + 3_000
    while (Date.now() < deadline) {
      const cur = await h.app.inject({ method: 'GET', url: `/api/sessions/${id}` })
      if (cur.json().status !== 'spawning') break
      await new Promise((r) => setTimeout(r, 20))
    }
    const rec = JSON.parse(fs.readFileSync(recPath, 'utf8')) as Record<string, unknown>
    rec.jsonlPath = ''
    rec.claudeSessionUuid = crypto.randomUUID()
    fs.writeFileSync(recPath, JSON.stringify(rec))

    const db = new Database(path.join(configDir, 'thread_history_1.sqlite'))
    db.prepare(
      'INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type) VALUES (?,?,?,?,?,?,?)',
    ).run(rec.claudeSessionUuid, 't1', 'i1', 0, Date.now(), '{"type":"userMessage","text":"exported"}', 'user_message')
    db.close()
    return id
  }

  /** metadata.json out of the gzipped tar the route streams back. */
  function metadataOf(body: Buffer): Record<string, unknown> {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'export-read-'))
    try {
      fs.writeFileSync(path.join(stage, 'b.tar.gz'), body)
      const untar = spawnSync('tar', ['-xzf', path.join(stage, 'b.tar.gz'), '-C', stage])
      if (untar.status !== 0) throw new Error(`untar failed: ${untar.stderr?.toString()}`)
      return JSON.parse(fs.readFileSync(path.join(stage, 'metadata.json'), 'utf8')) as Record<string, unknown>
    } finally {
      fs.rmSync(stage, { recursive: true, force: true })
    }
  }

  it('records a headless session as headless', async () => {
    harness = await makeApp('codex')
    seedCodexDb()
    const id = await seedTuiSession(harness, false)
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${id}/export` })
    expect(res.statusCode).toBe(200)
    expect(metadataOf(res.rawPayload).useTmux).toBe(false)
  })

  it('records a tmux session as tmux', async () => {
    harness = await makeApp('codex')
    seedCodexDb()
    const id = await seedTuiSession(harness, true)
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${id}/export` })
    expect(metadataOf(res.rawPayload).useTmux).toBe(true)
  })
})
