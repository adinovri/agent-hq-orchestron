import { describe, it, expect } from 'vitest'
import {
  normalizeStructuredOutputTranscript,
  parseHeadlessResultDocument,
  STRUCTURED_OUTPUT_TOOL_NAME,
  type TranscriptEntryLike,
} from '@agent-hq-orchestron/shared'
import { parseClaudeRollout } from '../src/routes/sessions.js'

/**
 * Turning the schema on makes each harness leave machinery in the transcript
 * that is addressed to orchestron, not to the person reading the pane:
 * Claude synthesises a `StructuredOutput` tool call carrying the raw
 * `{summary, inquiry}` document plus a canned tool_result, while Codex has no
 * tool at all and simply makes the document its final message.
 *
 * Rendered verbatim, that is exactly what the operator saw on 2026-09-10 —
 * enforcement chatter and a raw JSON block where the answer belonged.
 *
 * Fixtures are trimmed from real runs: Claude Code 2.1.267 and codex-cli
 * 0.153.4, captured 2026-09-10.
 */

const PROMPT = 'Kmu bisa ngapain aja?'

const DOC = { summary: 'Listed what I can do.', inquiry: null }
const DOC_JSON = JSON.stringify(DOC)

function entry(e: Partial<TranscriptEntryLike> & { kind: TranscriptEntryLike['kind'] }): TranscriptEntryLike {
  return { seq: 0, timestamp: '2026-09-10T00:00:00.000Z', content: '', ...e }
}

describe('normalizeStructuredOutputTranscript — claude shape', () => {
  /** What Claude 2.1.267 actually writes with `--json-schema`: the prose
   *  answer, then a synthesised `StructuredOutput` tool call carrying the
   *  document, then a canned tool_result. */
  const claudeEntries: TranscriptEntryLike[] = [
    entry({ seq: 0, kind: 'user', content: PROMPT }),
    entry({ seq: 1, kind: 'assistant', content: 'Gue bisa baca kode, jalanin test, dan deploy.' }),
    entry({ seq: 2, kind: 'tool_use', toolName: STRUCTURED_OUTPUT_TOOL_NAME, content: DOC_JSON }),
    entry({ seq: 3, kind: 'tool_result', content: 'Structured output provided successfully' }),
  ]

  it('drops the tool call and its canned result, keeping the prose', () => {
    const out = normalizeStructuredOutputTranscript(claudeEntries)
    expect(out.map((e) => e.kind)).toEqual(['user', 'assistant'])
    expect(out[1]!.content).toBe('Gue bisa baca kode, jalanin test, dan deploy.')
  })

  it('leaves no trace of the raw document', () => {
    const out = normalizeStructuredOutputTranscript(claudeEntries)
    const all = out.map((e) => e.content).join('\n')
    expect(all).not.toContain('"inquiry"')
    expect(all).not.toContain('Structured output provided successfully')
  })

  it('promotes the summary when the model answered only through the tool', () => {
    const out = normalizeStructuredOutputTranscript([
      entry({ seq: 0, kind: 'user', content: PROMPT }),
      entry({ seq: 1, kind: 'tool_use', toolName: STRUCTURED_OUTPUT_TOOL_NAME, content: DOC_JSON }),
      entry({ seq: 2, kind: 'tool_result', content: 'Structured output provided successfully' }),
    ])
    // A turn must never render empty just because the prose was skipped.
    expect(out.map((e) => e.kind)).toEqual(['user', 'assistant'])
    expect(out[1]!.content).toBe('Listed what I can do.')
    expect(out[1]!.toolName).toBeUndefined()
  })

  it('keeps seq values stable so client keys survive', () => {
    const out = normalizeStructuredOutputTranscript(claudeEntries)
    expect(out.map((e) => e.seq)).toEqual([0, 1])
  })

  it('does not touch other tools or their results', () => {
    const out = normalizeStructuredOutputTranscript([
      entry({ seq: 0, kind: 'tool_use', toolName: 'Bash', content: '{"command":"ls"}' }),
      entry({ seq: 1, kind: 'tool_result', content: 'a.txt' }),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]!.toolName).toBe('Bash')
  })

  it('works end to end against a real claude JSONL fixture', () => {
    const jsonl = [
      '{"type":"user","timestamp":"2026-09-10T06:00:00.000Z","message":{"content":"Kmu bisa ngapain aja?"}}',
      '{"type":"attachment","timestamp":"2026-09-10T06:00:00.100Z","attachment":{"type":"model"}}',
      '{"type":"assistant","timestamp":"2026-09-10T06:00:05.000Z","message":{"content":[{"type":"text","text":"Gue Claude Code."}],"usage":{"input_tokens":3,"output_tokens":9}}}',
      `{"type":"assistant","timestamp":"2026-09-10T06:00:06.000Z","message":{"content":[{"type":"tool_use","name":"StructuredOutput","input":${DOC_JSON}}],"usage":{"input_tokens":3,"output_tokens":9}}}`,
      '{"type":"user","timestamp":"2026-09-10T06:00:06.200Z","message":{"content":[{"type":"tool_result","content":"Structured output provided successfully"}]}}',
    ].join('\n')

    const parsed = parseClaudeRollout(jsonl)
    // The parser itself is unchanged — the plumbing is still in its output.
    expect(parsed.entries.some((e) => e.toolName === STRUCTURED_OUTPUT_TOOL_NAME)).toBe(true)

    const out = normalizeStructuredOutputTranscript(parsed.entries)
    expect(out.map((e) => e.kind)).toEqual(['user', 'assistant'])
    expect(out[1]!.content).toBe('Gue Claude Code.')
  })
})

