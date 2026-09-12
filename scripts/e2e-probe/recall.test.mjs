/**
 * The fixture is a real two-turn headless transcript, seqs and all:
 *   1 user      "Reply with the single word: ready."
 *   2 assistant "ready"
 *   3/4         a tool pair, because real transcripts have them
 *   5 user      RESUME_NUDGE          ← Claude Code, not the operator
 *   6 assistant RESUME_NUDGE_REPLY    ← guard 1 must skip this
 *   7 user      "what was that word?"
 *   8 assistant "ready"               ← the only correct answer
 *
 * Every test here asks the same question the sweep asks: does the probe score
 * the model's words, or something that merely looks like them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  findRecallAnswer, assertRecall, maxSeq, resumeMetaRole,
  RESUME_NUDGE, RESUME_NUDGE_REPLY,
} from './recall.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const u = (seq, content) => ({ seq, kind: 'user', content })
const a = (seq, content) => ({ seq, kind: 'assistant', content })

const TURN1 = [
  u(1, 'Reply with the single word: ready. Do nothing else.'),
  a(2, 'ready'),
  { seq: 3, kind: 'tool_use', content: 'Read(/tmp/x)' },
  { seq: 4, kind: 'tool_result', content: 'ok' },
]
const RESUME = [u(5, RESUME_NUDGE), a(6, RESUME_NUDGE_REPLY)]
const TURN2 = [
  u(7, 'In my very first message I asked you to reply with one specific word. What was it?'),
  a(8, 'ready'),
]
const FULL = [...TURN1, ...RESUME, ...TURN2]

/** What the session record carries for this conversation — a SUMMARY. NF39. */
const FINAL_RESPONSE_SUMMARY = 'Responded with the requested word.'

test('scores the transcript answer, not the summary that does not quote the word', () => {
  const r = assertRecall(FULL, { baselineSeq: 4, expect: /ready/i, finalResponse: FINAL_RESPONSE_SUMMARY })
  assert.equal(r.ok, true)
  assert.equal(r.seq, 8)
  assert.equal(r.text, 'ready')
  // The whole point: the field the old probe read would have failed this.
  assert.equal(/ready/i.test(FINAL_RESPONSE_SUMMARY), false)
  assert.match(r.detail, /summary\(NOT scored\)/)
})

test('guard 1 — the resume-nudge reply is never the answer', () => {
  // Turn 2 has not produced its assistant entry yet; seq 6 is the newest one.
  const r = findRecallAnswer([...TURN1, ...RESUME, TURN2[0]], { baselineSeq: 4 })
  assert.equal(r.answered, false)
  assert.match(r.reason, /no assistant entry past/)
  assert.deepEqual(r.skipped, [{ seq: 5, role: 'nudge' }, { seq: 6, role: 'reply' }])
})

test('guard 1 — the nudge pair is skipped even when it lands AFTER the real turn', () => {
  // Ordering is not contractual; the rule must be "is it the nudge", not "is
  // it early". Same entries, resume pair moved past the operator's turn.
  const reordered = [...TURN1, u(5, 'what was that word?'), a(6, 'ready'), u(7, RESUME_NUDGE), a(8, RESUME_NUDGE_REPLY)]
  const r = findRecallAnswer(reordered, { baselineSeq: 4 })
  assert.equal(r.answered, true)
  assert.equal(r.seq, 6)
  assert.equal(r.text, 'ready')
})

test('guard 2 — a stale baseline scores turn 1 VACUOUSLY, so the baseline is load-bearing', () => {
  // The actual mid-sweep false PASS: baseline 0 (or none), turn 2 not yet
  // persisted. Without guard 2 this reads turn 1's own answer back.
  const vacuous = findRecallAnswer(TURN1, { baselineSeq: 0 })
  assert.equal(vacuous.answered, true)
  assert.equal(vacuous.seq, 2)
  assert.equal(vacuous.userSeq, 1, 'this is turn 1 answering itself — a PASS here is the bug')
  // With the baseline actually read before sending, the same transcript is
  // correctly "the turn has not landed yet".
  const guarded = findRecallAnswer(TURN1, { baselineSeq: maxSeq(TURN1) })
  assert.equal(guarded.answered, false)
  assert.match(guarded.reason, /no user entry past seq 4/)
})

test('guard 2 — baselineSeq is required, never defaulted', () => {
  assert.throws(() => findRecallAnswer(FULL, {}), /baselineSeq must be a number/)
  assert.throws(() => findRecallAnswer(FULL), /baselineSeq must be a number/)
})

test('a wrong-word answer fails rather than passing on liveness alone', () => {
  const wrong = [...TURN1, ...RESUME, TURN2[0], a(8, 'I do not recall.')]
  const r = assertRecall(wrong, { baselineSeq: 4, expect: /ready/i })
  assert.equal(r.ok, false)
  assert.equal(r.answered, true, 'the turn landed; it is the CONTENT that is wrong')
  assert.equal(r.seq, 8)
})

test('entries arriving out of order are sorted before the scan', () => {
  const shuffled = [...FULL].reverse()
  const r = findRecallAnswer(shuffled, { baselineSeq: 4 })
  assert.equal(r.seq, 8)
  assert.deepEqual(r.skipped, [{ seq: 5, role: 'nudge' }, { seq: 6, role: 'reply' }])
})

test('a real answer that says "No response requested." is not mistaken for the nudge reply', () => {
  // Adjacency guard: only the entry immediately after the nudge is meta.
  const real = [...TURN1, ...RESUME, u(7, 'what was that word?'), a(8, 'No response requested.')]
  const r = findRecallAnswer(real, { baselineSeq: 4 })
  assert.equal(r.answered, true)
  assert.equal(r.seq, 8)
  assert.equal(resumeMetaRole(real[7], real[6]), null)
})

test('maxSeq tolerates an empty or seq-less transcript', () => {
  assert.equal(maxSeq([]), -1)
  assert.equal(maxSeq(undefined), -1)
  assert.equal(maxSeq([{ kind: 'user', content: 'x' }]), -1)
})

test('assertRecall refuses a non-RegExp expectation', () => {
  assert.throws(() => assertRecall(FULL, { baselineSeq: 4, expect: 'ready' }), /must be a RegExp/)
})

test('the nudge sentences match apps/web verbatim (drift tripwire)', () => {
  // Two copies exist because apps/web is TypeScript the probes cannot import.
  // If the product changes the sentence, the probe stops skipping the pair and
  // starts scoring "No response requested." as the answer — silently. This is
  // the cheapest thing that fails loudly instead.
  const src = fs.readFileSync(path.join(HERE, '../../apps/web/lib/transcript-entry.ts'), 'utf8')
  assert.ok(src.includes(`export const RESUME_NUDGE = '${RESUME_NUDGE}'`), 'RESUME_NUDGE drifted from apps/web/lib/transcript-entry.ts')
  assert.ok(src.includes(`export const RESUME_NUDGE_REPLY = '${RESUME_NUDGE_REPLY}'`), 'RESUME_NUDGE_REPLY drifted from apps/web/lib/transcript-entry.ts')
})
