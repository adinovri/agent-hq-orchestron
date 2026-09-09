import { describe, it, expect } from 'vitest'
import { ORCHESTRON_RESULT_SCHEMA_JSON } from '@agent-hq-orchestron/shared'
import { buildHeadlessArgv } from '../src/adapters/claude.js'
import { buildCodexExecArgv } from '../src/adapters/codex.js'

/**
 * Structured output is requested through a CLI flag and nothing else.
 *
 * The operator reported a "structured-output enforce message" showing up in a
 * headless transcript. The audit found the API innocent — the schema has
 * always travelled on `--json-schema` / `--output-schema`, and the leak was
 * the harness plumbing rendered downstream (see
 * structured-output-transcript.test.ts). These tests keep it that way: the
 * cheapest way to reintroduce that bug would be to append "you must answer
 * with {summary, inquiry}" to the prompt, so that is what they forbid.
 */

const PROMPT = 'Kmu bisa ngapain aja?'

describe('structured output is requested by flag only', () => {
  it('claude: the prompt argument is passed through byte-identical', () => {
    const withSchema = buildHeadlessArgv({
      prompt: PROMPT,
      structuredOutput: true,
      sessionMode: { type: 'new', uuid: 'u1' },
    })
    const withoutSchema = buildHeadlessArgv({
      prompt: PROMPT,
      sessionMode: { type: 'new', uuid: 'u1' },
    })

    // The prompt is the final argument, after the `--` terminator.
    expect(withSchema[withSchema.length - 1]).toBe(PROMPT)
    expect(withoutSchema[withoutSchema.length - 1]).toBe(PROMPT)

    // Turning the schema on adds exactly the flag and its value. If a future
    // change appends "you must answer with {summary, inquiry}" to the prompt
    // — the shape of leak this suite exists to prevent — this fails.
    const added = withSchema.filter((a) => !withoutSchema.includes(a))
    expect(added).toEqual(['--json-schema', ORCHESTRON_RESULT_SCHEMA_JSON])
  })

  it('claude: no argv element other than the flag value mentions the schema', () => {
    const argv = buildHeadlessArgv({
      prompt: PROMPT,
      structuredOutput: true,
      sessionMode: { type: 'new', uuid: 'u1' },
    })
    const flagIdx = argv.indexOf('--json-schema')
    expect(flagIdx).toBeGreaterThan(-1)
    const elsewhere = argv.filter((_, i) => i !== flagIdx + 1)
    expect(elsewhere.some((a) => a.includes('summary') || a.includes('inquiry'))).toBe(false)
  })

  it('codex: the schema is a file path, and the prompt is untouched', () => {
    const withSchema = buildCodexExecArgv({
      prompt: PROMPT,
      outputSchemaPath: '/data/orchestron_result_schema.json',
    })
    const withoutSchema = buildCodexExecArgv({ prompt: PROMPT })

    expect(withSchema[withSchema.length - 1]).toBe(PROMPT)
    const added = withSchema.filter((a) => !withoutSchema.includes(a))
    expect(added).toEqual(['--output-schema', '/data/orchestron_result_schema.json'])
  })
})
