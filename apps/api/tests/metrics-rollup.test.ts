import { describe, it, expect, vi, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { MetricsCollector, rollupSessionUsage } from '../src/domain/metrics-collector.js'
import { computeCost } from '../src/domain/pricing-table.js'
import type { SessionManager } from '../src/domain/session-manager.js'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'

// One assistant rollout row. `id` omitted entirely when undefined, so the
// "rows that carry no message.id" case is genuinely id-less and not id:null.
function row(opts: {
  id?: string
  model?: string
  ts?: string
  input?: number
  output?: number
  cacheRead?: number
  cacheCreation?: number
}): string {
  const message: Record<string, unknown> = {
    usage: {
      input_tokens: opts.input ?? 0,
      output_tokens: opts.output ?? 0,
      cache_read_input_tokens: opts.cacheRead ?? 0,
      cache_creation_input_tokens: opts.cacheCreation ?? 0,
    },
  }
  if (opts.id !== undefined) message['id'] = opts.id
  if (opts.model !== undefined) message['model'] = opts.model
  const ev: Record<string, unknown> = { type: 'assistant', message }
  if (opts.ts !== undefined) ev['timestamp'] = opts.ts
  return JSON.stringify(ev)
}

const START = '2026-09-11T10:00:00.000Z'

describe('rollupSessionUsage — NF9 dedup by message.id', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('bills a split assistant message once — exactly half of the naive sum', () => {
    // Claude Code's real shape: thinking row + text row, same id, same usage.
    const split = [
      row({ id: 'msg_A', model: 'claude-haiku-4-5', input: 10, output: 205, cacheRead: 18171, cacheCreation: 40 }),
      row({ id: 'msg_A', model: 'claude-haiku-4-5', input: 10, output: 205, cacheRead: 18171, cacheCreation: 40 }),
    ].join('\n')
    const single = row({ id: 'msg_A', model: 'claude-haiku-4-5', input: 10, output: 205, cacheRead: 18171, cacheCreation: 40 })

    const dup = rollupSessionUsage(split, 'claude-haiku-4-5', START)
    const one = rollupSessionUsage(single, 'claude-haiku-4-5', START)

    expect(dup.duplicateRows).toBe(1)
    expect(dup.input).toBe(one.input)
    expect(dup.output).toBe(one.output)
    expect(dup.cacheRead).toBe(one.cacheRead)
    expect(dup.cacheCreation).toBe(one.cacheCreation)
    expect(dup.costUsd).toBeCloseTo(one.costUsd, 12)

    // The defect this guards: the naive sum was exactly 2x.
    const naive = one.input + one.output + one.cacheRead + one.cacheCreation
    expect(dup.input + dup.output + dup.cacheRead + dup.cacheCreation).toBe(naive)
  })

  it('does not dedup distinct message ids', () => {
    const raw = [
      row({ id: 'msg_A', model: 'claude-haiku-4-5', input: 100, output: 200 }),
      row({ id: 'msg_B', model: 'claude-haiku-4-5', input: 100, output: 200 }),
    ].join('\n')
    const r = rollupSessionUsage(raw, 'claude-haiku-4-5', START)
    expect(r.duplicateRows).toBe(0)
    expect(r.input).toBe(200)
    expect(r.output).toBe(400)
  })

  it('counts every row when the rows carry no message.id', () => {
    const raw = [
      row({ model: 'claude-haiku-4-5', input: 100, output: 200 }),
      row({ model: 'claude-haiku-4-5', input: 100, output: 200 }),
    ].join('\n')
    const r = rollupSessionUsage(raw, 'claude-haiku-4-5', START)
    expect(r.duplicateRows).toBe(0)
    expect(r.input).toBe(200)
  })

  it('same id with different usage: bills the first occurrence and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = [
      row({ id: 'msg_A', model: 'claude-haiku-4-5', input: 100, output: 200 }),
      row({ id: 'msg_A', model: 'claude-haiku-4-5', input: 999, output: 999 }),
    ].join('\n')

    const r = rollupSessionUsage(raw, 'claude-haiku-4-5', START, 'sess-xyz')

    expect(r.input).toBe(100)
    expect(r.output).toBe(200)
    expect(r.duplicateRows).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('msg_A')
    expect(String(warn.mock.calls[0]![0])).toContain('sess-xyz')
  })

  it('stays quiet when the duplicate is an exact repeat', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const raw = [
      row({ id: 'msg_A', input: 100, output: 200 }),
      row({ id: 'msg_A', input: 100, output: 200 }),
    ].join('\n')
    rollupSessionUsage(raw, 'claude-haiku-4-5', START)
    expect(warn).not.toHaveBeenCalled()
  })

  it('advances lastTs and lastModel across a duplicate row', () => {
    const raw = [
      row({ id: 'msg_A', model: 'claude-opus-5', ts: '2026-09-11T10:01:00.000Z', input: 100 }),
      row({ id: 'msg_A', model: 'claude-opus-5', ts: '2026-09-11T10:02:00.000Z', input: 100 }),
    ].join('\n')
    const r = rollupSessionUsage(raw, 'claude-sonnet-5', START)
    expect(r.lastTs).toBe('2026-09-11T10:02:00.000Z')
    expect(r.lastModel).toBe('claude-opus-5')
    expect(r.input).toBe(100)
  })
})

