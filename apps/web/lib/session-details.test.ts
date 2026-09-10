import { describe, it, expect } from 'vitest'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'
import {
  buildSessionDetailSections,
  resumeCommandFor,
  attachCommandFor,
  type DetailSection,
} from './session-details'

function session(over: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: 'sess-1',
    projectId: 'proj-1',
    agentType: 'claude',
    status: 'running',
    parentSessionId: null,
    detached: false,
    claudeSessionUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    tmuxName: 'orchestron-sess-1',
    jsonlPath: '/tmp/sess-1.jsonl',
    initialPrompt: 'do the thing',
    finalResponse: null,
    tokenUsage: null,
    costUsd: null,
    startedAt: '2026-09-10T06:02:00.000Z',
    endedAt: null,
    metadata: {},
    ...over,
  } as SessionMetadata
}

const titles = (s: DetailSection[]) => s.map((x) => x.title)
const section = (s: DetailSection[], title: string) => s.find((x) => x.title === title)
const labels = (s: DetailSection[], title: string) => section(s, title)?.rows.map((r) => r.label) ?? []
const row = (s: DetailSection[], title: string, label: string) =>
  section(s, title)?.rows.find((r) => r.label === label)

describe('buildSessionDetailSections', () => {
  it('groups a full tmux session into all four sections', () => {
    const out = buildSessionDetailSections({
      session: session({ endedAt: '2026-09-10T06:40:00.000Z', costUsd: 0.1858, configDir: '/home/a/.claude' }),
      projectName: 'Sacred HL',
      projectPath: '/home/a/work',
      effectiveModel: 'claude-opus-5',
      effectiveEffort: 'high',
    })
    expect(titles(out)).toEqual(['Identity', 'Location', 'Commands', 'Timing'])
    expect(labels(out, 'Identity')).toEqual([
      'session id', 'claude session', 'agent', 'model', 'effort', 'status', 'mode',
    ])
    expect(labels(out, 'Location')).toEqual(['project', 'workspace', 'config dir', 'tmux'])
    expect(labels(out, 'Commands')).toEqual(['resume', 'attach'])
    expect(labels(out, 'Timing')).toEqual(['started', 'ended', 'cost'])
  })

  it('preserves every field the flat list used to render', () => {
    const s = session({ endedAt: '2026-09-10T06:40:00.000Z', costUsd: 0.1858 })
    const out = buildSessionDetailSections({
      session: s,
      projectName: 'Sacred HL',
      projectPath: '/home/a/work',
    })
    expect(row(out, 'Identity', 'session id')?.value).toBe('sess-1')
    expect(row(out, 'Identity', 'claude session')?.value).toBe(s.claudeSessionUuid)
    expect(row(out, 'Identity', 'agent')?.value).toBe('claude')
    expect(row(out, 'Location', 'project')?.value).toBe('Sacred HL')
    expect(row(out, 'Location', 'workspace')?.value).toBe('/home/a/work')
    expect(row(out, 'Location', 'tmux')?.value).toBe('orchestron-sess-1')
    expect(row(out, 'Commands', 'resume')?.value).toBe(`claude --resume ${s.claudeSessionUuid}`)
    expect(row(out, 'Commands', 'attach')?.value).toBe('tmux attach -rt orchestron-sess-1')
    expect(row(out, 'Timing', 'started')?.value).toBe(new Date(s.startedAt).toLocaleString())
    expect(row(out, 'Timing', 'ended')?.value).toBe(new Date(s.endedAt!).toLocaleString())
    expect(row(out, 'Timing', 'cost')?.value).toBe('$0.1858')
  })

  it('drops the Commands section entirely for a headless session with no transcript', () => {
    const out = buildSessionDetailSections({
      session: session({ useTmux: false, tmuxName: '', claudeSessionUuid: '' }),
      projectName: 'Sacred HL',
    })
    expect(titles(out)).toEqual(['Identity', 'Location', 'Timing'])
    expect(section(out, 'Commands')).toBeUndefined()
    expect(labels(out, 'Location')).toEqual(['project'])
    expect(row(out, 'Identity', 'mode')?.value).toBe('headless')
  })

  it('keeps resume but not attach when a headless session has a transcript', () => {
    const out = buildSessionDetailSections({
      session: session({ useTmux: false, tmuxName: '' }),
    })
    expect(labels(out, 'Commands')).toEqual(['resume'])
    expect(labels(out, 'Location')).toEqual(['project'])
  })

  it('reads a missing useTmux as tmux so legacy records are not relabelled', () => {
    const out = buildSessionDetailSections({ session: session({ useTmux: undefined }) })
    expect(row(out, 'Identity', 'mode')?.value).toBe('tmux')
  })

  it('labels the harness session row and resume command per agent type', () => {
    const out = buildSessionDetailSections({ session: session({ agentType: 'codex' }) })
    expect(labels(out, 'Identity')).toContain('codex session')
    expect(row(out, 'Commands', 'resume')?.value).toMatch(/^codex resume /)
  })

  it('falls back to the raw project id when no name is supplied', () => {
    const out = buildSessionDetailSections({ session: session() })
    expect(row(out, 'Location', 'project')?.value).toBe('proj-1')
  })

  it('carries inheritance provenance as a hint, not as part of the value', () => {
    const out = buildSessionDetailSections({
      session: session(),
      effectiveModel: 'claude-opus-5',
      effectiveEffort: 'high',
      modelHint: 'project default',
      effortHint: 'harness default (claude)',
    })
    expect(row(out, 'Identity', 'model')).toMatchObject({ value: 'claude-opus-5', hint: 'project default' })
    expect(row(out, 'Identity', 'effort')).toMatchObject({ value: 'high', hint: 'harness default (claude)' })
  })

  it('surfaces a failure reason next to the end timestamp', () => {
    const out = buildSessionDetailSections({
      session: session({ status: 'failed', endedAt: '2026-09-10T06:40:00.000Z', failureReason: 'tmux window vanished' }),
    })
    expect(labels(out, 'Timing')).toEqual(['started', 'ended', 'failure'])
    expect(row(out, 'Timing', 'failure')?.value).toBe('tmux window vanished')
  })

  it('marks identifiers, paths and commands as mono and prose as not', () => {
    const out = buildSessionDetailSections({
      session: session({ costUsd: 1 }),
      projectName: 'Sacred HL',
      projectPath: '/home/a/work',
      effectiveEffort: 'high',
    })
    expect(row(out, 'Identity', 'session id')?.mono).toBe(true)
    expect(row(out, 'Location', 'workspace')?.mono).toBe(true)
    expect(row(out, 'Commands', 'resume')?.mono).toBe(true)
    expect(row(out, 'Identity', 'agent')?.mono).toBeUndefined()
    expect(row(out, 'Identity', 'effort')?.mono).toBeUndefined()
    expect(row(out, 'Location', 'project')?.mono).toBeUndefined()
    expect(row(out, 'Timing', 'started')?.mono).toBeUndefined()
  })

  it('offers copy only on the rows worth copying', () => {
    const out = buildSessionDetailSections({
      session: session({ costUsd: 1, configDir: '/home/a/.claude' }),
      projectName: 'Sacred HL',
      projectPath: '/home/a/work',
    })
    const copyable = out.flatMap((s) => s.rows.filter((r) => r.copy).map((r) => r.label))
    expect(copyable).toEqual([
      'session id', 'claude session', 'workspace', 'config dir', 'tmux', 'resume', 'attach',
    ])
    // Every copyable row copies exactly what it renders.
    for (const s of out) for (const r of s.rows) if (r.copy) expect(r.copy).toBe(r.value)
  })

  it('omits cost when the session recorded none, and keeps it at zero', () => {
    expect(labels(buildSessionDetailSections({ session: session({ costUsd: null }) }), 'Timing')).toEqual(['started'])
    expect(row(buildSessionDetailSections({ session: session({ costUsd: 0 }) }), 'Timing', 'cost')?.value).toBe('$0.0000')
  })
})

describe('resumeCommandFor / attachCommandFor', () => {
  it('returns null rather than a half-formed command', () => {
    expect(resumeCommandFor(session({ claudeSessionUuid: '' }))).toBeNull()
    expect(attachCommandFor(session({ tmuxName: '' }))).toBeNull()
  })
})
