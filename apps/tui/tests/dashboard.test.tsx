import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from 'ink-testing-library'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'
import { Dashboard } from '../src/screens/Dashboard.js'
import type { ApiConfig } from '../src/hooks/useApi.js'

const MOCK_SESSIONS: SessionMetadata[] = [
  {
    id: '00000000-0000-0000-0000-000000000001',
    projectId: 'proj-1',
    agentType: 'claude',
    status: 'running',
    parentSessionId: null,
    detached: false,
    claudeSessionUuid: '00000000-0000-0000-0000-000000000011',
    tmuxName: 'session-alpha',
    jsonlPath: '/tmp/a.jsonl',
    initialPrompt: 'Do something',
    finalResponse: null,
    tokenUsage: null,
    costUsd: 0.0012,
    startedAt: '2026-09-04T00:00:00.000Z',
    endedAt: null,
    metadata: {},
  },
  {
    id: '00000000-0000-0000-0000-000000000002',
    projectId: 'proj-1',
    agentType: 'claude',
    status: 'completed',
    parentSessionId: null,
    detached: false,
    claudeSessionUuid: '00000000-0000-0000-0000-000000000012',
    tmuxName: 'session-beta',
    jsonlPath: '/tmp/b.jsonl',
    initialPrompt: 'Do something else',
    finalResponse: 'Done',
    tokenUsage: { input: 100, output: 50 },
    costUsd: 0.0023,
    startedAt: '2026-09-04T00:01:00.000Z',
    endedAt: '2026-09-04T00:02:00.000Z',
    metadata: {},
  },
  {
    id: '00000000-0000-0000-0000-000000000003',
    projectId: 'proj-2',
    agentType: 'claude',
    status: 'failed',
    parentSessionId: null,
    detached: false,
    claudeSessionUuid: '00000000-0000-0000-0000-000000000013',
    tmuxName: 'session-gamma',
    jsonlPath: '/tmp/c.jsonl',
    initialPrompt: 'Do something more',
    finalResponse: null,
    tokenUsage: null,
    costUsd: null,
    startedAt: '2026-09-04T00:03:00.000Z',
    endedAt: '2026-09-04T00:04:00.000Z',
    failureReason: 'timeout',
    metadata: {},
  },
]

const config: ApiConfig = { baseUrl: 'http://localhost:8080' }
const noop = () => {}

describe('Dashboard', () => {
  it('renders 3 mock sessions', () => {
    const { lastFrame } = render(
      <Dashboard
        sessions={MOCK_SESSIONS}
        config={config}
        onOpen={noop}
        onNew={noop}
        onQuit={noop}
        onStatus={noop}
        commandMode={false}
        setCommandMode={noop}
      />,
    )

    const frame = lastFrame()
    expect(frame).toContain('session-alpha')
    expect(frame).toContain('session-beta')
    expect(frame).toContain('session-gamma')
  })

  it('shows first session highlighted by default', () => {
    const { lastFrame } = render(
      <Dashboard
        sessions={MOCK_SESSIONS}
        config={config}
        onOpen={noop}
        onNew={noop}
        onQuit={noop}
        onStatus={noop}
        commandMode={false}
        setCommandMode={noop}
      />,
    )

    const frame = lastFrame() ?? ''
    // First row should have the selection indicator
    expect(frame).toContain('▶')
    // Alpha should appear after the indicator
    const alphaIdx = frame.indexOf('session-alpha')
    const arrowIdx = frame.indexOf('▶')
    expect(arrowIdx).toBeGreaterThanOrEqual(0)
    expect(alphaIdx).toBeGreaterThanOrEqual(0)
  })

  it('renders empty state when no sessions', () => {
    const { lastFrame } = render(
      <Dashboard
        sessions={[]}
        config={config}
        onOpen={noop}
        onNew={noop}
        onQuit={noop}
        onStatus={noop}
        commandMode={false}
        setCommandMode={noop}
      />,
    )

    expect(lastFrame()).toContain('No sessions')
  })
})
