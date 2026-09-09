import { describe, it, expect } from 'vitest'
import { parseClaudeRollout } from '../src/routes/sessions.js'

/**
 * The Claude JSONL on disk comes in two shapes and orchestron reads both.
 * The record types that differ between them carry no transcript content, so
 * the parser's job is to pick out user/assistant/tool records and ignore
 * everything else — including record types that don't exist yet.
 *
 * Fixtures are trimmed from real transcripts (Claude Code 1.x and 2.1.266).
 */

// v1: mode / permission-mode / file-history-snapshot / cost-state
const V1 = [
  '{"type":"mode","mode":"normal","timestamp":"2026-01-01T00:00:00.000Z"}',
  '{"type":"permission-mode","permissionMode":"default","timestamp":"2026-01-01T00:00:01.000Z"}',
  '{"type":"file-history-snapshot","snapshot":{},"timestamp":"2026-01-01T00:00:02.000Z"}',
  '{"type":"user","timestamp":"2026-01-01T00:00:03.000Z","message":{"content":"list the files"}}',
  '{"type":"assistant","timestamp":"2026-01-01T00:00:04.000Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":10,"output_tokens":2}}}',
  '{"type":"user","timestamp":"2026-01-01T00:00:05.000Z","message":{"content":[{"type":"tool_result","content":"a.txt"}]}}',
  '{"type":"assistant","timestamp":"2026-01-01T00:00:06.000Z","message":{"content":[{"type":"text","text":"There is one file."}],"usage":{"input_tokens":11,"output_tokens":5,"cache_read_input_tokens":7,"cache_creation_input_tokens":3}}}',
  '{"type":"cost-state","timestamp":"2026-01-01T00:00:07.000Z"}',
  '{"type":"last-prompt","timestamp":"2026-01-01T00:00:08.000Z"}',
].join('\n')

// v2: queue-operation / attachment / atis-latch / ai-title. This is also what
// `claude -p` writes — headless and interactive share one format.
const V2 = [
  '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-09-09T14:02:26.000Z"}',
  '{"type":"queue-operation","operation":"dequeue","timestamp":"2026-09-09T14:02:26.100Z"}',
  '{"type":"user","timestamp":"2026-09-09T14:02:26.670Z","message":{"content":"Reply with exactly: HEADLESS_PROBE_OK"}}',
  '{"type":"attachment","timestamp":"2026-09-09T14:02:26.700Z","attachment":{"type":"claude_md"}}',
  '{"type":"atis-latch","timestamp":"2026-09-09T14:02:27.000Z"}',
  '{"type":"assistant","timestamp":"2026-09-09T14:02:29.795Z","message":{"content":[{"type":"text","text":"HEADLESS_PROBE_OK"}],"usage":{"input_tokens":2,"output_tokens":16,"cache_read_input_tokens":10548,"cache_creation_input_tokens":15972}}}',
  '{"type":"last-prompt","timestamp":"2026-09-09T14:02:29.900Z"}',
  '{"type":"ai-title","title":"Headless probe","timestamp":"2026-09-09T14:02:30.000Z"}',
].join('\n')

describe('parseClaudeRollout — v1 format', () => {
  const p = parseClaudeRollout(V1)

  it('extracts every conversational record kind', () => {
    expect(p.entries.map((e) => e.kind)).toEqual(['user', 'tool_use', 'tool_result', 'assistant'])
  })

  it('skips the v1-only bookkeeping records', () => {
    // mode / permission-mode / file-history-snapshot / cost-state / last-prompt
    // carry no transcript content and must not become entries.
    expect(p.entries).toHaveLength(4)
  })

  it('reports the last assistant text and per-turn usage', () => {
    expect(p.lastAssistantText).toBe('There is one file.')
    expect(p.contextStats).toMatchObject({
      lastInputTokens: 11,
      lastOutputTokens: 5,
      lastCacheReadTokens: 7,
      lastCacheCreationTokens: 3,
      assistantTurns: 2,
    })
  })
})

describe('parseClaudeRollout — v2 format (also what claude -p writes)', () => {
  const p = parseClaudeRollout(V2)

  it('extracts the user prompt and assistant reply', () => {
    expect(p.entries.map((e) => e.kind)).toEqual(['user', 'assistant'])
    expect(p.entries[0]!.content).toBe('Reply with exactly: HEADLESS_PROBE_OK')
    expect(p.lastAssistantText).toBe('HEADLESS_PROBE_OK')
  })

  it('skips the v2-only bookkeeping records', () => {
    // queue-operation / attachment / atis-latch / ai-title.
    expect(p.entries).toHaveLength(2)
  })

  it('reports usage from the assistant turn', () => {
    expect(p.contextStats).toMatchObject({
      lastInputTokens: 2,
      lastOutputTokens: 16,
      lastCacheReadTokens: 10548,
      lastCacheCreationTokens: 15972,
      lastEffectiveContext: 2 + 10548 + 15972,
      assistantTurns: 1,
    })
  })

  it('reports no turn-end marker — headless emits no turn_duration', () => {
    // Load-bearing: the transcript poller must not be what ends a headless
    // turn. Process exit is the only boundary, and completeHeadlessSpawn
    // owns it.
    expect(p.lastTurnEndTs).toBe('')
    expect(p.lastUserTs).toBe('2026-09-09T14:02:26.670Z')
  })
})

describe('parseClaudeRollout — resilience', () => {
  it('handles a file carrying both v1 and v2 markers', () => {
    // Real sessions straddle a CLI upgrade and end up with both.
    const mixed = [
      '{"type":"mode","mode":"normal"}',
      '{"type":"queue-operation","operation":"enqueue"}',
      '{"type":"user","timestamp":"2026-01-01T00:00:00.000Z","message":{"content":"hi"}}',
    ].join('\n')
    expect(parseClaudeRollout(mixed).entries).toHaveLength(1)
  })

  it('skips malformed lines instead of throwing', () => {
    const broken = `{"type":"user","message":{"content":"ok"}}\nnot json at all\n{"type":`
    expect(parseClaudeRollout(broken).entries).toHaveLength(1)
  })

  it('returns an empty parse for empty input', () => {
    const p = parseClaudeRollout('')
    expect(p.entries).toEqual([])
    expect(p.contextStats).toBeNull()
  })

  it('counts compact boundaries', () => {
    const compacted = [
      '{"type":"system","subtype":"compact_boundary","timestamp":"2026-01-01T00:00:00.000Z"}',
      '{"type":"assistant","timestamp":"2026-01-01T00:00:01.000Z","message":{"content":[{"type":"text","text":"after"}],"usage":{"input_tokens":1,"output_tokens":1}}}',
    ].join('\n')
    expect(parseClaudeRollout(compacted).contextStats).toMatchObject({
      compactionCount: 1,
      lastCompactedAt: '2026-01-01T00:00:00.000Z',
    })
  })
})
