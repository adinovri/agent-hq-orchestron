import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('../../src/adapters/tmux.js', () => ({
  newSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue('❯'),
  setBuffer: vi.fn().mockResolvedValue(undefined),
  pasteBuffer: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(undefined),
}))

import * as tmuxMock from '../../src/adapters/tmux.js'
import {
  ClaudeAdapter,
  buildHeadlessArgv,
  buildClaudeEnv,
  mangleCwd,
  claudeTranscriptPathFromSlug,
  resolveClaudeTranscriptPath,
} from '../../src/adapters/claude.js'
import { makeStub, withPath, type Stub } from './headless-stub.js'

const baseSpawnConfig = {
  projectId: 'proj-1',
  agentType: 'claude' as const,
  initialPrompt: 'do the thing',
  workspace: '/tmp',
}

describe('buildHeadlessArgv', () => {
  const newMode = { type: 'new' as const, uuid: '11111111-2222-3333-4444-555555555555' }

  it('uses --print with stream-json and --verbose', () => {
    const argv = buildHeadlessArgv({ prompt: 'hi', sessionMode: newMode })
    expect(argv[0]).toBe('claude')
    expect(argv).toContain('-p')
    expect(argv).toContain('--output-format')
    expect(argv).toContain('stream-json')
    // --verbose is not decoration: stream-json under -p is rejected without it.
    expect(argv).toContain('--verbose')
  })

  it('pre-assigns the session id on a new run so the transcript path is known', () => {
    const argv = buildHeadlessArgv({ prompt: 'hi', sessionMode: newMode })
    expect(argv).toContain('--session-id')
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(newMode.uuid)
    expect(argv).not.toContain('--resume')
  })

  it('resumes by uuid instead of assigning one', () => {
    const argv = buildHeadlessArgv({ prompt: 'hi', sessionMode: { type: 'resume', uuid: 'abc-123' } })
    expect(argv).toContain('--resume')
    expect(argv[argv.indexOf('--resume') + 1]).toBe('abc-123')
    expect(argv).not.toContain('--session-id')
  })

  it('puts the prompt last, behind --, so a leading dash is not read as a flag', () => {
    const argv = buildHeadlessArgv({ prompt: '--not-a-flag please', sessionMode: newMode })
    expect(argv[argv.length - 1]).toBe('--not-a-flag please')
    expect(argv[argv.length - 2]).toBe('--')
  })

  it('withholds wait_for_idle from the MCP allowlist but keeps the other nine', () => {
    const argv = buildHeadlessArgv({ prompt: 'hi', sessionMode: newMode })
    const allowed = argv[argv.indexOf('--allowedTools') + 1]!.split(',')
    // It blocks until a child goes idle; a one-shot run has no turn boundary
    // to release it, so the whole invocation would hang.
    expect(allowed).not.toContain('mcp__orchestron__wait_for_idle')
    expect(allowed).toContain('mcp__orchestron__spawn_session')
    expect(allowed).toContain('mcp__orchestron__note_set')
    expect(allowed).toHaveLength(9)
  })

  it('passes model, effort and mcp config through when given', () => {
    const argv = buildHeadlessArgv({
      prompt: 'hi',
      model: 'claude-opus-5',
      effort: 'high',
      mcpConfigPath: '/tmp/mcp.json',
      sessionMode: newMode,
    })
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-opus-5')
    expect(argv[argv.indexOf('--effort') + 1]).toBe('high')
    expect(argv[argv.indexOf('--mcp-config') + 1]).toBe('/tmp/mcp.json')
  })

  it('omits model, effort and mcp config when not given', () => {
    const argv = buildHeadlessArgv({ prompt: 'hi', sessionMode: newMode })
    expect(argv).not.toContain('--model')
    expect(argv).not.toContain('--effort')
    expect(argv).not.toContain('--mcp-config')
  })
})

describe('buildClaudeEnv', () => {
  it('returns an override for a non-default config dir', () => {
    expect(buildClaudeEnv('/home/x/ClaudeConfigs/alice')).toEqual({
      CLAUDE_CONFIG_DIR: '/home/x/ClaudeConfigs/alice',
    })
  })

  it('leaves the env inherited when the dir resolves to the harness default', () => {
    // Setting CLAUDE_CONFIG_DIR=~/.claude explicitly selects a different
    // (hashed) keychain entry than a bare `claude`, and the child re-prompts
    // for OAuth. Inheriting matches the interactive shell.
    expect(buildClaudeEnv(path.join(os.homedir(), '.claude'))).toBeUndefined()
    expect(buildClaudeEnv('~/.claude')).toBeUndefined()
    expect(buildClaudeEnv(undefined)).toBeUndefined()
  })
})

