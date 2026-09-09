import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  loadConfig,
  ConfigSchema,
  DEFAULT_HEADLESS_STRUCTURED_OUTPUT,
  ORCHESTRON_RESULT_SCHEMA,
  ORCHESTRON_RESULT_SCHEMA_FILENAME,
} from '@agent-hq-orchestron/shared'
import { SessionManager } from '../src/domain/session-manager.js'
import { AdapterRegistry } from '../src/adapters/registry.js'
import type { AgentAdapter, TmuxHandle, SpawnConfig } from '@agent-hq-orchestron/shared'

/**
 * `headlessStructuredOutput` decides whether a headless agent is able to
 * ask the user anything at all, so the two properties that matter are the
 * same ones `enableHeadlessMode` has: an untouched install keeps it on, and
 * a literal `false` in the config file actually survives the zod parse —
 * a `.default(true)` applied over a falsy value is the classic way for a
 * flag like this to silently never turn off.
 */

let tmpDir: string

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'structured-flag-')) })
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }) })

describe('config: headlessStructuredOutput', () => {
  it('defaults to on', () => {
    expect(DEFAULT_HEADLESS_STRUCTURED_OUTPUT).toBe(true)
    expect(ConfigSchema.parse({ dataDir: '/tmp', maxConcurrent: 4 }).headlessStructuredOutput).toBe(true)
  })

  it('survives a literal false from the config file', () => {
    const p = path.join(tmpDir, 'config.json')
    fs.writeFileSync(p, JSON.stringify({ dataDir: tmpDir, headlessStructuredOutput: false }))
    expect(loadConfig({ configPath: p, env: {} }).headlessStructuredOutput).toBe(false)
  })

  it('rejects a non-boolean', () => {
    expect(() => ConfigSchema.parse({
      dataDir: '/tmp', maxConcurrent: 4, headlessStructuredOutput: 'yes',
    })).toThrow()
  })
})

function makeAdapter() {
  const adapter: AgentAdapter & Record<string, ReturnType<typeof vi.fn>> = {
    name: 'claude',
    spawn: vi.fn(async (): Promise<TmuxHandle> => ({
      tmuxName: 'headless-x', claudeUuid: 'u', jsonlPath: '/tmp/u.jsonl', headless: true,
    })),
    resume: vi.fn(),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    waitTuiReady: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    awaitHeadlessExit: vi.fn().mockResolvedValue({ exitCode: 0 }),
  } as never
  return adapter
}

function makeManager(adapter: AgentAdapter, headlessStructuredOutput?: boolean) {
  const registry = new AdapterRegistry()
  registry.register('claude', adapter)
  return new SessionManager(
    { dataDir: tmpDir, maxConcurrent: 5, ...(headlessStructuredOutput === undefined ? {} : { headlessStructuredOutput }) },
    registry,
  )
}

const baseSpawn = {
  projectId: 'p', agentType: 'claude' as const, initialPrompt: 'hi', workspace: '/tmp/ws',
}

function spawnedWith(adapter: ReturnType<typeof makeAdapter>): SpawnConfig {
  return adapter.spawn.mock.calls.at(-1)![0] as SpawnConfig
}

describe('SessionManager: the schema path reaches the adapter', () => {
  it('writes the schema and passes its path for a headless spawn', async () => {
    // Codex's --output-schema takes a FILE, so the file has to exist by the
    // time the child launches, not merely be named.
    const adapter = makeAdapter()
    const mgr = makeManager(adapter)
    await mgr.spawn({ ...baseSpawn, useTmux: false })

    const p = spawnedWith(adapter).outputSchemaPath
    expect(p).toBe(path.join(tmpDir, ORCHESTRON_RESULT_SCHEMA_FILENAME))
    expect(fs.existsSync(p!)).toBe(true)
    expect(JSON.parse(fs.readFileSync(p!, 'utf8'))).toEqual(ORCHESTRON_RESULT_SCHEMA)
  })

  it('passes nothing for a tmux spawn', async () => {
    // Structured output is a headless mechanism — a tmux agent asks through
    // its own selector modal, and constraining its final response would
    // change what the user reads in the pane for no benefit.
    const adapter = makeAdapter()
    adapter.spawn.mockResolvedValue({ tmuxName: 't', claudeUuid: 'u', jsonlPath: '/tmp/u.jsonl' })
    const mgr = makeManager(adapter)
    await mgr.spawn(baseSpawn)
    expect(spawnedWith(adapter).outputSchemaPath).toBeUndefined()
  })

  it('passes nothing when the flag is off, and writes no file', async () => {
    const adapter = makeAdapter()
    const mgr = makeManager(adapter, false)
    await mgr.spawn({ ...baseSpawn, useTmux: false })
    expect(spawnedWith(adapter).outputSchemaPath).toBeUndefined()
    expect(fs.existsSync(path.join(tmpDir, ORCHESTRON_RESULT_SCHEMA_FILENAME))).toBe(false)
  })
})
