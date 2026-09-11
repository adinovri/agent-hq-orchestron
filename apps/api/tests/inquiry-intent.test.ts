import { describe, it, expect } from 'vitest'
import {
  textAsksQuestion,
  isCoercedInquiry,
  STRUCTURED_OUTPUT_ENFORCE_PREFIX,
} from '@agent-hq-orchestron/shared'

describe('textAsksQuestion', () => {
  // These are the cases the API's local copy covered before the helper moved
  // to shared; kept so the move is provably behaviour-preserving.
  it('reads a trailing question mark', () => {
    expect(textAsksQuestion('Which file should I edit?')).toBe(true)
    expect(textAsksQuestion('Done.')).toBe(false)
  })

  it('reads the phrases people use when handing a decision back', () => {
    expect(textAsksQuestion('Would you like me to push it?')).toBe(true)
    expect(textAsksQuestion('Let me know how you want to proceed.')).toBe(true)
    expect(textAsksQuestion('Shall I continue')).toBe(true)
    expect(textAsksQuestion('Please confirm before I delete anything')).toBe(true)
  })

  it('is not fooled by empty or whitespace prose', () => {
    expect(textAsksQuestion('')).toBe(false)
    expect(textAsksQuestion('   \n  ')).toBe(false)
  })
})

describe('isCoercedInquiry (NF17)', () => {
  // Verbatim from a measured run: prompt `Remember the number 47. Reply with
  // just: ok.`, prose reply `ok`, then the enforce nudge, then a document
  // whose `inquiry` the model invented because the schema had a slot for it.
  const MEASURED_FILLER = "I'm ready to help. What would you like me to do?"

  it('discards an inquiry that only exists because the tool call was coerced', () => {
    expect(
      isCoercedInquiry({ enforceNudged: true, preNudgeAssistantText: 'ok' }),
    ).toBe(true)
  })

  it('cannot be caught linguistically — which is why provenance is the test', () => {
    // The filler IS a well-formed question and matches the phrase list. Any
    // heuristic reading `inquiry.message` alone would keep it.
    expect(textAsksQuestion(MEASURED_FILLER)).toBe(true)
    expect(isCoercedInquiry({ enforceNudged: true, preNudgeAssistantText: 'ok' })).toBe(true)
  })

  it('believes an inquiry the model raised without being nudged', () => {
    expect(isCoercedInquiry({})).toBe(false)
    expect(isCoercedInquiry({ enforceNudged: false })).toBe(false)
    // Absent rather than false is the Codex case: no nudge is ever reported,
    // so its inquiries must keep working untouched.
    expect(isCoercedInquiry({ preNudgeAssistantText: 'ok' })).toBe(false)
  })

  it('keeps a genuine inquiry that arrived late — the model asked in prose first', () => {
    expect(
      isCoercedInquiry({
        enforceNudged: true,
        preNudgeAssistantText: 'I found two candidates. Which one should I patch?',
      }),
    ).toBe(false)
    expect(
      isCoercedInquiry({
        enforceNudged: true,
        preNudgeAssistantText: 'Let me know whether to force-push.',
      }),
    ).toBe(false)
  })

  it('discards when the nudge came with no prose at all to judge', () => {
    // The model went straight to tool calls and said nothing. There is no
    // evidence it wanted anything, and the failure mode being fixed is a
    // session parked forever — so silence resolves to `idle`, which still
    // accepts input.
    expect(isCoercedInquiry({ enforceNudged: true })).toBe(true)
    expect(isCoercedInquiry({ enforceNudged: true, preNudgeAssistantText: '' })).toBe(true)
  })

  it('pins the nudge prefix against the harness string', () => {
    expect(STRUCTURED_OUTPUT_ENFORCE_PREFIX).toBe('[structured-output-enforce]')
    expect(
      '[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.',
    ).toContain(STRUCTURED_OUTPUT_ENFORCE_PREFIX)
  })
})
