/**
 * recall.mjs — "the second turn remembers the first", asserted against the
 * words the model actually said.
 *
 * NF39 (post-batch-20): the two-turn recall assertions scored themselves by
 * regex-matching the planted word against the session record's
 * `finalResponse`. With structured output on — the default —
 * `finalResponse` is NOT the model's prose. `session-manager.ts` assigns
 * `patched.finalResponse = doc.summary`, and `docs/e2e-tests/headless-flow.md`
 * (HEADLESS-06) says prose lands there only when `headlessStructuredOutput`
 * is off. So the assertion passed only when the model's self-summary happened
 * to quote the word:
 *
 *     HEADLESS-01  finalResponse "Responded with the requested word."
 *                  transcript seq 8 → "ready"
 *
 * A probe that flaps for reasons unrelated to the code under test is worse
 * than no probe. Recall is asserted on the TRANSCRIPT, and two guards decide
 * WHICH entry counts as the answer. Both were learned by getting them wrong:
 *
 *   1. Not "the last assistant entry". Between headless turns Claude Code
 *      injects the resume pair (`Continue from where you left off.` /
 *      `No response requested.`, seq 5/6 in a two-turn session). A naive
 *      probe settles on the nudge reply and scores it as the answer.
 *   2. Not "any assistant entry past turn 1". Polling before the turn-2 USER
 *      entry is persisted makes TURN 1's answer look like the answer, and the
 *      assertion passes VACUOUSLY on the word turn 1 planted. Observed:
 *      `answerSeq=1 afterUserSeq=0 text="apricot"` reported as a PASS.
 *
 * Capture `maxSeq` BEFORE sending, then require an assistant entry strictly
 * after the latest real user entry, itself strictly after that baseline.
 *
 * Pure — no fetch, no fs — so it is unit-testable against a fixture
 * transcript, which is the point.
 */

/** Verbatim, as Claude Code writes it on `--resume`. */
export const RESUME_NUDGE = 'Continue from where you left off.'
/** Verbatim, as the model answers it when there is nothing pending. */
export const RESUME_NUDGE_REPLY = 'No response requested.'

/**
 * `'nudge'` / `'reply'` for the injected resume exchange, `null` for anything
 * the operator or the agent actually said.
 *
 * Same rule as `apps/web/lib/transcript-entry.ts` — exact sentence after
 * trimming, and the reply half only counts when the entry immediately before
 * it is the nudge, so a model that genuinely writes "No response requested."
 * in a real answer is not skipped. `env-file.test.mjs`'s sibling test pins
 * these two constants against that file so the pair cannot drift apart.
 */
export function resumeMetaRole(entry, previous) {
  if (!entry) return null
  if (entry.kind === 'user' && String(entry.content ?? '').trim() === RESUME_NUDGE) return 'nudge'
  if (
    entry.kind === 'assistant' &&
    String(entry.content ?? '').trim() === RESUME_NUDGE_REPLY &&
    previous?.kind === 'user' &&
    String(previous.content ?? '').trim() === RESUME_NUDGE
  ) {
    return 'reply'
  }
  return null
}

/** Highest seq present — the baseline a turn about to be sent must beat. */
export function maxSeq(entries) {
  return (entries ?? []).reduce((m, e) => Math.max(m, Number.isFinite(e?.seq) ? e.seq : -1), -1)
}

/**
 * The assistant entry that answers a turn sent after `baselineSeq`.
 *
 * @param entries     `GET /api/sessions/:id/transcript` → `entries`.
 * @param baselineSeq `maxSeq(entries)` read BEFORE the turn was sent. Omitting
 *                    it (or passing -1) is the vacuous-pass shape guard 2
 *                    exists to stop, so it is required to be a number.
 * @returns `{ answered, text, seq, userSeq, baselineSeq, reason, skipped }`
 */
export function findRecallAnswer(entries, { baselineSeq } = {}) {
  if (!Number.isFinite(baselineSeq)) {
    throw new TypeError('findRecallAnswer: baselineSeq must be a number read BEFORE the turn was sent')
  }
  const all = [...(entries ?? [])].sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0))
  const skipped = []
  const real = all.filter((e, i) => {
    const role = resumeMetaRole(e, all[i - 1])
    if (role) { skipped.push({ seq: e.seq, role }); return false }
    return true
  })

  const base = { baselineSeq, skipped }
  const lastUser = [...real].reverse().find(e => e.kind === 'user' && e.seq > baselineSeq)
  if (!lastUser) {
    return { ...base, answered: false, text: '', seq: -1, userSeq: -1, reason: `no user entry past seq ${baselineSeq}` }
  }
  const answer = [...real].reverse().find(e => e.kind === 'assistant' && e.seq > lastUser.seq)
  if (!answer) {
    return { ...base, answered: false, text: '', seq: -1, userSeq: lastUser.seq, reason: `no assistant entry past the turn's user entry (seq ${lastUser.seq})` }
  }
  return { ...base, answered: true, text: String(answer.content ?? ''), seq: answer.seq, userSeq: lastUser.seq, reason: null }
}

/**
 * The whole assertion: did the turn land, and does it quote what turn 1
 * planted. `detail` is the one-line evidence a sweep report needs — every
 * seq it decided on, plus the summary it deliberately did NOT score, so a
 * reader can see the NF39 trap was avoided rather than take it on faith.
 */
export function assertRecall(entries, { baselineSeq, expect, finalResponse = null } = {}) {
  if (!(expect instanceof RegExp)) throw new TypeError('assertRecall: expect must be a RegExp')
  const a = findRecallAnswer(entries, { baselineSeq })
  const ok = a.answered && expect.test(a.text)
  const detail =
    `answerSeq=${a.seq} afterUserSeq=${a.userSeq} baseSeq=${a.baselineSeq} ` +
    `skipped=${JSON.stringify(a.skipped)} text=${JSON.stringify(a.text.slice(0, 80))}` +
    (finalResponse == null ? '' : ` summary(NOT scored)=${JSON.stringify(String(finalResponse).slice(0, 60))}`) +
    (a.reason ? ` reason=${a.reason}` : '')
  return { ok, detail, ...a }
}