describe('rollupSessionUsage — NF10 per-event pricing', () => {
  it('prices each event at the model that produced it', () => {
    const raw = [
      row({ id: 'm1', model: 'claude-opus-5', input: 1_000_000, output: 1_000_000 }),
      row({ id: 'm2', model: 'claude-opus-5', input: 1_000_000, output: 1_000_000 }),
      row({ id: 'm3', model: 'claude-sonnet-5', input: 1_000_000, output: 1_000_000 }),
    ].join('\n')

    const r = rollupSessionUsage(raw, 'claude-opus-5', START)

    const opusTurn = computeCost({ input: 1_000_000, output: 1_000_000 }, 'claude-opus-5')
    const sonnetTurn = computeCost({ input: 1_000_000, output: 1_000_000 }, 'claude-sonnet-5')
    expect(r.costUsd).toBeCloseTo(opusTurn * 2 + sonnetTurn, 9)

    // The old rule priced the whole session at the last model — 5x low here.
    const lastModelRule = computeCost({ input: 3_000_000, output: 3_000_000 }, 'claude-sonnet-5')
    expect(r.costUsd).toBeGreaterThan(lastModelRule)
    expect(r.lastModel).toBe('claude-sonnet-5')
  })

  it('single-model session matches the whole-total-at-one-rate result (regression guard)', () => {
    const raw = [
      row({ id: 'm1', model: 'claude-sonnet-5', input: 1234, output: 567, cacheRead: 8910, cacheCreation: 112 }),
      row({ id: 'm2', model: 'claude-sonnet-5', input: 4321, output: 765, cacheRead: 1098, cacheCreation: 211 }),
    ].join('\n')

    const r = rollupSessionUsage(raw, 'claude-sonnet-5', START)
    const legacy = computeCost(
      { input: 1234 + 4321, output: 567 + 765, cacheRead: 8910 + 1098, cacheCreation: 112 + 211 },
      'claude-sonnet-5',
    )
    expect(r.costUsd).toBeCloseTo(legacy, 12)
  })

  it('falls back to the session model when an event carries no model field', () => {
    const raw = row({ id: 'm1', input: 1_000_000, output: 1_000_000 })
    const r = rollupSessionUsage(raw, 'claude-opus-5', START)
    expect(r.costUsd).toBeCloseTo(computeCost({ input: 1_000_000, output: 1_000_000 }, 'claude-opus-5'), 12)
    expect(r.lastModel).toBe('claude-opus-5')
  })

  it("falls back to 'unknown' pricing when neither event nor session names a model", () => {
    const raw = row({ id: 'm1', input: 1_000_000, output: 1_000_000 })
    const r = rollupSessionUsage(raw, undefined, START)
    expect(r.lastModel).toBe('unknown')
    expect(r.costUsd).toBeCloseTo(computeCost({ input: 1_000_000, output: 1_000_000 }, 'unknown'), 12)
  })

  it('ignores non-assistant rows, rows without usage, and unparseable lines', () => {
    const raw = [
      '{ not json',
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { id: 'm0', model: 'claude-opus-5' } }),
      '',
      row({ id: 'm1', model: 'claude-haiku-4-5', input: 10, output: 20 }),
    ].join('\n')
    const r = rollupSessionUsage(raw, 'claude-haiku-4-5', START)
    expect(r.input).toBe(10)
    expect(r.output).toBe(20)
    expect(r.duplicateRows).toBe(0)
  })
})

