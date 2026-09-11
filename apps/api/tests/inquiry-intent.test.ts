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

  /**
   * NF19. The detector used to open with `/\?\s*$/` — a `?` anchored to the end
   * of the *whole string*. Over 6 runs of the official inquiry prompt
   * (`00-setup.md` §5) three genuine inquiries were discarded because the model
   * asked inside a list and signed off with a non-question line, and the one
   * that survived matched `/would you like/i` by accident of diction.
   *
   * The four texts below are the measured shapes: three that must be read as
   * asking, and the NF17 filler prose that must still be read as not asking.
   * A `/m` flag would not rescue the first three — those question lines end in
   * `)`, not `?`.
   */
  describe('NF19 — a question anywhere, not only at the end', () => {
    // ab519055: two questions in a list, closing line is not a question.
    const IN_A_LIST = [
      'Before I deploy I need two things from you:',
      '',
      '1. Which environment? (staging or production)',
      '2. Which region? (ap-southeast-1 or us-east-1)',
      '',
      'I will proceed once both are settled.',
    ].join('\n')

    // 2fd57f61: same shape, prose paragraph rather than a list.
    const MID_PARAGRAPH =
      'Which environment are you deploying to? I also need the region ' +
      'before I can pick the right credentials file.'

    // A question followed by a trailing parenthetical — the exact reason the
    // multiline anchor was measured and rejected.
    const TRAILING_PAREN = 'Which environment should I target? (staging or production)'

    // 5a71b81a: the NF17 true positive. Model had finished; prose carries no
    // question at all, so the coerced inquiry is still rubbish.
    const FINISHED_PROSE = 'ready'

    it('reads a question asked inside a list', () => {
      expect(textAsksQuestion(IN_A_LIST)).toBe(true)
    })

    it('reads a question asked mid-paragraph', () => {
      expect(textAsksQuestion(MID_PARAGRAPH)).toBe(true)
    })

    it('reads a question followed by a parenthetical', () => {
      expect(textAsksQuestion(TRAILING_PAREN)).toBe(true)
      // Pin why `/m` is not the fix: the line does not END with `?`.
      expect(/\?\s*$/m.test(TRAILING_PAREN)).toBe(false)
    })

    it('still reads finished prose as not asking — NF17 is preserved', () => {
      expect(textAsksQuestion(FINISHED_PROSE)).toBe(false)
      expect(textAsksQuestion('ok')).toBe(false)
    })

    it('keeps all three genuine inquiries and discards the filler', () => {
      // The whole table from the sweep, in one assertion.
      const keep = [IN_A_LIST, MID_PARAGRAPH, TRAILING_PAREN]
      for (const prose of keep) {
        expect(isCoercedInquiry({ enforceNudged: true, preNudgeAssistantText: prose })).toBe(false)
      }
      for (const prose of [FINISHED_PROSE, 'ok']) {
        expect(isCoercedInquiry({ enforceNudged: true, preNudgeAssistantText: prose })).toBe(true)
      }
    })

    it('accepts the cost: a rhetorical question now reads as asking', () => {
      // Documented, not desired. On the tmux path this lands `needs_input` on
      // a finished summary, and `needs_input` is exempt from the idle sweeper.
      // Pinned so the trade-off is visible if anyone revisits the pattern.
      expect(textAsksQuestion('Why did it fail? Stale config. Fixed now.')).toBe(true)
    })
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