describe('transcript path helpers', () => {
  it('mangles a workspace path by replacing slashes with dashes', () => {
    expect(mangleCwd('/home/me/Works/repo')).toBe('-home-me-Works-repo')
  })

  it('rebuilds a transcript path from configDir + slug + uuid', () => {
    expect(claudeTranscriptPathFromSlug('/cfg', '-a-b', 'uuid-1')).toBe('/cfg/projects/-a-b/uuid-1.jsonl')
  })

  it('prefers the recorded jsonlPath when the file is there', () => {
    const exists = (p: string) => p === '/recorded.jsonl'
    expect(resolveClaudeTranscriptPath(
      { jsonlPath: '/recorded.jsonl', configDir: '/cfg', cwdSlug: '-a-b', claudeSessionUuid: 'u' },
      exists,
    )).toBe('/recorded.jsonl')
  })

  it('falls back to the rebuilt path when the recorded one is gone', () => {
    const exists = (p: string) => p === '/cfg/projects/-a-b/u.jsonl'
    expect(resolveClaudeTranscriptPath(
      { jsonlPath: '/stale.jsonl', configDir: '/cfg', cwdSlug: '-a-b', claudeSessionUuid: 'u' },
      exists,
    )).toBe('/cfg/projects/-a-b/u.jsonl')
  })

  it('falls back to the rebuilt path when jsonlPath was never recorded', () => {
    const exists = (p: string) => p === '/cfg/projects/-a-b/u.jsonl'
    expect(resolveClaudeTranscriptPath(
      { jsonlPath: '', configDir: '/cfg', cwdSlug: '-a-b', claudeSessionUuid: 'u' },
      exists,
    )).toBe('/cfg/projects/-a-b/u.jsonl')
  })

  it('returns the recorded path unchanged when nothing can be derived', () => {
    expect(resolveClaudeTranscriptPath({ jsonlPath: '/only.jsonl' }, () => false)).toBe('/only.jsonl')
  })
})

describe('ClaudeAdapter — useTmux routing', () => {
  beforeEach(() => vi.clearAllMocks())

  it('spawns into tmux when useTmux is absent', async () => {
    // The defensive default: a record or payload predating the toggle must
    // stay a tmux session, never silently become headless.
    const handle = await new ClaudeAdapter().spawn(baseSpawnConfig)
    expect(tmuxMock.newSession).toHaveBeenCalledTimes(1)
    expect(handle.headless).toBeFalsy()
  })

  it('spawns into tmux when useTmux is explicitly true', async () => {
    const handle = await new ClaudeAdapter().spawn({ ...baseSpawnConfig, useTmux: true })
    expect(tmuxMock.newSession).toHaveBeenCalledTimes(1)
    expect(handle.headless).toBeFalsy()
  })
})

