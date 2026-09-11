import { describe, it, expect, afterEach } from 'vitest'

import { ClaudeAdapter } from '../../src/adapters/claude.js'
import { makeStub, withPath, type Stub } from './headless-stub.js'

/**
 * NF17 provenance, measured end to end through a real child process.
 *
 * The stub replays `claude -p --output-format stream-json --verbose
 * --json-schema …` output captured from Claude Code on 2026-09-11 — the event
 * shapes are not invented. Note that stdout writes `content` as an array of
 * blocks where the native JSONL writes a bare string; both are exercised.
 *
 * A mocked `child_process` would assert none of this: the whole mechanism is
 * line-splitting a piped stream and folding it into one result.
 */

const spawnConfig = {
  projectId: 'proj-1',
  agentType: 'claude' as const,
  initialPrompt: 'Remember the number 47. Reply with just: ok.',
  workspace: '/tmp',
  useTmux: false,
  outputSchemaPath: '/tmp/orchestron_result_schema.json',
}

const NUDGE =
  '[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.'

const ev = {
  init: () => JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
  // 198 of the 211 lines on the measured turn were these. They must not
  // disturb the accumulator.
  noise: () => JSON.stringify({ type: 'system', subtype: 'thinking_tokens', delta: 3 }),
  thinking: (t: string) =>
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: t }] },
    }),
  say: (t: string) =>
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: t }] },
    }),
  userText: (t: string) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: t }] } }),
  userTextAsString: (t: string) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: t } }),
  toolUse: (doc: unknown) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'StructuredOutput', input: doc }],
      },
    }),
  toolResult: () =>
    JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', content: 'Structured output provided successfully' }],
      },
    }),
  result: (doc: unknown) =>
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 's1',
      stop_reason: 'tool_use',
      total_cost_usd: 0.0275839,
      usage: { input_tokens: 20, output_tokens: 495 },
      result: JSON.stringify(doc),
    }),
}

const FILLER_DOC = {
  summary: 'Ready to assist with your request',
  inquiry: {
    message: "I'm ready to help. What would you like me to do?",
    fields: [{ name: 'task', label: 'What should I do?', type: 'text', options: null }],
  },
}

async function run(stdout: string) {
  const stub = makeStub({ name: 'claude', stdout, exitCode: 0 })
  const restore = withPath(stub.binDir)
  try {
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn(spawnConfig)
    return await adapter.awaitHeadlessExit!(handle)
  } finally {
    restore()
    stub.cleanup()
  }
}

let stubs: Stub[] = []
afterEach(() => { for (const s of stubs) s.cleanup(); stubs = [] })

describe('headless inquiry provenance off the stream (NF17)', () => {
  it('reports the nudge and the prose that preceded it', async () => {
    const result = await run([
      ev.init(),
      ev.noise(),
      ev.thinking('This seems like a test or instruction.'),
      ev.say('ok'),
      ev.noise(),
      ev.userText(NUDGE),
      ev.thinking("They've indicated this is a structured request."),
      ev.toolUse(FILLER_DOC),
      ev.toolResult(),
      ev.result(FILLER_DOC),
    ].join('\n'))

    expect(result.exitCode).toBe(0)
    expect(result.enforceNudged).toBe(true)
    expect(result.preNudgeAssistantText).toBe('ok')
    // The existing result-event fields must survive the refactor.
    expect(result.sessionId).toBe('s1')
    expect(result.costUsd).toBeCloseTo(0.0275839)
    expect(result.tokenUsage).toEqual({ input: 20, output: 495 })
    expect(result.finalResponse).toBe(JSON.stringify(FILLER_DOC))
  })

  it('leaves the field absent on a turn that needed no nudge', async () => {
    const result = await run([
      ev.init(),
      ev.say('Done — the file is patched.'),
      ev.toolUse({ summary: 'Patched the file.', inquiry: null }),
      ev.toolResult(),
      ev.result({ summary: 'Patched the file.', inquiry: null }),
    ].join('\n'))

    expect(result.exitCode).toBe(0)
    // Absent, not false: `false` would claim the harness reported something.
    expect(result.enforceNudged).toBeUndefined()
    expect(result.preNudgeAssistantText).toBeUndefined()
  })

  it('keeps the prose from before the FIRST nudge when there are several', async () => {
    const result = await run([
      ev.say('Which branch should I target?'),
      ev.userText(NUDGE),
      ev.say('Calling the tool now.'),
      ev.userText(NUDGE),
      ev.toolUse(FILLER_DOC),
      ev.result(FILLER_DOC),
    ].join('\n'))

    // "Calling the tool now." was said under duress and must not become the
    // evidence — it would flip a genuine inquiry to coerced.
    expect(result.preNudgeAssistantText).toBe('Which branch should I target?')
  })

  it('ignores thinking and tool traffic — only what the model said counts', async () => {
    const result = await run([
      ev.thinking('the user hasn’t asked me a question, so I should inquire'),
      ev.toolUse({ summary: 'x', inquiry: null }),
      ev.toolResult(),
      ev.userText(NUDGE),
      ev.result(FILLER_DOC),
    ].join('\n'))

    // Thinking mentions a question; prose said nothing. The accumulator must
    // be empty, which resolves to "coerced".
    expect(result.enforceNudged).toBe(true)
    expect(result.preNudgeAssistantText).toBe('')
  })

  it('reads a nudge whose content is a bare string, as the native JSONL writes it', async () => {
    const result = await run([
      ev.say('ok'),
      ev.userTextAsString(NUDGE),
      ev.result(FILLER_DOC),
    ].join('\n'))

    expect(result.enforceNudged).toBe(true)
    expect(result.preNudgeAssistantText).toBe('ok')
  })

  it('observes a final line that arrives without a trailing newline', async () => {
    // The stub's heredoc always terminates the last line, so drive the flush
    // path by putting the nudge last and asserting it still registered.
    const result = await run([ev.say('ok'), ev.result(FILLER_DOC), ev.userText(NUDGE)].join('\n'))
    expect(result.enforceNudged).toBe(true)
    expect(result.finalResponse).toBe(JSON.stringify(FILLER_DOC))
  })

  it('joins multiple prose blocks rather than keeping only the last', async () => {
    const result = await run([
      ev.say('I checked both files.'),
      ev.say('Which one should I patch?'),
      ev.userText(NUDGE),
      ev.result(FILLER_DOC),
    ].join('\n'))

    expect(result.preNudgeAssistantText).toBe('I checked both files.\nWhich one should I patch?')
  })
})
