import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sessionsPlugin } from '../../src/routes/sessions.js'
import { SessionManager } from '../../src/domain/session-manager.js'
import { AdapterRegistry } from '../../src/adapters/registry.js'
import { ProjectRegistry } from '../../src/domain/project-registry.js'
import { DelegationTracker } from '../../src/domain/delegation-tracker.js'
import { HookRunner } from '../../src/domain/hook-runner.js'
import { TemplateResolver } from '../../src/domain/template-resolver.js'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'

/**
 * GET /api/sessions/:uuid/transcript strips the structured-output plumbing,
 * and does it for headless sessions only.
 *
 * The stripping lives in the route rather than in a client because both the
 * web pane and the TUI read this endpoint — a fix in one would have left the
 * other showing raw JSON. The tmux half of these tests is the guard on the
 * other side: a tmux session never gets the schema, so its transcript must
 * come back exactly as the parser produced it.
 */

let tmpDir: string
let app: ReturnType<typeof Fastify>
let manager: SessionManager

const DOC = JSON.stringify({ summary: 'Listed what I can do.', inquiry: null })

const JSONL = [
  '{"type":"user","timestamp":"2026-09-10T06:00:00.000Z","message":{"content":"Kmu bisa ngapain aja?"}}',
  '{"type":"assistant","timestamp":"2026-09-10T06:00:05.000Z","message":{"content":[{"type":"text","text":"Gue Claude Code."}],"usage":{"input_tokens":3,"output_tokens":9}}}',
  `{"type":"assistant","timestamp":"2026-09-10T06:00:06.000Z","message":{"content":[{"type":"tool_use","name":"StructuredOutput","input":${DOC}}],"usage":{"input_tokens":3,"output_tokens":9}}}`,
  '{"type":"user","timestamp":"2026-09-10T06:00:06.200Z","message":{"content":[{"type":"tool_result","content":"Structured output provided successfully"}]}}',
].join('\n')

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-structured-test-'))
  manager = new SessionManager({ dataDir: tmpDir, maxConcurrent: 10 }, new AdapterRegistry())

  app = Fastify({ logger: false })
  await app.register(sessionsPlugin(
    manager,
    new HookRunner({ dataDir: tmpDir }),
    new TemplateResolver(tmpDir),
    new DelegationTracker(tmpDir),
    new ProjectRegistry(tmpDir),
  ))
  await app.ready()
})

afterEach(async () => {
  await app.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** Seed a session record plus its transcript on disk. The manager reads
 *  `sessions/` per call, so writing the record directly is enough. */
function seed(uuid: string, useTmux: boolean): void {
  const jsonlPath = path.join(tmpDir, `${uuid}.jsonl`)
  fs.writeFileSync(jsonlPath, JSONL, 'utf8')
  fs.mkdirSync(path.join(tmpDir, 'sessions'), { recursive: true })
  const rec: Partial<SessionMetadata> = {
    id: uuid,
    projectId: 'p1',
    agentType: 'claude',
    status: 'idle',
    workspace: os.tmpdir(),
    useTmux,
    jsonlPath,
    claudeSessionUuid: uuid,
    createdAt: '2026-09-10T06:00:00.000Z',
  }
  fs.writeFileSync(path.join(tmpDir, 'sessions', `${uuid}.json`), JSON.stringify(rec), 'utf8')
}

async function entriesOf(uuid: string) {
  const res = await app.inject({ method: 'GET', url: `/api/sessions/${uuid}/transcript` })
  expect(res.statusCode).toBe(200)
  return res.json().entries as Array<{ kind: string; toolName?: string; content: string }>
}

describe('GET /transcript — headless session', () => {
  it('returns the prose without the StructuredOutput plumbing', async () => {
    seed('11111111-1111-1111-1111-111111111111', false)
    const entries = await entriesOf('11111111-1111-1111-1111-111111111111')

    expect(entries.map((e) => e.kind)).toEqual(['user', 'assistant'])
    expect(entries[1]!.content).toBe('Gue Claude Code.')
  })

  it('leaks neither the raw document nor the canned tool result', async () => {
    seed('22222222-2222-2222-2222-222222222222', false)
    const body = JSON.stringify(await entriesOf('22222222-2222-2222-2222-222222222222'))

    expect(body).not.toContain('StructuredOutput')
    expect(body).not.toContain('inquiry')
    expect(body).not.toContain('Structured output provided successfully')
  })
})

describe('GET /transcript — tmux session is untouched', () => {
  it('renders every entry the parser produced, plumbing included', async () => {
    // Not a wish, a regression guard: normalising a tmux transcript could
    // only ever be a misfire, since tmux runs are never handed the schema.
    seed('33333333-3333-3333-3333-333333333333', true)
    const entries = await entriesOf('33333333-3333-3333-3333-333333333333')

    expect(entries.map((e) => e.kind)).toEqual(['user', 'assistant', 'tool_use', 'tool_result'])
    expect(entries[2]!.toolName).toBe('StructuredOutput')
  })
})
