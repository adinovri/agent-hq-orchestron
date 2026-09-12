import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  extractApiErrorDetail,
  describeApiError,
  throwIfNotOk,
  mutationErrorMessage,
  findUnprefixedErrorThrows,
} from './api-error'

/**
 * NF27. The web app had three mutations with no `res.ok` check at all and six
 * more that threw the raw response body at the operator. This covers the part
 * that decides what they say: which field of which body shape wins, and what
 * happens when the body is not the shape anyone planned for.
 */

describe('extractApiErrorDetail', () => {
  it('reads the { error } a refusing route sends', () => {
    // The shape at all 85 `reply.code(4xx).send(...)` sites in the API.
    expect(extractApiErrorDetail('{"error":"Cannot delete a running session"}'))
      .toBe('Cannot delete a running session')
  })

  it('prefers message over error on a Fastify 500', () => {
    // `error` there is the class name, not the reason. Reading it would put
    // "Internal Server Error" on screen and drop the only useful half.
    const body = '{"statusCode":500,"error":"Internal Server Error","message":"tmux: no server running"}'
    expect(extractApiErrorDetail(body)).toBe('tmux: no server running')
  })

  it('falls back to error when message is absent', () => {
    expect(extractApiErrorDetail('{"statusCode":404,"error":"Not Found"}')).toBe('Not Found')
  })

  it('ignores a present-but-empty field rather than showing a blank', () => {
    expect(extractApiErrorDetail('{"message":"   ","error":"real reason"}')).toBe('real reason')
  })

  it('has no detail for valid JSON carrying neither field', () => {
    expect(extractApiErrorDetail('{"ok":false,"code":7}')).toBeNull()
  })

  it('has no detail for an empty or whitespace body', () => {
    expect(extractApiErrorDetail('')).toBeNull()
    expect(extractApiErrorDetail('\n  \t ')).toBeNull()
  })

  it('refuses a gateway HTML page', () => {
    // "HTTP 502" beats "HTTP 502: <!DOCTYPE html><html>…".
    expect(extractApiErrorDetail('<!DOCTYPE html><html><body>502</body></html>')).toBeNull()
  })

  it('keeps plain non-JSON text, which is usually a proxy one-liner', () => {
    expect(extractApiErrorDetail('upstream connect error')).toBe('upstream connect error')
  })

  it('truncates a body too long for a dialog', () => {
    const detail = extractApiErrorDetail(JSON.stringify({ error: 'x'.repeat(900) }))
    expect(detail).toHaveLength(300)
    expect(detail?.endsWith('…')).toBe(true)
  })
})

describe('describeApiError', () => {
  it('pairs the status with the detail', () => {
    expect(describeApiError(409, '{"error":"Cannot archive"}')).toBe('HTTP 409: Cannot archive')
  })

  it('is the bare status when there is no detail worth showing', () => {
    expect(describeApiError(502, '<html>bad gateway</html>')).toBe('HTTP 502')
  })
})

/** Enough of `Response` for the check — no DOM, no fetch. */
function fakeResponse(ok: boolean, status: number, body: string | (() => never)): Response {
  return {
    ok,
    status,
    text: async () => (typeof body === 'function' ? body() : body),
  } as unknown as Response
}

describe('throwIfNotOk', () => {
  it('passes an ok response straight through', async () => {
    const res = fakeResponse(true, 200, '')
    await expect(throwIfNotOk(res)).resolves.toBe(res)
  })

  it('throws the described error on a failure', async () => {
    // The kill 500 the whole finding is about: before this, the absence of
    // this throw is what let `onSettled` close the dialog like a success.
    const res = fakeResponse(false, 500, '{"statusCode":500,"error":"Internal Server Error","message":"boom"}')
    await expect(throwIfNotOk(res)).rejects.toThrow('HTTP 500: boom')
  })

  it('still throws the status when the body cannot be read', async () => {
    // A connection cut mid-response. An error about reading the error would
    // replace the status the caller already has with a stack trace.
    const res = fakeResponse(false, 503, () => { throw new Error('body already consumed') })
    await expect(throwIfNotOk(res)).rejects.toThrow('HTTP 503')
  })
})

