/**
 * Does the agent actually want the user, or was it made to say so?
 *
 * Two questions live here because they are the same question asked of
 * different evidence:
 *
 *  - **tmux**: the harness reports no `inquiry` at all, so the only evidence is
 *    the model's prose. `textAsksQuestion` reads it.
 *  - **headless**: the harness reports a structured `inquiry`, which looks
 *    authoritative and usually is — except when Claude Code *coerced* the call.
 *    `isCoercedInquiry` decides whether to believe it.
 *
 * Both feed the same decision (`idle` vs `needs_input`), so they share one
 * phrase list. It lived in the API before; it is here because the headless
 * classifier needs it too and the schema it classifies is already in shared.
 */

/**
 * Does a piece of assistant prose solicit the user?
 *
 * Cheap heuristic: contains a `?`, or contains a phrase people actually use
 * when handing a decision back. It is deliberately not a parser — the cost of
 * a miss is a session that says `idle` instead of `needs_input`, and `idle`
 * accepts input too, so a false negative loses a badge rather than a turn.
 *
 * **Why a bare `?` and not an end-of-string anchor (NF19).** The first pattern
 * used to be `/\?\s*$/`, a `?` anchored to the end of the *whole string*. A
 * model that asks inside a numbered list and closes with a polite non-question
 * sentence therefore read as "asked nothing". Measured over 6 runs of the
 * official inquiry prompt, **3 genuine inquiries were discarded** and the one
 * that survived did so by coincidence — its prose happened to contain the
 * words *"would you like"*, while its sibling asked the same two questions in
 * the same shape and was thrown away. Outcome decided by incidental diction is
 * not a heuristic. A multiline anchor does **not** fix it: those question lines
 * end in `)`, not `?`.
 *
 * The end-anchored pattern is kept below it — redundant for matching, but it
 * is the shape the phrase list is documented against, and removing it would
 * make this list read as though trailing `?` were never the point.
 *
 * **What this widening costs.** On the tmux path (`session-manager.ts`) this
 * predicate reads the last assistant message directly, so a *rhetorical*
 * question inside a finished summary ("Why did it fail? Stale config. Fixed.")
 * now lands `needs_input` instead of `idle` — and `needs_input` is exempt from
 * the idle sweeper, so such a session will not age out on its own. That is the
 * accepted trade: a false keep costs a badge and a sweep exemption, a false
 * discard costs the operator the question entirely. Pinned by test below.
 */
export const QUESTION_PHRASES = [
  /\?/,                            // a question mark anywhere — NF19
  /\?\s*$/,                         // ends with ? (subsumed by the above)
  /would you like/i,
  /do you want/i,
  /should i /i,
  /which (one|do you|would)/i,
  /let me know/i,
  /please (tell|specify|confirm|clarify|choose)/i,
  /what (do you|would|should)/i,
  /any (specific|preference|thoughts)/i,
  /shall i/i,
  /could you (tell|specify|clarify|share)/i,
]

export function textAsksQuestion(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return QUESTION_PHRASES.some((re) => re.test(t))
}

/** Prefix of the nudge Claude Code injects **as a user turn** when the model
 *  finished a turn without calling the StructuredOutput tool:
 *  `[structured-output-enforce] You MUST call the StructuredOutput tool to
 *  complete this request. Call this tool now.`
 *
 *  The operator never typed it — see the normaliser in `result-schema.ts`,
 *  which hides both it and the reply it provokes from the transcript.
 *  Verified against Claude Code 2.1.267. */
export const STRUCTURED_OUTPUT_ENFORCE_PREFIX = '[structured-output-enforce]'

/**
 * Evidence about how a headless turn's structured `inquiry` came to exist.
 *
 * Collected by the adapter while it drains `--output-format stream-json`,
 * because the enforcement nudge is a stream event and nothing downstream can
 * see it: by the time the document reaches the session manager it is just an
 * `inquiry` object, indistinguishable from one the model raised itself.
 */
export interface InquiryProvenance {
  /** A `[structured-output-enforce]` user turn appeared in this turn's stream.
   *  Absent on harnesses that do not emit one (Codex), which is why the
   *  default has to be "believe the inquiry". */
  enforceNudged?: boolean
  /** The model's own assistant prose from before the first nudge — the last
   *  thing it said while it still thought the turn was over. */
  preNudgeAssistantText?: string
}

/**
 * Should a structured `inquiry` be discarded as an artefact of enforcement?
 *
 * The failure this exists for (NF17): `claude -p --json-schema` tells the model
 * it MUST call `StructuredOutput` at the end of its response. When the model
 * finishes without doing so, Claude Code injects the enforce nudge as a user
 * turn. A model that has already fully answered now has to produce a document
 * it has no content for, and the schema offers an `inquiry` field — so it fills
 * it. Measured on a run whose prompt was `Remember the number 47. Reply with
 * just: ok.`: prose reply `ok`, nudge, then
 * `inquiry: { message: "I'm ready to help. What would you like me to do?" }`.
 * Orchestron did the right thing with the wrong input and parked a finished
 * session in `needs_input` for a question nobody asked. It reproduced twice in
 * one sweep, including on an unattended scheduled run.
 *
 * Note what cannot be used to catch it: that `message` **is** a well-formed
 * question and matches every phrase heuristic there is. Linguistics can't
 * separate it from a real one. The provenance can — an inquiry produced only
 * under duress, by a model that had already declared itself done, is an
 * afterthought by construction.
 *
 * The pre-nudge prose is the safety valve. A model that genuinely wanted input
 * but forgot the tool call said so in prose first, and that inquiry is kept.
 * Only silence-then-coerced-inquiry is discarded — and even then the cost of
 * being wrong is a session in `idle`, which still accepts the answer.
 */
export function isCoercedInquiry(provenance: InquiryProvenance): boolean {
  if (!provenance.enforceNudged) return false
  return !textAsksQuestion(provenance.preNudgeAssistantText ?? '')
}
