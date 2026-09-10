import type { HeadlessResultDocument, Inquiry, InquiryField } from './types.js'

/**
 * Structured-output contract for headless runs.
 *
 * A headless turn has no TUI, so there is no selector modal for an agent to
 * raise when it needs the user. Instead the harness is handed this schema and
 * the agent answers with a document that may carry an `inquiry`. Orchestron
 * reads that field and lands the turn in `needs_input` rather than `idle`.
 * The pattern is borrowed from Tycho, which proved it in production.
 *
 * WRITTEN FOR STRICT MODE, which is what makes it work on both harnesses:
 *
 *  - `additionalProperties: false` on EVERY object, not just the root.
 *  - EVERY property listed in `required`. Codex/OpenAI strict mode has no
 *    concept of an optional key, so "this may be absent" has to be expressed
 *    as `type: [X, "null"]` and still be required. `inquiry` and
 *    `options` are both nullable-and-required for exactly that reason.
 *
 * Claude's `--json-schema` is more permissive and would accept a loose
 * document, but a single strict schema serves both harnesses, so there is
 * only one of these.
 *
 * Verified against Claude Code 2.1.266 and codex-cli 0.153.4 — see
 * scratchpad/headless-phase2-verification.md.
 */
export const ORCHESTRON_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    summary: {
      type: 'string',
      description: 'Short summary of what was done this turn.',
    },
    inquiry: {
      type: ['object', 'null'],
      description:
        'Set ONLY when you need input from the user before you can continue. Null otherwise.',
      additionalProperties: false,
      properties: {
        message: {
          type: 'string',
          description: 'What you need from the user and why.',
        },
        fields: {
          type: 'array',
          description: 'The individual answers you need.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              name: { type: 'string', description: 'Machine key for the answer.' },
              label: { type: 'string', description: 'Human-readable question.' },
              type: { type: 'string', enum: ['text', 'choice', 'boolean'] },
              options: {
                type: ['array', 'null'],
                items: { type: 'string' },
                description: 'Choices when type is "choice". Null otherwise.',
              },
            },
            required: ['name', 'label', 'type', 'options'],
          },
        },
      },
      required: ['message', 'fields'],
    },
  },
  required: ['summary', 'inquiry'],
} as const

/** The schema as the single-line JSON string Claude's `--json-schema` wants.
 *  Computed once — it is a constant. */
export const ORCHESTRON_RESULT_SCHEMA_JSON = JSON.stringify(ORCHESTRON_RESULT_SCHEMA)

/** Filename used when the schema is written to disk for Codex's
 *  `--output-schema`, which takes a path rather than inline JSON. */
export const ORCHESTRON_RESULT_SCHEMA_FILENAME = 'orchestron_result_schema.json'

const FIELD_TYPES = new Set(['text', 'choice', 'boolean'])

function parseField(raw: unknown): InquiryField | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r['name'] !== 'string' || typeof r['label'] !== 'string') return null
  const type = typeof r['type'] === 'string' && FIELD_TYPES.has(r['type']) ? r['type'] : 'text'
  const rawOptions = r['options']
  const options =
    Array.isArray(rawOptions) && rawOptions.every((o) => typeof o === 'string')
      ? (rawOptions as string[])
      : null
  return { name: r['name'], label: r['label'], type: type as InquiryField['type'], options }
}

/**
 * Parse a headless turn's final response into `{ summary, inquiry }`.
 *
 * Deliberately forgiving. Structured output is a request to the model, not a
 * guarantee from it: the flag can be off, an older harness can ignore it, and
 * a model can still emit prose. Any input that isn't a well-formed document
 * comes back as `{ summary: <the raw text>, inquiry: null }`, so the caller
 * gets the same shape either way and a malformed response degrades to exactly
 * the pre-schema behaviour rather than losing the turn's output.
 *
 * `inquiry` is only returned when it has a message AND at least one field —
 * an empty inquiry would strand the session in `needs_input` with an
 * unanswerable form.
 */
export function parseHeadlessResultDocument(raw: string | undefined | null): HeadlessResultDocument {
  const text = (raw ?? '').trim()
  if (!text) return { summary: '', inquiry: null }

  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return { summary: text, inquiry: null }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { summary: text, inquiry: null }

  const d = doc as Record<string, unknown>
  // A JSON object that carries neither key is somebody else's payload, not
  // our document — hand back the raw text rather than an empty summary.
  if (!('summary' in d) && !('inquiry' in d)) return { summary: text, inquiry: null }

  const summary = typeof d['summary'] === 'string' ? d['summary'] : text

  const rawInquiry = d['inquiry']
  if (!rawInquiry || typeof rawInquiry !== 'object' || Array.isArray(rawInquiry)) {
    return { summary, inquiry: null }
  }
  const ri = rawInquiry as Record<string, unknown>
  const message = typeof ri['message'] === 'string' ? ri['message'] : ''
  const fields = Array.isArray(ri['fields'])
    ? (ri['fields'].map(parseField).filter((f): f is InquiryField => f !== null))
    : []
  if (!message || fields.length === 0) return { summary, inquiry: null }

  const inquiry: Inquiry = { message, fields }
  return { summary, inquiry }
}

// ── Transcript normalisation ─────────────────────────────────────

/** Name of the tool Claude Code synthesises when `--json-schema` is passed.
 *  The model is told "You MUST call this tool exactly once at the end of your
 *  response", and its input is the structured document. Verified against
 *  Claude Code 2.1.267. */
export const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput'

/** The tool_result Claude Code writes back after accepting the document.
 *  Fixed string in the CLI bundle, not model-authored. */
const STRUCTURED_OUTPUT_TOOL_RESULT = 'Structured output provided successfully'