describe('mutationErrorMessage', () => {
  it('uses an Error message', () => {
    expect(mutationErrorMessage(new Error('HTTP 409: Cannot archive'))).toBe('HTTP 409: Cannot archive')
  })

  it('keeps a network failure legible', () => {
    expect(mutationErrorMessage(new TypeError('Failed to fetch'))).toBe('Failed to fetch')
  })

  it('takes a bare string', () => {
    expect(mutationErrorMessage('nope')).toBe('nope')
  })

  it('never renders [object Object]', () => {
    // The reason this is a function and not String(err).
    expect(mutationErrorMessage({ code: 7 })).toBe('The request failed.')
    expect(mutationErrorMessage(new Error('   '))).toBe('The request failed.')
    expect(mutationErrorMessage(undefined)).toBe('The request failed.')
    expect(mutationErrorMessage(null)).toBe('The request failed.')
  })
})

/**
 * NF34: Import's hand-rolled `.ok` check omitted the `HTTP nnn:` prefix that
 * the other six raw renderers keep, so a failed import showed a bare JSON blob
 * with no way to tell a 404 from a 500. Its `throw` also sat inside the `try`
 * meant to parse the body, so its own `catch` swallowed the parsed message —
 * the JSON branch was unreachable from the day it was written.
 */
describe('Import renders a failure the same shape as the other dialogs', () => {
  const importDialog = readFileSync(
    join(__dirname, '..', 'components', 'ImportSessionDialog.tsx'),
    'utf8',
  )

  it('goes through throwIfNotOk rather than its own check', () => {
    expect(importDialog).toContain("import { throwIfNotOk } from '@/lib/api-error'")
    expect(importDialog).toContain('await throwIfNotOk(')
    expect(importDialog).not.toMatch(/if \(!res\.ok\)/)
  })

  it('prefixes the status on a 500 with a Fastify envelope', async () => {
    const res = new Response(
      JSON.stringify({ statusCode: 500, error: 'Internal Server Error', message: 'boom' }),
      { status: 500 },
    )
    await expect(throwIfNotOk(res)).rejects.toThrow('HTTP 500: boom')
  })

  it('prefixes the status on a 404 refusal', async () => {
    const res = new Response(JSON.stringify({ error: 'Project not found: abc' }), { status: 404 })
    await expect(throwIfNotOk(res)).rejects.toThrow('HTTP 404: Project not found: abc')
  })

  it('prefixes the status on a 400 with no body at all', async () => {
    await expect(throwIfNotOk(new Response('', { status: 400 }))).rejects.toThrow('HTTP 400')
  })
})

describe('findUnprefixedErrorThrows', () => {
  it('catches the exact code NF34 was filed against', () => {
    const found = findUnprefixedErrorThrows(
      'ImportSessionDialog.tsx',
      [
        '      if (!res.ok) {',
        '        const text = await res.text()',
        '        try {',
        '          const j = JSON.parse(text) as { error?: string }',
        '          throw new Error(j.error ?? text)',
        '        } catch {',
        '          throw new Error(text || `HTTP ${res.status}`)',
        '        }',
        '      }',
      ].join('\n'),
    )
    expect(found).toHaveLength(1)
    expect(found[0].snippet).toBe('throw new Error(j.error ?? text)')
  })

  it('accepts a one-line guard that names the status', () => {
    expect(
      findUnprefixedErrorThrows(
        'X.tsx',
        ['if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)'].join('\n'),
      ),
    ).toEqual([])
  })

  it('catches a one-line guard that does not', () => {
    expect(
      findUnprefixedErrorThrows('X.tsx', 'if (!res.ok) throw new Error(await res.text())'),
    ).toHaveLength(1)
  })

  it('ignores throws outside a status guard', () => {
    expect(
      findUnprefixedErrorThrows(
        'X.tsx',
        "if (!file || !projectId) throw new Error('missing input')",
      ),
    ).toEqual([])
  })

  it('leaves no unprefixed throw anywhere the app checks a status itself', () => {
    const web = join(__dirname, '..')
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        if (e.name === 'node_modules' || e.name.startsWith('.')) return []
        const p = join(dir, e.name)
        if (e.isDirectory()) return walk(p)
        return /\.tsx?$/.test(e.name) && !e.name.includes('.test.') ? [p] : []
      })

    const offenders = walk(web).flatMap((f) =>
      findUnprefixedErrorThrows(f.slice(web.length + 1), readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
