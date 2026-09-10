/**
 * Telling harness-authored turns apart from the operator's own.
 *
 * When a headless session is resumed, Claude Code injects
 * `"Continue from where you left off."` as the user turn and the model
 * answers `"No response requested."`. Both are real rollout entries and the
 * parser emits both on purpose — `b895d39` fixed the case where only the
 * assistant half was rendered, leaving a reply to nothing visible.
 *
 * The cost of that honesty was measured in the 2026-09-11 sweep (NF8): in a
 * five-turn transcript **8 of 18 entries (44%)** were this pair, up from 27%
 * when half of it was invisible, and the share grows with turn count. So the
 * follow-up the phantom PR named is taken here — de-emphasise, do not strip.
 * The entries stay in the API response and in this component's `entries`
 * array; only their *presentation* changes. A transcript that hides turns the
 * rollout contains is the bug we just finished fixing.
 *
 * Pure and in `lib/` because apps/web's vitest suite is node-only.
 */

/** The shape this module needs; the pane's `Entry` is a superset. */
export interface TranscriptEntryLike {
  kind: 'user' | 'assistant' | 'tool_use' | 'tool_result'
  content: string
}

/** Verbatim, as Claude Code writes it on `--resume`. */
export const RESUME_NUDGE = 'Continue from where you left off.'
/** Verbatim, as the model answers it when there is nothing pending. */
export const RESUME_NUDGE_REPLY = 'No response requested.'

/** Which half of the resume exchange an entry is, if either. */
export type ResumeMetaRole = 'nudge' | 'reply'

/**
 * `'nudge'` for the injected user turn, `'reply'` for the model's answer to
 * it, `null` for everything the operator or the agent actually said.
 *
 * Matching is on the exact sentence — case and full stop included — after
 * trimming the surrounding whitespace the parser's block join can leave. A
 * turn that merely *contains* the sentence is a real turn and is left alone.
 *
 * The reply half is recognised **only when the entry immediately before it is
 * the nudge**. That adjacency guard is the same one the NF4 fix uses for
 * paired tool results, and it is what keeps a model that genuinely writes
 * "No response requested." in a normal answer from being greyed out.
 */
export function resumeMetaRole(
  entry: TranscriptEntryLike,
  previous?: TranscriptEntryLike,
): ResumeMetaRole | null {
  if (entry.kind === 'user' && entry.content.trim() === RESUME_NUDGE) return 'nudge'
  if (
    entry.kind === 'assistant' &&
    entry.content.trim() === RESUME_NUDGE_REPLY &&
    previous?.kind === 'user' &&
    previous.content.trim() === RESUME_NUDGE
  ) {
    return 'reply'
  }
  return null
}
