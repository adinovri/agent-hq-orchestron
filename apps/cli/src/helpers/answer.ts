import type { Inquiry, InquiryField, PendingPrompt } from '@agent-hq-orchestron/shared'

/**
 * Answering a waiting session is two unrelated mechanisms wearing the same
 * word, and `session answer` has to pick between them at runtime:
 *
 *  • `pendingPrompt` — a selector modal scraped off a live tmux pane
 *    (permission approval, AskUserQuestion fallback). Answered by an option
 *    INDEX, which the API turns into Down×(n-1)+Enter keystrokes.
 *    → `POST /api/sessions/:uuid/answer-prompt {index}`
 *
 *  • `pendingInquiry` — a structured question a headless turn returned in its
 *    final response. There is no process left to keystroke at; the answer is
 *    prose that starts the next `-p --resume` turn.
 *    → `POST /api/sessions/:uuid/input {prompt}`
 *
 * Which one a session is holding is a fact about how it runs, not something
 * the caller should have to know, so the resolver below reads the record and
 * decides. Both are resolved client-side because neither endpoint accepts
 * text-matching: the index route wants a number and the input route wants a
 * finished string.
 */
export type AnswerPlan =
  | { kind: 'prompt'; index: number; label: string }
  | { kind: 'inquiry'; prompt: string }

export interface AnswerSource {
  pendingPrompt?: PendingPrompt | null
  pendingInquiry?: Inquiry | null
  status?: string
}

/** One `--field name=value` pair. */
export function parseFieldAssignment(raw: string): { name: string; value: string } {
  const eq = raw.indexOf('=')
  if (eq <= 0) throw new Error(`--field expects name=value, got ${JSON.stringify(raw)}`)
  return { name: raw.slice(0, eq), value: raw.slice(eq + 1) }
}

/**
 * Match `--choice` against a list of displayed options.
 *
 * A bare integer in range is taken as the 1-based position shown in the UI —
 * that is how the options are numbered on screen and in the API, so an
 * operator reading either can type what they see. Anything else is matched as
 * text: exact (case-insensitive) first, then unique substring.
 *
 * An ambiguous substring is an error rather than a first-match, because the
 * consequence of guessing wrong here is an approved permission or a wrong
 * branch taken autonomously — the one place in this CLI where a near-miss is
 * worse than a refusal.
 */
export function matchOption(choice: string, options: string[]): number {
  const asInt = /^\d+$/.test(choice.trim()) ? Number(choice.trim()) : null
  if (asInt !== null) {
    if (asInt < 1 || asInt > options.length) {
      throw new Error(`--choice ${asInt} is out of range — ${options.length} option(s) available`)
    }
    return asInt
  }

  const needle = choice.trim().toLowerCase()
  const exact = options
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o.trim().toLowerCase() === needle)
  if (exact.length === 1) return exact[0]!.i + 1
  if (exact.length > 1) {
    throw new Error(`--choice ${JSON.stringify(choice)} matches ${exact.length} identical options — use the number instead`)
  }

  const partial = options
    .map((o, i) => ({ o, i }))
    .filter(({ o }) => o.toLowerCase().includes(needle))
  if (partial.length === 1) return partial[0]!.i + 1
  if (partial.length === 0) {
    throw new Error(`--choice ${JSON.stringify(choice)} matched no option. Available: ${options.map((o, i) => `${i + 1}) ${o}`).join('  ')}`)
  }
  throw new Error(
    `--choice ${JSON.stringify(choice)} is ambiguous — matches ${partial.map(({ i }) => i + 1).join(', ')}. Use the number.`,
  )
}

/** `label: value` lines, the same rendering the web InquiryCard sends, so a
 *  transcript reads identically whichever client answered. A lone field
 *  answers bare — the agent asked one thing and gets the answer, not a
 *  restatement of its own question. */
export function formatInquiryAnswer(fields: InquiryField[], values: Map<string, string>): string {
  const answered = fields
    .map((f) => ({ f, v: (values.get(f.name) ?? '').trim() }))
    .filter(({ v }) => v.length > 0)
  if (answered.length === 0) throw new Error('no answers supplied')
  if (answered.length === 1 && fields.length === 1) return answered[0]!.v
  return answered.map(({ f, v }) => `${f.label}: ${v}`).join('\n')
}

export interface AnswerInput {
  choice?: string
  fields?: string[]
  /** Free-text answer that skips option matching entirely. */
  text?: string
}

/**
 * Turn the flags plus the session record into the single call to make.
 *
 * Refuses rather than improvises when the session is holding nothing: a
 * `session answer` against an idle session would otherwise post the choice
 * text as a fresh user turn, which looks like it worked and is not what the
 * caller asked for.
 */
export function planAnswer(session: AnswerSource, input: AnswerInput): AnswerPlan {
  const { pendingPrompt, pendingInquiry } = session

  if (pendingPrompt) {
    const raw = input.choice ?? input.text
    if (raw === undefined) {
      throw new Error(
        `session is holding a ${pendingPrompt.kind} selector — pass --choice with a number or option text. Options: ${pendingPrompt.options.map((o, i) => `${i + 1}) ${o}`).join('  ')}`,
      )
    }
    const index = matchOption(raw, pendingPrompt.options)
    return { kind: 'prompt', index, label: pendingPrompt.options[index - 1] ?? String(index) }
  }

  if (pendingInquiry) {
    const values = new Map<string, string>()
    for (const raw of input.fields ?? []) {
      const { name, value } = parseFieldAssignment(raw)
      if (!pendingInquiry.fields.some((f) => f.name === name)) {
        throw new Error(
          `no field named ${JSON.stringify(name)} in this inquiry. Fields: ${pendingInquiry.fields.map((f) => f.name).join(', ')}`,
        )
      }
      values.set(name, value)
    }

    // `--choice` / `--text` addresses the single-field case, which is most of
    // them. With more than one field there is no way to tell which it meant,
    // so say so instead of filling the first.
    const single = input.choice ?? input.text
    if (single !== undefined) {
      const unset = pendingInquiry.fields.filter((f) => !values.has(f.name))
      if (unset.length !== 1) {
        throw new Error(
          `this inquiry has ${pendingInquiry.fields.length} fields — answer them with --field name=value (${pendingInquiry.fields.map((f) => f.name).join(', ')})`,
        )
      }
      const field = unset[0]!
      // A choice field still gets option matching, so `--choice deploy`
      // resolves to the exact wording the agent offered.
      const value =
        field.type === 'choice' && field.options && field.options.length > 0 && input.text === undefined
          ? field.options[matchOption(single, field.options) - 1]!
          : single
      values.set(field.name, value)
    }

    const missing = pendingInquiry.fields.filter((f) => !(values.get(f.name) ?? '').trim())
    if (missing.length > 0) {
      throw new Error(
        `unanswered field(s): ${missing.map((f) => f.name).join(', ')} — the agent said it cannot continue without them`,
      )
    }
    return { kind: 'inquiry', prompt: formatInquiryAnswer(pendingInquiry.fields, values) }
  }

  throw new Error(
    `session has no pending prompt or inquiry to answer (status: ${session.status ?? 'unknown'}) — use \`session send\` to start a new turn`,
  )
}