describe('normalizeStructuredOutputTranscript — codex shape', () => {
  it('rewrites an agent message that is the raw document to its summary', () => {
    // Codex has no tool: the final message IS the document.
    const out = normalizeStructuredOutputTranscript([
      entry({ seq: 0, kind: 'user', content: 'Say hi briefly' }),
      entry({ seq: 1, kind: 'assistant', content: '{"summary":"Hi!","inquiry":null}' }),
    ])
    expect(out).toHaveLength(2)
    expect(out[1]!.kind).toBe('assistant')
    expect(out[1]!.content).toBe('Hi!')
  })

  it('tolerates whitespace and pretty-printed documents', () => {
    const out = normalizeStructuredOutputTranscript([
      entry({ seq: 0, kind: 'assistant', content: `\n  ${JSON.stringify(DOC, null, 2)}\n` }),
    ])
    expect(out[0]!.content).toBe('Listed what I can do.')
  })
})

describe('normalizeStructuredOutputTranscript — what it must NOT rewrite', () => {
  it('leaves prose alone', () => {
    const prose = 'Here is the answer.\n\n```json\n{"summary":"nope"}\n```'
    const out = normalizeStructuredOutputTranscript([entry({ seq: 0, kind: 'assistant', content: prose })])
    expect(out[0]!.content).toBe(prose)
  })

  it('leaves a JSON answer that merely has a summary key alone', () => {
    // An agent legitimately asked to answer in JSON. Rewriting this to its
    // `summary` would destroy the answer, so an object carrying keys beyond
    // ours is not our document.
    const answer = '{"summary":"ok","rows":[1,2,3]}'
    const out = normalizeStructuredOutputTranscript([entry({ seq: 0, kind: 'assistant', content: answer })])
    expect(out[0]!.content).toBe(answer)
  })

  it('leaves a JSON array alone', () => {
    const arr = '[{"summary":"a"},{"summary":"b"}]'
    const out = normalizeStructuredOutputTranscript([entry({ seq: 0, kind: 'assistant', content: arr })])
    expect(out[0]!.content).toBe(arr)
  })

  it('leaves a user message alone even when it is a document', () => {
    // The operator can legitimately paste one back in.
    const out = normalizeStructuredOutputTranscript([entry({ seq: 0, kind: 'user', content: DOC_JSON })])
    expect(out[0]!.content).toBe(DOC_JSON)
  })

  it('is a no-op on a transcript with no structured output at all', () => {
    const plain = [
      entry({ seq: 0, kind: 'user', content: 'hello' }),
      entry({ seq: 1, kind: 'assistant', content: 'hi there' }),
      entry({ seq: 2, kind: 'tool_use', toolName: 'Bash', content: '{"command":"ls"}' }),
      entry({ seq: 3, kind: 'tool_result', content: 'a.txt' }),
    ]
    expect(normalizeStructuredOutputTranscript(plain)).toEqual(plain)
  })

  it('is idempotent', () => {
    const once = normalizeStructuredOutputTranscript([
      entry({ seq: 0, kind: 'assistant', content: 'prose' }),
      entry({ seq: 1, kind: 'tool_use', toolName: STRUCTURED_OUTPUT_TOOL_NAME, content: DOC_JSON }),
      entry({ seq: 2, kind: 'tool_result', content: 'Structured output provided successfully' }),
    ])
    expect(normalizeStructuredOutputTranscript(once)).toEqual(once)
  })
})

