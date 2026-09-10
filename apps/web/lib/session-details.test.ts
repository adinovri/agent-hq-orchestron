import { describe, it, expect } from 'vitest'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'
import {
  buildSessionDetailSections,
  resumeCommandFor,
  attachCommandFor,
  usesTmux,
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

/** Shape the API actually persists for a headless spawn — see
 *  `spawnHeadless` in apps/api/src/adapters/claude.ts. */
const HEADLESS_TMUX_NAME = 'headless-52de306e'
/** codex mints a different shape — `headless-codex-<hex>`, see
 *  `spawnHeadless` in apps/api/src/adapters/codex.ts. Neither prefix is
 *  what the gate reads, and covering both is the point. */
const HEADLESS_CODEX_TMUX_NAME = 'headless-codex-9f2ab411'

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
      // HEADLESS_TMUX_NAME, not '' — a headless record really does carry a
      // name. Fixturing it blank is what let the tmux row ship visible.
      session: session({ useTmux: false, tmuxName: HEADLESS_TMUX_NAME, claudeSessionUuid: '' }),
      projectName: 'Sacred HL',
    })
    expect(titles(out)).toEqual(['Identity', 'Location', 'Timing'])
    expect(section(out, 'Commands')).toBeUndefined()
    expect(labels(out, 'Location')).toEqual(['project'])
    expect(row(out, 'Identity', 'mode')?.value).toBe('headless')
  })

  it('keeps resume but not attach when a headless session has a transcript', () => {
    const out = buildSessionDetailSections({
      session: session({ useTmux: false, tmuxName: HEADLESS_TMUX_NAME }),
    })
    expect(labels(out, 'Commands')).toEqual(['resume'])
    expect(labels(out, 'Location')).toEqual(['project'])
  })

  /**
   * A headless session has no tmux window, but its record still has a
   * `tmuxName`: the API mints `headless-<uuid8>` as the ownership token
   * `stillOwns()` matches against, and keys the child registry on it.
   * Testing `session.tmuxName` therefore answers the wrong question, and
   * the panel showed both an attach command that cannot work and a name
   * with nothing behind it. Guard on the mode instead.
   */
  it('hides the tmux name and attach command when the record is headless', () => {
    const out = buildSessionDetailSections({
      session: session({ useTmux: false, tmuxName: HEADLESS_TMUX_NAME }),
      projectPath: '/home/a/work',
    })
    expect(labels(out, 'Location')).toEqual(['project', 'workspace'])
    expect(row(out, 'Location', 'tmux')).toBeUndefined()
    expect(labels(out, 'Commands')).toEqual(['resume'])
    expect(row(out, 'Commands', 'attach')).toBeUndefined()
    // Nothing anywhere in the panel leaks the synthetic name.
    const values = out.flatMap((sec) => sec.rows).flatMap((r) => [r.value, r.copy ?? ''])
    expect(values.some((v) => v.includes(HEADLESS_TMUX_NAME))).toBe(false)
  })

  it('hides the tmux rows for a headless codex session too', () => {
    const out = buildSessionDetailSections({
      session: session({
        agentType: 'codex',
        useTmux: false,
        tmuxName: HEADLESS_CODEX_TMUX_NAME,
      }),
      projectPath: '/home/a/work',
    })
    expect(row(out, 'Location', 'tmux')).toBeUndefined()
    expect(row(out, 'Commands', 'attach')).toBeUndefined()
    expect(row(out, 'Identity', 'mode')?.value).toBe('headless')
  })

  it('still shows tmux rows for a codex session, which mints its own name', () => {
    const out = buildSessionDetailSections({
      session: session({ agentType: 'codex', useTmux: true, tmuxName: 'orchestron-codex-abc123' }),
    })
    expect(row(out, 'Location', 'tmux')?.value).toBe('orchestron-codex-abc123')
    expect(row(out, 'Commands', 'attach')?.value).toBe('tmux attach -rt orchestron-codex-abc123')
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
    expect(attachCommandFor(session({ useTmux: false, tmuxName: HEADLESS_TMUX_NAME }))).toBeNull()
    // `undefined` is a legacy tmux record, not a headless one.
    expect(attachCommandFor(session({ useTmux: undefined }))).toBe('tmux attach -rt orchestron-sess-1')
  })
})

describe('usesTmux', () => {
  it('treats a missing field as tmux and only an explicit false as headless', () => {
    expect(usesTmux(session({ useTmux: true }))).toBe(true)
    expect(usesTmux(session({ useTmux: false }))).toBe(false)
    // The whole reason this is not a bare `!session.useTmux`: records
    // written before the flag existed carry no field at all, and every
    // one of them runs in tmux.
    expect(usesTmux(session({ useTmux: undefined }))).toBe(true)
  })
})
