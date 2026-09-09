import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

vi.mock('../../src/adapters/tmux.js', () => ({
  newSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
  setBuffer: vi.fn().mockResolvedValue(undefined),
  pasteBuffer: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(undefined),
}))

import * as tmuxMock from '../../src/adapters/tmux.js'
import { CodexAdapter, buildCodexExecArgv, buildCodexEnv } from '../../src/adapters/codex.js'
import { makeStub, withPath, type Stub } from './headless-stub.js'

const baseSpawnConfig = {
  projectId: 'proj-1',
  agentType: 'codex' as const,
  initialPrompt: 'do the thing',
  workspace: '/tmp',
}

describe('buildCodexExecArgv', () => {
  it('uses the exec subcommand with --json and --skip-git-repo-check', () => {
    const argv = buildCodexExecArgv({ prompt: 'hi' })
    expect(argv[0]).toBe('codex')
    expect(argv[1]).toBe('exec')
    // --json is the only channel that carries thread_id.
    expect(argv).toContain('--json')
    // Workspaces are not always git repos and exec has no trust prompt to dismiss.
    expect(argv).toContain('--skip-git-repo-check')
    expect(argv).toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('resumes via the `exec resume <thread_id>` subcommand, not a flag', () => {
    // Codex terminology and shape both differ from Claude's --resume flag.
    const argv = buildCodexExecArgv({ prompt: 'more', sessionMode: { type: 'resume', threadId: 'tid-9' } })
    expect(argv.slice(0, 4)).toEqual(['codex', 'exec', 'resume', 'tid-9'])
    expect(argv).not.toContain('--resume')
  })

  it('omits the resume subcommand for a new run', () => {
    const argv = buildCodexExecArgv({ prompt: 'hi', sessionMode: { type: 'new' } })
    expect(argv).not.toContain('resume')
  })

  it('puts the prompt last, behind --', () => {
    const argv = buildCodexExecArgv({ prompt: '--not-a-flag please' })
    expect(argv[argv.length - 1]).toBe('--not-a-flag please')
    expect(argv[argv.length - 2]).toBe('--')
  })

  it('maps effort onto the config override — codex has no --effort flag', () => {
    const argv = buildCodexExecArgv({ prompt: 'hi', effort: 'high' })
    expect(argv).not.toContain('--effort')
    expect(argv[argv.indexOf('-c') + 1]).toBe('model_reasoning_effort="high"')
  })

  it('passes model and inline mcp overrides through', () => {
    const argv = buildCodexExecArgv({
      prompt: 'hi',
      model: 'gpt-6-astra',
      mcpConfigInline: ['-c', 'mcp_servers.orchestron.command="node"'],
    })
    expect(argv[argv.indexOf('--model') + 1]).toBe('gpt-6-astra')
    expect(argv).toContain('mcp_servers.orchestron.command="node"')
    // MCP overrides must precede other flags so codex sees them at parse time.
    expect(argv.indexOf('mcp_servers.orchestron.command="node"')).toBeLessThan(argv.indexOf('--model'))
  })

  it('does not pass --output-schema — structured inquiry is Phase 2', () => {
    expect(buildCodexExecArgv({ prompt: 'hi' })).not.toContain('--output-schema')
  })
})

describe('buildCodexEnv', () => {
  it('returns an override for a non-default codex home', () => {
    expect(buildCodexEnv('/home/x/codex-alt')).toEqual({ CODEX_HOME: '/home/x/codex-alt' })
  })

  it('leaves the env inherited when the home resolves to the harness default', () => {
    expect(buildCodexEnv(path.join(os.homedir(), '.codex'))).toBeUndefined()
    expect(buildCodexEnv('~/.codex')).toBeUndefined()
    expect(buildCodexEnv(undefined)).toBeUndefined()
  })
})

describe('CodexAdapter — useTmux routing', () => {
  beforeEach(() => vi.clearAllMocks())

  it('spawns into tmux when useTmux is absent', async () => {
    const handle = await new CodexAdapter().spawn(baseSpawnConfig)
    expect(tmuxMock.newSession).toHaveBeenCalledTimes(1)
    expect(handle.headless).toBeFalsy()
  })
})

describe('CodexAdapter — headless run', () => {
  let stub: Stub
  let restorePath: () => void
  let workspace: string

  // Real `codex exec --json` event shape (codex-cli 0.153.4).
  const STREAM = [
    '{"type":"thread.started","thread_id":"01a0867b-13fd-7923-8059-b2e6fd8aa730"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"CODEX_OK"}}',
    '{"type":"turn.completed","usage":{"input_tokens":15308,"cached_input_tokens":12160,"cache_write_input_tokens":0,"output_tokens":9,"reasoning_output_tokens":0}}',
  ].join('\n')

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

  it('captures the thread id and final message from the event stream', async () => {
    // Codex mints the thread id itself and announces it only on stdout. If
    // this is missed there is no way to resume or find the rollout file.
    startStub({ name: 'codex', stdout: STREAM, exitCode: 0 })
    const adapter = new CodexAdapter()
    const handle = await adapter.spawn({ ...baseSpawnConfig, workspace, useTmux: false })

    expect(handle.headless).toBe(true)
    expect(handle.claudeUuid).toBe('')   // not known yet — filled in from the result
    expect(tmuxMock.newSession).not.toHaveBeenCalled()

    const result = await adapter.awaitHeadlessExit!(handle)
    expect(result.exitCode).toBe(0)
    expect(result.sessionId).toBe('01a0867b-13fd-7923-8059-b2e6fd8aa730')
    expect(result.finalResponse).toBe('CODEX_OK')
    expect(result.tokenUsage).toEqual({ input: 15308, output: 9, cacheRead: 12160, cacheCreation: 0 })
  })

  it('runs the child in the workspace with the exec argv', async () => {
    startStub({ name: 'codex', stdout: STREAM, exitCode: 0, captureEnv: ['CODEX_HOME'] })
    const adapter = new CodexAdapter()
    const handle = await adapter.spawn({
      ...baseSpawnConfig, workspace, useTmux: false, configDir: '/tmp/codexhome',
    })
    await adapter.awaitHeadlessExit!(handle)

    const argv = stub.readArgv()
    expect(argv[0]).toBe('exec')
    expect(argv).toContain('--json')
    expect(argv[argv.length - 1]).toBe('do the thing')
    expect(stub.readCwd()).toBe(fs.realpathSync(workspace))
    expect(stub.readEnv('CODEX_HOME')).toBe('/tmp/codexhome')
  })

  it('captures stderr and the non-zero code when the child fails', async () => {
    startStub({ name: 'codex', stderr: 'not authenticated', exitCode: 2 })
    const adapter = new CodexAdapter()
    const handle = await adapter.spawn({ ...baseSpawnConfig, workspace, useTmux: false })
    const result = await adapter.awaitHeadlessExit!(handle)
    expect(result.exitCode).toBe(2)
    expect(result.stderr).toContain('not authenticated')
  })

  it('kill terminates the child instead of reaching for tmux', async () => {
    startStub({ name: 'codex', stdout: STREAM, exitCode: 0 })
    const adapter = new CodexAdapter()
    const handle = await adapter.spawn({ ...baseSpawnConfig, workspace, useTmux: false })
    await adapter.kill(handle)
    expect(tmuxMock.killSession).not.toHaveBeenCalled()
  })

  it('waitTuiReady is a no-op and sendPrompt refuses a second turn', async () => {
    startStub({ name: 'codex', stdout: STREAM, exitCode: 0 })
    const adapter = new CodexAdapter()
    const handle = await adapter.spawn({ ...baseSpawnConfig, workspace, useTmux: false })
    await expect(adapter.waitTuiReady(handle, 1)).resolves.toBeUndefined()
    await expect(adapter.sendPrompt(handle, 'again')).rejects.toThrow(/one-shot|does not accept/i)
    await adapter.awaitHeadlessExit!(handle)
  })
})