describe('MetricsCollector.query — dedup and per-event pricing end to end', () => {
  let dir = ''
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = '' })

  function session(overrides: Partial<SessionMetadata>): SessionMetadata {
    return {
      id: 'sess-nf9',
      projectId: 'proj-alpha',
      agentType: 'claude',
      model: 'claude-haiku-4-5',
      status: 'completed',
      parentSessionId: null,
      detached: false,
      claudeSessionUuid: 'sess-nf9',
      tmuxName: 'orch-nf9',
      jsonlPath: '',
      initialPrompt: 'x',
      finalResponse: 'y',
      tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      costUsd: 0,
      startedAt: START,
      endedAt: '2026-09-11T10:05:00.000Z',
      metadata: {},
      ...overrides,
    } as SessionMetadata
  }

  async function collectorFor(sessions: SessionMetadata[]): Promise<MetricsCollector> {
    const sm = { list: async () => sessions } as unknown as SessionManager
    return new MetricsCollector(path.join(dir, 'data'), sm)
  }

  it('a fully split headless session reports half the naive token total', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'orch-metrics-'))
    const jsonl = path.join(dir, 'split.jsonl')
    await writeFile(jsonl, [
      row({ id: 'msg_A', model: 'claude-haiku-4-5', input: 5, output: 205, cacheRead: 18171 }),
      row({ id: 'msg_A', model: 'claude-haiku-4-5', input: 5, output: 205, cacheRead: 18171 }),
      row({ id: 'msg_B', model: 'claude-haiku-4-5', input: 7, output: 345, cacheRead: 21210 }),
      row({ id: 'msg_B', model: 'claude-haiku-4-5', input: 7, output: 345, cacheRead: 21210 }),
    ].join('\n') + '\n', 'utf8')

    const col = await collectorFor([session({ jsonlPath: jsonl })])
    const res = await col.query({ groupBy: 'session' })

    const deduped = (5 + 205 + 18171) + (7 + 345 + 21210)
    expect(res.total.tokens).toBe(deduped)
    expect(res.buckets).toHaveLength(1)
    expect(res.buckets[0]!.tokens).toBe(deduped)
  })

  it('a session that changed model mid-way is priced per event, not at the final rate', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'orch-metrics-'))
    const jsonl = path.join(dir, 'mixed.jsonl')
    await writeFile(jsonl, [
      row({ id: 'm1', model: 'claude-opus-5', ts: '2026-09-11T10:01:00.000Z', input: 1_000_000, output: 1_000_000 }),
      row({ id: 'm2', model: 'claude-opus-5', ts: '2026-09-11T10:02:00.000Z', input: 1_000_000, output: 1_000_000 }),
      row({ id: 'm3', model: 'claude-opus-5', ts: '2026-09-11T10:03:00.000Z', input: 1_000_000, output: 1_000_000 }),
      row({ id: 'm4', model: 'claude-sonnet-5', ts: '2026-09-11T10:04:00.000Z', input: 1_000_000, output: 1_000_000 }),
    ].join('\n') + '\n', 'utf8')

    const col = await collectorFor([session({ id: 'sess-nf10', jsonlPath: jsonl, model: 'claude-sonnet-5' })])
    const res = await col.query({ groupBy: 'session' })

    const opusTurn = computeCost({ input: 1_000_000, output: 1_000_000 }, 'claude-opus-5')
    const sonnetTurn = computeCost({ input: 1_000_000, output: 1_000_000 }, 'claude-sonnet-5')
    expect(res.total.cost_usd).toBeCloseTo(opusTurn * 3 + sonnetTurn, 9)

    // Session-level attribution is unchanged: still the last billed model.
    const byModel = await col.query({ groupBy: 'model' })
    expect(byModel.buckets.map((b) => b.key)).toEqual(['claude-sonnet-5'])
  })
})
