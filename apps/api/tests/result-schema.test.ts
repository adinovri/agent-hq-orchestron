import { describe, it, expect } from 'vitest'
import {
  ORCHESTRON_RESULT_SCHEMA,
  ORCHESTRON_RESULT_SCHEMA_JSON,
  parseHeadlessResultDocument,
} from '@agent-hq-orchestron/shared'

/** Walk every object node of the schema. Strict mode is not a style
 *  preference here — Codex rejects a schema that violates it outright, so a
 *  future edit that adds a nested object without these properties would break
 *  headless codex at runtime with no compile-time signal. */
function objectNodes(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== 'object') return out
  const n = node as Record<string, unknown>
  const type = n['type']
  const isObject = type === 'object' || (Array.isArray(type) && type.includes('object'))
  if (isObject && n['properties']) out.push(n)
  for (const v of Object.values(n)) {
    if (Array.isArray(v)) v.forEach((c) => objectNodes(c, out))
    else if (v && typeof v === 'object') objectNodes(v, out)
  }
  return out
}

describe('ORCHESTRON_RESULT_SCHEMA — strict mode', () => {
  it('sets additionalProperties false on every object level', () => {
    const nodes = objectNodes(ORCHESTRON_RESULT_SCHEMA)
    expect(nodes.length).toBeGreaterThanOrEqual(3)   // root, inquiry, field
    for (const n of nodes) expect(n['additionalProperties']).toBe(false)
  })

  it('lists every property of every object in required', () => {
    for (const n of objectNodes(ORCHESTRON_RESULT_SCHEMA)) {
      const props = Object.keys(n['properties'] as Record<string, unknown>)
      const required = n['required'] as string[]
      expect([...required].sort()).toEqual([...props].sort())
    }
  })

  it('expresses optionality as a nullable type, never by omission', () => {
    const inquiry = (ORCHESTRON_RESULT_SCHEMA.properties.inquiry as { type: readonly string[] })
    expect(inquiry.type).toContain('null')
    expect(inquiry.type).toContain('object')
  })

  it('serialises to a single-line JSON string for claude --json-schema', () => {
    // Claude takes the schema INLINE and rejects a path, so this string is
    // what actually reaches argv.
    expect(ORCHESTRON_RESULT_SCHEMA_JSON).not.toContain('\n')
    expect(JSON.parse(ORCHESTRON_RESULT_SCHEMA_JSON)).toEqual(ORCHESTRON_RESULT_SCHEMA)
  })
})

describe('parseHeadlessResultDocument', () => {
  it('pulls summary and inquiry out of a well-formed document', () => {
    const doc = parseHeadlessResultDocument(JSON.stringify({
      summary: 'blocked',
      inquiry: {
        message: 'which env?',
        fields: [{ name: 'env', label: 'Environment', type: 'choice', options: ['dev', 'prod'] }],
      },
    }))
    expect(doc.summary).toBe('blocked')
    expect(doc.inquiry?.fields[0]).toEqual({
      name: 'env', label: 'Environment', type: 'choice', options: ['dev', 'prod'],
    })
  })

  it('returns a null inquiry when the model says it needs nothing', () => {
    const doc = parseHeadlessResultDocument('{"summary":"done","inquiry":null}')
    expect(doc).toEqual({ summary: 'done', inquiry: null })
  })

  // The forgiveness cases below all exist for the same reason: structured
  // output is a request to the model, not a guarantee from it. Losing a
  // turn's output because the response didn't parse would be far worse than
  // missing an inquiry.
  it('treats plain prose as the summary', () => {
    expect(parseHeadlessResultDocument('just some text')).toEqual({
      summary: 'just some text', inquiry: null,
    })
  })

  it('treats malformed JSON as prose rather than throwing', () => {
    // Trimmed, but otherwise handed back verbatim.
    expect(parseHeadlessResultDocument('{"summary": ').summary).toBe('{"summary":')
  })

  it('treats an unrelated JSON object as prose', () => {
    // Some other payload that happens to be JSON must not become an empty
    // summary — the text is still the turn's output.
    const raw = '{"foo":1}'
    expect(parseHeadlessResultDocument(raw)).toEqual({ summary: raw, inquiry: null })
  })

  it('treats a JSON array as prose', () => {
    expect(parseHeadlessResultDocument('[1,2]')).toEqual({ summary: '[1,2]', inquiry: null })
  })

  it('drops an inquiry with no message', () => {
    const doc = parseHeadlessResultDocument(JSON.stringify({
      summary: 's', inquiry: { message: '', fields: [{ name: 'a', label: 'A', type: 'text', options: null }] },
    }))
    expect(doc.inquiry).toBeNull()
  })

  it('drops an inquiry with no usable fields', () => {
    // An inquiry with nothing to fill in would strand the session in
    // needs_input behind a form the user cannot submit.
    const doc = parseHeadlessResultDocument(JSON.stringify({
      summary: 's', inquiry: { message: 'well?', fields: [] },
    }))
    expect(doc.inquiry).toBeNull()
  })

  it('skips malformed fields but keeps the good ones', () => {
    const doc = parseHeadlessResultDocument(JSON.stringify({
      summary: 's',
      inquiry: { message: 'q', fields: [{ nope: true }, { name: 'a', label: 'A', type: 'text', options: null }] },
    }))
    expect(doc.inquiry?.fields).toHaveLength(1)
    expect(doc.inquiry?.fields[0]?.name).toBe('a')
  })

  it('falls back to a text field for an unknown field type', () => {
    const doc = parseHeadlessResultDocument(JSON.stringify({
      summary: 's',
      inquiry: { message: 'q', fields: [{ name: 'a', label: 'A', type: 'wat', options: null }] },
    }))
    expect(doc.inquiry?.fields[0]?.type).toBe('text')
  })

  it('nulls out an options list that is not all strings', () => {
    const doc = parseHeadlessResultDocument(JSON.stringify({
      summary: 's',
      inquiry: { message: 'q', fields: [{ name: 'a', label: 'A', type: 'choice', options: [1, 2] }] },
    }))
    expect(doc.inquiry?.fields[0]?.options).toBeNull()
  })

  it('handles empty and missing input', () => {
    expect(parseHeadlessResultDocument('')).toEqual({ summary: '', inquiry: null })
    expect(parseHeadlessResultDocument(undefined)).toEqual({ summary: '', inquiry: null })
    expect(parseHeadlessResultDocument(null)).toEqual({ summary: '', inquiry: null })
  })
})