describe('inquiry rendering survives normalisation', () => {
  const inquiryDoc = JSON.stringify({
    summary: 'I need the target environment before I can continue.',
    inquiry: {
      message: 'Which environment should I deploy to?',
      fields: [{ name: 'env', label: 'Environment', type: 'choice', options: ['dev', 'stg'] }],
    },
  })

  it('the transcript shows the summary and none of the inquiry payload', () => {
    const out = normalizeStructuredOutputTranscript([
      entry({ seq: 0, kind: 'assistant', content: 'Sebelum lanjut gue butuh satu info.' }),
      entry({ seq: 1, kind: 'tool_use', toolName: STRUCTURED_OUTPUT_TOOL_NAME, content: inquiryDoc }),
      entry({ seq: 2, kind: 'tool_result', content: 'Structured output provided successfully' }),
    ])
    const all = out.map((e) => e.content).join('\n')
    expect(all).not.toContain('"fields"')
    expect(all).not.toContain('Which environment should I deploy to?')
  })

  it('the record still parses an inquiry out of the same document', () => {
    // InquiryCard renders from `session.pendingInquiry`, which the
    // session-manager sets from this parse — a separate path that the
    // transcript normaliser does not touch.
    const doc = parseHeadlessResultDocument(inquiryDoc)
    expect(doc.inquiry?.message).toBe('Which environment should I deploy to?')
    expect(doc.inquiry?.fields[0]?.options).toEqual(['dev', 'stg'])
    expect(doc.summary).toBe('I need the target environment before I can continue.')
  })

  it('a codex-shaped inquiry document renders as its summary', () => {
    const out = normalizeStructuredOutputTranscript([
      entry({ seq: 0, kind: 'assistant', content: inquiryDoc }),
    ])
    expect(out[0]!.content).toBe('I need the target environment before I can continue.')
  })
})

