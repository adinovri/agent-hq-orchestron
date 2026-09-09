import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock tmux module before importing claude adapter
vi.mock('../src/adapters/tmux.js', () => ({
  newSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue('❯'),
  setBuffer: vi.fn().mockResolvedValue(undefined),
  pasteBuffer: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(undefined),
}))

import * as tmuxMock from '../src/adapters/tmux.js'
import { ClaudeAdapter } from '../src/adapters/claude.js'

const claudeAdapter = new ClaudeAdapter()

const baseSpawnConfig = {
  projectId: 'proj-1',
  agentType: 'claude' as const,
  initialPrompt: 'hello',
  workspace: '/tmp/ws',
}

describe('claudeAdapter — argv builder', () => {
  it('spawn builds argv without -p or --print', async () => {
    await claudeAdapter.spawn(baseSpawnConfig)
    const [, argv] = (tmuxMock.newSession as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(argv).not.toContain('-p')
    expect(argv).not.toContain('--print')
  })

  it('spawn argv includes --permission-mode bypassPermissions', async () => {
    vi.clearAllMocks()
    await claudeAdapter.spawn(baseSpawnConfig)
    const [, argv] = (tmuxMock.newSession as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(argv).toContain('--permission-mode')
    expect(argv).toContain('bypassPermissions')
  })

  it('spawn argv includes --session-id (not --resume)', async () => {
    vi.clearAllMocks()
    await claudeAdapter.spawn(baseSpawnConfig)
    const [, argv] = (tmuxMock.newSession as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(argv).toContain('--session-id')
    expect(argv).not.toContain('--resume')
  })

  it('resume argv includes --resume (not --session-id)', async () => {
    vi.clearAllMocks()
    await claudeAdapter.resume('test-uuid-1234', { workspace: '/tmp/ws' })
    const [, argv] = (tmuxMock.newSession as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(argv).toContain('--resume')
    expect(argv).toContain('test-uuid-1234')
    expect(argv).not.toContain('--session-id')
  })

  it('spawn with model includes --model flag', async () => {
    vi.clearAllMocks()
    await claudeAdapter.spawn({ ...baseSpawnConfig, model: 'claude-opus-5' })
    const [, argv] = (tmuxMock.newSession as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(argv).toContain('--model')
    expect(argv).toContain('claude-opus-5')
  })
})

describe('claudeAdapter — tmux delegation', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sendPrompt calls setBuffer + pasteBuffer + sendKeys', async () => {
    const handle = { tmuxName: 'test-session', claudeUuid: 'abc', jsonlPath: '/tmp/abc.jsonl' }
    await claudeAdapter.sendPrompt(handle, 'my prompt')
    expect(tmuxMock.setBuffer).toHaveBeenCalledWith('test-session', 'my prompt')
    expect(tmuxMock.pasteBuffer).toHaveBeenCalledWith('test-session')
    expect(tmuxMock.sendKeys).toHaveBeenCalledWith('test-session', 'Enter')
  })

  it('kill calls killSession', async () => {
    const handle = { tmuxName: 'test-session', claudeUuid: 'abc', jsonlPath: '/tmp/abc.jsonl' }
    await claudeAdapter.kill(handle)
    expect(tmuxMock.killSession).toHaveBeenCalledWith('test-session')
  })

  it('waitTuiReady resolves when capturePane matches TUI regex', async () => {
    // TUI_READY_RE matches the Claude status-bar footer (version + `│` separator)
    // or the `? for shortcuts` hint. A bare `❯` was the pre-2026-08 signal but
    // proved noisy (menu selectors use it too) — real ready detection now keys
    // on the version-bar line the TUI renders once the pane is settled.
    vi.mocked(tmuxMock.capturePane).mockResolvedValueOnce(
      '  ? for shortcuts  |  v2.1.266 │ Opus 5 │ /help for commands',
    )
    const handle = { tmuxName: 'test-session', claudeUuid: 'abc', jsonlPath: '/tmp/abc.jsonl' }
    await expect(claudeAdapter.waitTuiReady(handle, 2000)).resolves.toBeUndefined()
  })

  it('waitTuiReady times out if TUI never ready', async () => {
    vi.mocked(tmuxMock.capturePane).mockResolvedValue('loading...')
    const handle = { tmuxName: 'test-session', claudeUuid: 'abc', jsonlPath: '/tmp/abc.jsonl' }
    await expect(claudeAdapter.waitTuiReady(handle, 300)).rejects.toThrow('timeout')
  })
})