describe('ClaudeAdapter — headless run', () => {
  let stub: Stub
  let restorePath: () => void
  let workspace: string

  const RESULT_LINE = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'all done',
    session_id: 'stream-reported-id',
    total_cost_usd: 0.0421,
    usage: {
      input_tokens: 12,
      output_tokens: 34,
      cache_read_input_tokens: 56,
      cache_creation_input_tokens: 78,
    },
  })

  beforeEach(() => {
    vi.clearAllMocks()
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestron-ws-'))
  })

  afterEach(() => {
    restorePath?.()
    stub?.cleanup()
    fs.rmSync(workspace, { recursive: true, force: true })
  })

  function startStub(opts: Parameters<typeof makeStub>[0]) {
    stub = makeStub(opts)
    restorePath = withPath(stub.binDir)
  }

  it('runs the child with the headless argv and reports the exit result', async () => {
    startStub({
      name: 'claude',
      stdout: `{"type":"system","subtype":"init"}\n${RESULT_LINE}`,
      exitCode: 0,
      captureEnv: ['CLAUDE_CONFIG_DIR'],
    })

    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn({ ...baseSpawnConfig, workspace, useTmux: false })

    expect(handle.headless).toBe(true)
    expect(tmuxMock.newSession).not.toHaveBeenCalled()

    const result = await adapter.awaitHeadlessExit!(handle)
    expect(result.exitCode).toBe(0)
    expect(result.finalResponse).toBe('all done')
    expect(result.costUsd).toBeCloseTo(0.0421)
    expect(result.tokenUsage).toEqual({ input: 12, output: 34, cacheRead: 56, cacheCreation: 78 })
    expect(result.stderr).toBeUndefined()

    const argv = stub.readArgv()
    expect(argv).toContain('-p')
    expect(argv[argv.length - 1]).toBe('do the thing')
    expect(stub.readCwd()).toBe(fs.realpathSync(workspace))
  })

  it('pre-assigns the uuid so jsonlPath is known before the child writes anything', async () => {
    startStub({ name: 'claude', stdout: RESULT_LINE, exitCode: 0 })
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn({
      ...baseSpawnConfig, workspace, useTmux: false, configDir: '/tmp/cfgdir',
    })
    await adapter.awaitHeadlessExit!(handle)

    expect(handle.claudeUuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(handle.jsonlPath).toBe(
      path.join('/tmp/cfgdir', 'projects', mangleCwd(workspace), `${handle.claudeUuid}.jsonl`),
    )
    // Same id in argv as on the handle — the two must not diverge or the
    // transcript path points at a file nothing writes.
    const argv = stub.readArgv()
    expect(argv[argv.indexOf('--session-id') + 1]).toBe(handle.claudeUuid)
  })

  it('passes CLAUDE_CONFIG_DIR to the child for a non-default dir', async () => {
    startStub({ name: 'claude', stdout: RESULT_LINE, exitCode: 0, captureEnv: ['CLAUDE_CONFIG_DIR'] })
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn({
      ...baseSpawnConfig, workspace, useTmux: false, configDir: '/tmp/cfgdir',
    })
    await adapter.awaitHeadlessExit!(handle)
    expect(stub.readEnv('CLAUDE_CONFIG_DIR')).toBe('/tmp/cfgdir')
  })

  it('captures stderr and the non-zero code when the child fails', async () => {
    startStub({ name: 'claude', stderr: 'Invalid API key', exitCode: 1 })
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn({ ...baseSpawnConfig, workspace, useTmux: false })
    const result = await adapter.awaitHeadlessExit!(handle)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('Invalid API key')
  })

  it('reports a spawn failure rather than hanging when the binary is missing', async () => {
    // No stub on PATH — 'error' fires instead of 'close', and the promise
    // must still settle or completeHeadlessSpawn waits forever.
    restorePath = withPath(fs.mkdtempSync(path.join(os.tmpdir(), 'orchestron-empty-')))
    const emptyPath = process.env['PATH']!.split(':')[0]!
    process.env['PATH'] = emptyPath
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn({
      ...baseSpawnConfig, workspace, useTmux: false, model: 'x',
    })
    const result = await adapter.awaitHeadlessExit!(handle)
    expect(result.exitCode).toBeNull()
    expect(result.stderr).toBeTruthy()
    fs.rmSync(emptyPath, { recursive: true, force: true })
  })

  it('resolves the same exit result no matter how late it is awaited', async () => {
    // The promise is built at spawn, not on demand — awaiting after the child
    // is long gone must still yield the real code, not a null placeholder.
    startStub({ name: 'claude', stdout: RESULT_LINE, exitCode: 0 })
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn({ ...baseSpawnConfig, workspace, useTmux: false })
    await new Promise((r) => setTimeout(r, 600))
    const result = await adapter.awaitHeadlessExit!(handle)
    expect(result.exitCode).toBe(0)
    expect(result.finalResponse).toBe('all done')
  })

  it('parses a final result line that arrives without a trailing newline', async () => {
    startStub({ name: 'claude', stdout: RESULT_LINE, exitCode: 0 })
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn({ ...baseSpawnConfig, workspace, useTmux: false })
    const result = await adapter.awaitHeadlessExit!(handle)
    expect(result.finalResponse).toBe('all done')
  })

  it('kill terminates the child instead of reaching for tmux', async () => {
    startStub({ name: 'claude', stdout: RESULT_LINE, exitCode: 0 })
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn({ ...baseSpawnConfig, workspace, useTmux: false })
    await adapter.kill(handle)
    expect(tmuxMock.killSession).not.toHaveBeenCalled()
  })

  it('waitTuiReady is a no-op and sendPrompt refuses to paste into a headless run', async () => {
    startStub({ name: 'claude', stdout: RESULT_LINE, exitCode: 0 })
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn({ ...baseSpawnConfig, workspace, useTmux: false })
    await expect(adapter.waitTuiReady(handle, 1)).resolves.toBeUndefined()
    await expect(adapter.sendPrompt(handle, 'again')).rejects.toThrow(/prompt in argv|resume/i)
    await adapter.awaitHeadlessExit!(handle)
  })

  it('returns a null exit code for an unknown handle', async () => {
    const adapter = new ClaudeAdapter()
    const result = await adapter.awaitHeadlessExit!({
      tmuxName: 'headless-nope', claudeUuid: 'x', jsonlPath: '', headless: true,
    })
    expect(result.exitCode).toBeNull()
  })
})
