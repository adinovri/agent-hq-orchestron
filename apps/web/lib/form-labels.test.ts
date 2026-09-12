import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { findUnnamedFormControls } from './form-labels'

/**
 * NF33: axe reported `select-name` (critical) on ten dialogs — every `<select>`
 * in the app was labelled only by an adjacent `<label>` with no `for`, so a
 * screen reader announced an unnamed combobox. NF30 made the *failure* audible;
 * this is the *form* that was still partly mute.
 *
 * No DOM in this suite, so nothing is rendered and no axe run happens here.
 * What is asserted is the source-level property axe was measuring: every
 * `<select>` and every visible file input carries a name, either directly or
 * through a `htmlFor` that actually points at it.
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

describe('findUnnamedFormControls', () => {
  it('flags a select with nothing but an adjacent label — the NF33 shape', () => {
    const found = findUnnamedFormControls(
      'X.tsx',
      [
        '<label className="text-sm">Model</label>',
        '<select',
        '  value={model}',
        '  onChange={(e) => setModel(e.target.value)}',
        '>',
      ].join('\n'),
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ tag: 'select', reason: 'no-id-no-aria' })
  })

  it('accepts an explicit association', () => {
    expect(
      findUnnamedFormControls(
        'X.tsx',
        [
          '<label htmlFor={`${uid}-model`} className="text-sm">Model</label>',
          '<select',
          '  id={`${uid}-model`}',
          '  value={model}',
          '>',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('accepts aria-label where there is no visible label to point at', () => {
    expect(
      findUnnamedFormControls(
        'X.tsx',
        ['<select', '  aria-label="Filter by project"', '  value={p}', '>'].join('\n'),
      ),
    ).toEqual([])
  })

  it('flags an id that no label points at — the association half-done', () => {
    const found = findUnnamedFormControls(
      'X.tsx',
      ['<label className="text-sm">Model</label>', '<select id={`${uid}-mdl`}>'].join('\n'),
    )
    expect(found).toHaveLength(1)
    expect(found[0].reason).toBe('id-without-label')
  })

  it('exempts a display:none file input driven by a labelled button', () => {
    expect(
      findUnnamedFormControls(
        'X.tsx',
        [
          '<input',
          '  ref={fileInputRef}',
          '  type="file"',
          '  className="hidden"',
          '/>',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('does not exempt one that is only hidden on small screens', () => {
    expect(
      findUnnamedFormControls(
        'X.tsx',
        ['<input type="file" className="hidden sm:block" />'].join('\n'),
      ),
    ).toHaveLength(1)
  })

  it('leaves text inputs alone — axe accepts their placeholder as a name', () => {
    expect(
      findUnnamedFormControls(
        'X.tsx',
        ['<input', '  type="text"', '  placeholder="Leave blank to inherit"', '/>'].join('\n'),
      ),
    ).toEqual([])
  })
})

describe('every reachable select and file input has an accessible name', () => {
  const files = sourceFiles(WEB)

  it('finds the app to scan', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('scans the nineteen selects NF33 was about', () => {
    const selects = files.reduce(
      (n, f) => n + (readFileSync(f, 'utf8').match(/^\s*<select\b/gm)?.length ?? 0),
      0,
    )
    expect(selects).toBe(19)
  })

  it('reports none unnamed', () => {
    const offenders = files.flatMap((f) =>
      findUnnamedFormControls(f.slice(WEB.length + 1), readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
