import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { findUnreachableScrollRegions, scrollAxes } from './scroll-regions'

/**
 * NF36: page-scope axe reported `scrollable-region-focusable` (serious) on
 * `/settings` — the `<pre>` holding the restart command scrolls sideways and
 * was not focusable, so a keyboard-only operator could read the first half of
 * the command and had no way to reach the rest.
 *
 * No DOM in this suite, so nothing is rendered and no axe run happens here.
 * What is asserted is the source-level property axe was measuring: every
 * `<pre>` that can produce a scrollbar carries `tabIndex`, and every one that
 * carries a name carries the role that name is legal on.
 */

const WEB = join(__dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return []
    const p = join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(p)
    return e.name.endsWith('.tsx') ? [p] : []
  })
}

describe('scrollAxes', () => {
  it('a non-wrapping box with overflow-x scrolls sideways', () => {
    expect(scrollAxes('rounded overflow-x-auto whitespace-pre')).toMatchObject({ x: true })
  })

  it('wrapping content never overflows sideways, whatever the utility says', () => {
    expect(scrollAxes('overflow-x-auto whitespace-pre-wrap break-all').x).toBe(false)
    expect(scrollAxes('overflow-x-auto whitespace-pre-wrap').x).toBe(false)
  })

  it('vertical scroll needs a ceiling — without one the box just grows', () => {
    expect(scrollAxes('overflow-y-auto whitespace-pre-wrap').y).toBe(false)
    expect(scrollAxes('max-h-64 overflow-y-auto whitespace-pre-wrap').y).toBe(true)
  })

  it('treats h-auto and h-full as no ceiling', () => {
    expect(scrollAxes('h-auto overflow-y-auto').y).toBe(false)
    expect(scrollAxes('h-full overflow-y-auto').y).toBe(false)
  })

  it('bare overflow-auto puts both axes in play', () => {
    expect(scrollAxes('overflow-auto whitespace-pre max-h-40')).toEqual({ x: true, y: true })
  })

  it('does not mistake overflow-hidden for a scroll container', () => {
    expect(scrollAxes('overflow-hidden whitespace-pre max-h-40')).toEqual({ x: false, y: false })
  })
})

describe('findUnreachableScrollRegions', () => {
  it('flags the NF36 shape — scrolls sideways, no tabIndex', () => {
    const found = findUnreachableScrollRegions(
      'X.tsx',
      ['<pre className="px-3 py-2 rounded overflow-x-auto whitespace-pre">', '  {command}', '</pre>'].join('\n'),
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ reason: 'scrolls-x-unfocusable', line: 1 })
  })

  it('flags a capped vertical scroller too', () => {
    const found = findUnreachableScrollRegions(
      'X.tsx',
      ['<pre className="p-2 whitespace-pre-wrap max-h-64 overflow-y-auto">', '  {content}', '</pre>'].join('\n'),
    )
    expect(found).toHaveLength(1)
    expect(found[0].reason).toBe('scrolls-y-unfocusable')
  })

  it('accepts a scroller that is focusable and properly named', () => {
    expect(
      findUnreachableScrollRegions(
        'X.tsx',
        [
          '<pre',
          '  tabIndex={0}',
          '  role="group"',
          '  aria-label="Restart command"',
          '  className="overflow-x-auto whitespace-pre"',
          '>',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('flags aria-label without a role — <pre> is generic, where it is prohibited', () => {
    const found = findUnreachableScrollRegions(
      'X.tsx',
      [
        '<pre',
        '  tabIndex={0}',
        '  aria-label="Restart command"',
        '  className="overflow-x-auto whitespace-pre"',
        '>',
      ].join('\n'),
    )
    expect(found).toHaveLength(1)
    expect(found[0].reason).toBe('name-without-role')
  })

  it('leaves a <pre> that cannot scroll alone — no gratuitous tab stop', () => {
    expect(
      findUnreachableScrollRegions(
        'X.tsx',
        ['<pre className="mt-1 px-2 py-1 whitespace-pre-wrap break-all">', '  {text}', '</pre>'].join('\n'),
      ),
    ).toEqual([])
  })
})

describe('every scrollable <pre> in the app is keyboard-reachable', () => {
  const files = sourceFiles(WEB)

  it('finds the app to scan', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('scans the four <pre> blocks this app renders', () => {
    const pres = files.reduce(
      (n, f) => n + (readFileSync(f, 'utf8').match(/^\s*<pre\b/gm)?.length ?? 0),
      0,
    )
    expect(pres).toBe(4)
  })

  it('reports none unreachable', () => {
    const offenders = files.flatMap((f) =>
      findUnreachableScrollRegions(f.slice(WEB.length + 1), readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
