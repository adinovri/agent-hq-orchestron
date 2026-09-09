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
