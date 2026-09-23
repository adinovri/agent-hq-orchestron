import type { Inquiry } from '@agent-hq-orchestron/shared'

/**
 * How long the answered card stays on screen after a successful submit.
 *
 * The session poll runs every 3s, so without a grace window the sequence is:
 * submit -> server clears `pendingInquiry` -> next poll -> the card's mount
 * condition goes false and it **unmounts**, racing its own local `submitted`
 * flag. The operator sees the form vanish and never sees "Answer sent".
 *
 * Two seconds is long enough to read the confirmation and short enough that
 * the card is gone by the time the agent's next turn shows up in the
 * transcript below it — which is where the answer properly lives.
 */
export const INQUIRY_ANSWER_GRACE_MS = 2_000

/** An inquiry this client answered, and when. Held by the page, not the card,
 *  because it is the page that decides whether the card is mounted at all. */
export interface AnsweredInquiry {
  inquiry: Inquiry
  at: number
}

export interface InquiryCardState {
  inquiry: Inquiry
  /** Render as "Answer sent" + disabled rather than as an open form. */
  answered: boolean
}

/**
 * Identity for an inquiry, for deciding whether the one on the record is
 * still the one we answered.
 *
 * Reference equality is useless here: every poll re-parses the session JSON,
 * so the object is new each time even when nothing changed. Message plus
 * field names is enough — an agent that asks a genuinely different question
 * on its next turn changes at least one of them, and one that asks the exact
 * same question again is, for the operator, indistinguishable from the first.
 *
 * Joined on NUL rather than a space so the parts cannot run together: a
 * message of `"a b"` with no fields would otherwise key the same as `"a"`
 * with a field named `b`.
 */
export function inquiryKey(inquiry: Inquiry): string {
  return [inquiry.message, ...inquiry.fields.map((f) => f.name)].join('\u0000')
}

/**
 * Decide whether the inquiry card renders, and in which of its two states.
 *
 * Pure so it can be tested — `apps/web` runs vitest on `node`, with no DOM —
 * and so the two clocks involved (the 3s poll and the grace timer) stay out
 * of the decision itself. The caller supplies `now`.
 *
 *  - Read-only sessions never show it: there is nothing to answer.
 *  - A pending inquiry we just answered renders as "Answer sent". This is the
 *    window between the submit and the poll that clears the field server-side.
 *  - A pending inquiry we did not answer renders as an open form. That covers
 *    the agent asking again on a later turn: a different key means a new
 *    question, so the form reopens rather than staying stuck on "sent".
 *  - No pending inquiry, but one we answered within the grace window, renders
 *    the answered snapshot. This is the fix for the unmount race.
 *  - Otherwise nothing.
 */
export function resolveInquiryCard(args: {
  pending: Inquiry | null | undefined
  answered: AnsweredInquiry | null
  readOnly: boolean
  /** Omit when the caller owns the grace window itself — it then holds
   *  `answered` only while the card should still be on screen, and there is
   *  nothing left for a clock to decide. The session page does exactly that
   *  with a timer, which also keeps `Date.now()` out of its render. */
  now?: number
  graceMs?: number
}): InquiryCardState | null {
  const { pending, answered, readOnly, now } = args
  const graceMs = args.graceMs ?? INQUIRY_ANSWER_GRACE_MS

  if (readOnly) return null

  if (pending) {
    const isAnswered = answered != null && inquiryKey(answered.inquiry) === inquiryKey(pending)
    return { inquiry: pending, answered: isAnswered }
  }

  if (answered && (now === undefined || now - answered.at < graceMs)) {
    return { inquiry: answered.inquiry, answered: true }
  }

  return null
}