/** Prefix of the nudge Claude Code injects **as a user turn** when the model
 *  finished a turn without calling the tool: `[structured-output-enforce] You
 *  MUST call the StructuredOutput tool to complete this request. Call this
 *  tool now.`
 *
 *  It is addressed to the model on Orchestron's behalf — the operator never
 *  typed it — and the model's reply to it is an acknowledgement of the
 *  plumbing ("Remembered the number 47 and replied as requested."), not an
 *  answer to anything the operator asked. Both halves are machinery.
 *  Verified against Claude Code 2.1.267. */
const STRUCTURED_OUTPUT_ENFORCE_PREFIX = '[structured-output-enforce]'

/** Minimal shape of a parsed transcript entry — structurally compatible with
 *  the `RolloutEntry` the API's rollout parsers emit. Declared here so the
 *  normaliser stays a pure function with no dependency on the API. */
export interface TranscriptEntryLike {
  seq: number
  timestamp: string
  kind: 'user' | 'assistant' | 'tool_use' | 'tool_result'
  toolName?: string
  content: string
}

/** True when `text` is one of OUR structured documents and nothing else.
 *
 *  Deliberately stricter than `parseHeadlessResultDocument`, which is a
 *  forgiving *reader*. This is a *classifier*: it decides whether hiding the
 *  raw text loses information. An object carrying keys beyond `summary` and
 *  `inquiry` is somebody else's payload — an agent that was legitimately
 *  asked to answer in JSON — and rewriting it to its `summary` would destroy
 *  the answer. So only an exact-shape document qualifies. */
function isExactResultDocument(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return false
  let doc: unknown
  try { doc = JSON.parse(trimmed) } catch { return false }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false
  const keys = Object.keys(doc as Record<string, unknown>)
  if (!keys.includes('summary')) return false
  return keys.every((k) => k === 'summary' || k === 'inquiry')
}

/**
 * Strip the structured-output plumbing out of a headless transcript.
 *
 * Turning the schema on makes each harness leave machinery in the transcript
 * that is addressed to Orchestron, not to the person reading the pane:
 *
 *  - **Claude** synthesises a `StructuredOutput` tool. The transcript gets a
 *    `tool_use` whose input is the raw `{summary, inquiry}` document, plus a
 *    canned `tool_result`. Both rendered verbatim before this — the raw JSON
 *    block and the enforcement chatter the operator reported.
 *  - **Codex** has no tool: the final agent message *is* the document, so the
 *    only thing the reader gets is raw JSON where prose used to be.
 *
 * The two therefore need opposite treatment, which is why this is one pass
 * over the entries rather than a per-entry filter:
 *
 *  - A `StructuredOutput` tool_use that follows the model's own prose is pure
 *    duplication → dropped. When there is no prose (the model answered only
 *    through the tool) its `summary` is promoted to an assistant message, so
 *    the turn is never rendered empty.
 *  - The canned tool_result is always dropped.
 *  - An assistant message that is exactly a result document is rewritten to
 *    its `summary` — the Codex case.
 *  - A `[structured-output-enforce]` user turn — Claude Code nudging the model
 *    to call the tool — is dropped, **together with the assistant turn that
 *    immediately follows it**. The nudge is written on Orchestron's behalf, and
 *    the reply is an acknowledgement of the nudge, so leaving either one in the
 *    pane shows the operator a conversation they were not part of. The reply is
 *    only taken when it is genuinely adjacent; anything else stays.
 *
 * Dropping the pair cannot swallow the answer: the `StructuredOutput` call that
 * the nudge extracted still follows, and with the acknowledgement gone it either
 * finds real prose before it (and is dropped as duplication) or finds none (and
 * is promoted to its `summary`).
 *
 * `seq` values are preserved, not renumbered: they are React keys and stable
 * identifiers for the client, and gaps are harmless. Renumbering would close the
 * gaps this pass opens, but it would also shift every key after a strip on the
 * poll where the second half of a pair lands, remounting rows mid-turn to fix
 * something no one can see. Not worth it — `seq` is never rendered.
 *
 * Only call this for headless sessions. A tmux session never sees the schema,
 * and running the classifier over its transcript could only misfire.
 */
export function normalizeStructuredOutputTranscript<T extends TranscriptEntryLike>(
  entries: readonly T[],
): T[] {
  const out: T[] = []

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!

    if (
      entry.kind === 'tool_result' &&
      entry.content.trim() === STRUCTURED_OUTPUT_TOOL_RESULT
    ) {
      continue
    }

    if (
      entry.kind === 'user' &&
      entry.content.trimStart().startsWith(STRUCTURED_OUTPUT_ENFORCE_PREFIX)
    ) {
      // Consume the model's reply to the nudge as well, but only when it is
      // the very next entry. On a poll that catches the transcript between the
      // two, the nudge goes and the reply is picked up on the next pass.
      if (entries[i + 1]?.kind === 'assistant') i++
      continue
    }

    if (entry.kind === 'tool_use' && entry.toolName === STRUCTURED_OUTPUT_TOOL_NAME) {
      const prev = out[out.length - 1]
      const prosePrecedes = prev?.kind === 'assistant' && prev.content.trim().length > 0
      if (prosePrecedes) continue

      const summary = parseHeadlessResultDocument(entry.content).summary.trim()
      if (!summary) continue
      out.push({ ...entry, kind: 'assistant', toolName: undefined, content: summary })
      continue
    }

    if (entry.kind === 'assistant' && isExactResultDocument(entry.content)) {
      const summary = parseHeadlessResultDocument(entry.content).summary.trim()
      if (summary) out.push({ ...entry, content: summary })
      continue
    }

    out.push(entry)
  }

  return out
}