describe('normalizeStructuredOutputTranscript — the enforcement turn (F2)', () => {
  /** Claude Code's nudge, verbatim from a 2026-09-10 headless run. */
  const ENFORCE =
    '[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.'

  /** Single-turn headless: prompt → prose → nudge → acknowledgement → tool.
   *  This is what came back contiguous `0,1,2,3` in the sweep, with the last
   *  two entries being exactly the pair below. */
  it('drops the nudge and the reply it provoked, keeping the real answer', () => {
    const out = normalizeStructuredOutputTranscript([
      entry({ seq: 0, kind: 'user', content: 'Ingat angka 47.' }),
      entry({ seq: 1, kind: 'assistant', content: 'Oke, 47 gue inget.' }),
      entry({ seq: 2, kind: 'user', content: ENFORCE }),
      entry({ seq: 3, kind: 'assistant', content: 'Remembered the number 47 and replied as requested.' }),
      entry({ seq: 4, kind: 'tool_use', toolName: STRUCTURED_OUTPUT_TOOL_NAME, content: DOC_JSON }),
      entry({ seq: 5, kind: 'tool_result', content: 'Structured output provided successfully' }),
    ])
    expect(out.map((e) => e.kind)).toEqual(['user', 'assistant'])
    expect(out[0]!.content).toBe('Ingat angka 47.')
    expect(out[1]!.content).toBe('Oke, 47 gue inget.')
  })

  it('leaves no trace of the enforcement string anywhere', () => {
    const out = normalizeStructuredOutputTranscript([
      entry({ seq: 0, kind: 'user', content: 'Ingat angka 47.' }),
      entry({ seq: 1, kind: 'assistant', content: 'Oke.' }),
      entry({ seq: 2, kind: 'user', content: ENFORCE }),
      entry({ seq: 3, kind: 'assistant', content: 'Remembered the number 47 and replied as requested.' }),
    ])
    expect(out.map((e) => e.content).join('\n')).not.toContain('structured-output-enforce')
  })

  /** The sub-symptom the sweep found only on the multi-turn session: a `seq`
   *  gap where a mid-transcript entry was dropped. Pinning the multi-turn
   *  shape is what makes this test cover it — the single-turn case never
   *  strips anything but a tail. */
  it('strips one pair per turn and leaves every real turn intact (multi-turn)', () => {
    const out = normalizeStructuredOutputTranscript([
      entry({ seq: 0, kind: 'user', content: 'Ingat angka 47.' }),
      entry({ seq: 1, kind: 'assistant', content: 'Oke, 47 gue inget.' }),
      entry({ seq: 2, kind: 'user', content: ENFORCE }),
      entry({ seq: 3, kind: 'assistant', content: 'Remembered the number 47.' }),
      entry({ seq: 4, kind: 'tool_use', toolName: STRUCTURED_OUTPUT_TOOL_NAME, content: DOC_JSON }),
      entry({ seq: 5, kind: 'tool_result', content: 'Structured output provided successfully' }),
      entry({ seq: 6, kind: 'user', content: 'Angka berapa tadi?' }),
      entry({ seq: 7, kind: 'assistant', content: '47.' }),
      entry({ seq: 8, kind: 'user', content: ENFORCE }),
      entry({ seq: 9, kind: 'assistant', content: 'Recalled the number as requested.' }),
      entry({ seq: 10, kind: 'tool_use', toolName: STRUCTURED_OUTPUT_TOOL_NAME, content: DOC_JSON }),
      entry({ seq: 11, kind: 'tool_result', content: 'Structured output provided successfully' }),
    ])
    expect(out.map((e) => e.content)).toEqual([
      'Ingat angka 47.',
      'Oke, 47 gue inget.',
      'Angka berapa tadi?',
      '47.',
    ])
    // Gaps are expected and deliberate — `seq` is a React key, never rendered.
    expect(out.map((e) => e.seq)).toEqual([0, 1, 6, 7])
  })

  it('drops a trailing nudge whose reply has not landed yet', () => {
    // The poll can catch the transcript between the two halves.
    const out = normalizeStructuredOutputTranscript([
      entry({ seq: 0, kind: 'assistant', content: 'Oke.' }),
      entry({ seq: 1, kind: 'user', content: ENFORCE }),
    ])
    expect(out.map((e) => e.content)).toEqual(['Oke.'])
  })

  it('takes only the adjacent reply, not the next real user turn', () => {
    const out = normalizeStructuredOutputTranscript([
      entry({ seq: 0, kind: 'user', content: ENFORCE }),
      entry({ seq: 1, kind: 'user', content: 'Angka berapa tadi?' }),
      entry({ seq: 2, kind: 'assistant', content: '47.' }),
    ])
    expect(out.map((e) => e.content)).toEqual(['Angka berapa tadi?', '47.'])
  })

  it('promotes the summary when the nudge consumed the only prose', () => {
    // With the acknowledgement gone there is nothing before the tool call, so
    // the turn must not render empty.
    const out = normalizeStructuredOutputTranscript([
      entry({ seq: 0, kind: 'user', content: 'Ingat angka 47.' }),
      entry({ seq: 1, kind: 'user', content: ENFORCE }),
      entry({ seq: 2, kind: 'assistant', content: 'Remembered the number 47.' }),
      entry({ seq: 3, kind: 'tool_use', toolName: STRUCTURED_OUTPUT_TOOL_NAME, content: DOC_JSON }),
      entry({ seq: 4, kind: 'tool_result', content: 'Structured output provided successfully' }),
    ])
    expect(out.map((e) => e.kind)).toEqual(['user', 'assistant'])
    expect(out[1]!.content).toBe('Listed what I can do.')
  })

  it('leaves a user turn that merely mentions the marker alone', () => {
    // The operator asking about the leak is not the leak.
    const asking = 'kenapa transcript gue ada [structured-output-enforce] ya?'
    const out = normalizeStructuredOutputTranscript([entry({ seq: 0, kind: 'user', content: asking })])
    expect(out.map((e) => e.content)).toEqual([asking])
  })

  it('is idempotent over the enforcement pair', () => {
    const input = [
      entry({ seq: 0, kind: 'user', content: 'Ingat angka 47.' }),
      entry({ seq: 1, kind: 'assistant', content: 'Oke.' }),
      entry({ seq: 2, kind: 'user', content: ENFORCE }),
      entry({ seq: 3, kind: 'assistant', content: 'Remembered.' }),
    ]
    const once = normalizeStructuredOutputTranscript(input)
    expect(normalizeStructuredOutputTranscript(once)).toEqual(once)
  })

  /** Regression guard for the gate in the route: a tmux session never sees
   *  the schema, so its transcript must reach the client byte-identical. The
   *  route decides this (`session.useTmux === false`), but a tmux transcript
   *  put through the normaliser anyway must still come out unchanged — that is
   *  what makes the gate a belt rather than the only thing holding the trousers
   *  up. */
  it('is a no-op on a tmux-shaped transcript', () => {
    const tmux = [
      entry({ seq: 0, kind: 'user', content: 'jalanin test dong' }),
      entry({ seq: 1, kind: 'assistant', content: 'Oke, gue jalanin.' }),
      entry({ seq: 2, kind: 'tool_use', toolName: 'Bash', content: '{"command":"npm test"}' }),
      entry({ seq: 3, kind: 'tool_result', content: '42 passed' }),
      entry({ seq: 4, kind: 'assistant', content: 'Semua 42 test lulus.' }),
      entry({ seq: 5, kind: 'user', content: 'sip' }),
    ]
    expect(normalizeStructuredOutputTranscript(tmux)).toEqual(tmux)
  })
})
