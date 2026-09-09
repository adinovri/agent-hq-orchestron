import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../src/adapters/tmux.js', () => ({
  newSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue('❯'),
  setBuffer: vi.fn().mockResolvedValue(undefined),
  pasteBuffer: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(undefined),
}))

import * as tmuxMock from '../../src/adapters/tmux.js'
import { ClaudeAdapter, buildHeadlessArgv } from '../../src/adapters/claude.js'
import { CodexAdapter, buildCodexExecArgv } from '../../src/adapters/codex.js'
import { ORCHESTRON_RESULT_SCHEMA_JSON } from '@agent-hq-orchestron/shared'
import { makeStub, withPath, type Stub } from './headless-stub.js'

let stub: Stub | undefined
let restorePath: (() => void) | undefined

afterEach(() => {
  restorePath?.()
  stub?.cleanup()
  stub = undefined
  restorePath = undefined
  vi.clearAllMocks()
})

const CLAUDE_UUID = '11111111-2222-3333-4444-555555555555'

describe('ClaudeAdapter.resume — mode branch', () => {
  it('still opens a tmux window when useTmux is unset', async () => {
    // The defensive default, same rule as spawn: a config without the field
    // is a tmux resume, or every legacy caller silently changes behaviour.
    const adapter = new ClaudeAdapter()
    const handle = await adapter.resume(CLAUDE_UUID, { workspace: '/tmp' })
    expect(tmuxMock.newSession).toHaveBeenCalled()
    expect(handle.headless).toBeFalsy()
  })

  it('runs a one-shot child when useTmux is false', async () => {
    stub = makeStub({ name: 'claude', stdout: '{"type":"result","result":"ok"}' })
    restorePath = withPath(stub.binDir)
    const adapter = new ClaudeAdapter()
    const handle = await adapter.resume(CLAUDE_UUID, {
      workspace: '/tmp', useTmux: false, prompt: 'next turn',
    })
    expect(handle.headless).toBe(true)
    expect(tmuxMock.newSession).not.toHaveBeenCalled()

    await adapter.awaitHeadlessExit!(handle)
    const argv = stub.readArgv()
    expect(argv).toContain('-p')
    expect(argv).toContain('--resume')
    expect(argv[argv.indexOf('--resume') + 1]).toBe(CLAUDE_UUID)
    // Prompt travels last, behind `--`.
    expect(argv[argv.length - 1]).toBe('next turn')
  })

  it('keeps the harness session id and transcript path stable across a turn', async () => {
    // The whole multi-turn design rests on this: claude appends to the same
    // <uuid>.jsonl, so nothing on the record has to be re-pointed per turn.
    stub = makeStub({ name: 'claude', stdout: '{"type":"result","result":"ok"}' })
    restorePath = withPath(stub.binDir)
    const adapter = new ClaudeAdapter()
    const a = await adapter.resume(CLAUDE_UUID, { workspace: '/tmp', useTmux: false, prompt: 'one' })
    const b = await adapter.resume(CLAUDE_UUID, { workspace: '/tmp', useTmux: false, prompt: 'two' })
    expect(a.claudeUuid).toBe(CLAUDE_UUID)
    expect(b.claudeUuid).toBe(CLAUDE_UUID)
    expect(b.jsonlPath).toBe(a.jsonlPath)
    // …but the handle name is fresh, so killing turn one cannot reap turn two.
    expect(b.tmuxName).not.toBe(a.tmuxName)
    await Promise.all([adapter.awaitHeadlessExit!(a), adapter.awaitHeadlessExit!(b)])
  })

  it('refuses a headless resume with no prompt', async () => {
    // `claude -p` with nothing to run would exit immediately and land the
    // session back in idle having done nothing — a silent no-op button.
    const adapter = new ClaudeAdapter()
    await expect(adapter.resume(CLAUDE_UUID, { workspace: '/tmp', useTmux: false }))
      .rejects.toThrow(/needs a prompt/i)
  })
})

describe('CodexAdapter.resume — mode branch', () => {
  it('still opens a tmux window when useTmux is unset', async () => {
    const adapter = new CodexAdapter()
    const handle = await adapter.resume('thread-1', { workspace: '/tmp' })
    expect(tmuxMock.newSession).toHaveBeenCalled()
    expect(handle.headless).toBeFalsy()
  })

  it('runs `exec resume <thread_id>` when useTmux is false', async () => {
    stub = makeStub({ name: 'codex', stdout: '{"type":"thread.started","thread_id":"thread-1"}' })
    restorePath = withPath(stub.binDir)
    const adapter = new CodexAdapter()
    const handle = await adapter.resume('thread-1', {
      workspace: '/tmp', useTmux: false, prompt: 'next turn',
    })
    expect(handle.headless).toBe(true)
    expect(handle.claudeUuid).toBe('thread-1')
    expect(tmuxMock.newSession).not.toHaveBeenCalled()

    await adapter.awaitHeadlessExit!(handle)
    const argv = stub.readArgv()
    // Codex spells resume as a subcommand of exec, not a flag, and the order
    // matters — `exec resume <id>` before any option.
    expect(argv.slice(0, 3)).toEqual(['exec', 'resume', 'thread-1'])
    expect(argv[argv.length - 1]).toBe('next turn')
  })

  it('refuses a headless resume with no prompt', async () => {
    const adapter = new CodexAdapter()
    await expect(adapter.resume('thread-1', { workspace: '/tmp', useTmux: false }))
      .rejects.toThrow(/needs a prompt/i)
  })
})

describe('structured output flags — the two harnesses differ', () => {
  const newMode = { type: 'new' as const, uuid: CLAUDE_UUID }

  it('claude gets the schema INLINE, because --json-schema rejects a path', () => {
    // Verified against 2.1.266: passing a filename yields
    // `--json-schema is not valid JSON: JSON Parse error`.
    const argv = buildHeadlessArgv({ prompt: 'hi', sessionMode: newMode, structuredOutput: true })
    const value = argv[argv.indexOf('--json-schema') + 1]!
    expect(value).toBe(ORCHESTRON_RESULT_SCHEMA_JSON)
    expect(() => JSON.parse(value)).not.toThrow()
  })

  it('codex gets a FILE PATH, because --output-schema takes one', () => {
    const argv = buildCodexExecArgv({ prompt: 'hi', outputSchemaPath: '/data/schema.json' })
    expect(argv[argv.indexOf('--output-schema') + 1]).toBe('/data/schema.json')
  })

  it('omits the flag entirely when structured output is off', () => {
    expect(buildHeadlessArgv({ prompt: 'hi', sessionMode: newMode })).not.toContain('--json-schema')
    expect(buildCodexExecArgv({ prompt: 'hi' })).not.toContain('--output-schema')
  })
})
