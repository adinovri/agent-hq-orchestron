import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  commandRegionLabel,
  commandCopyLabel,
  findMisnamedDynamicRegions,
} from './accessible-names'

/**
 * NF37: `CopyableCommand` named its `<pre>` `aria-label="Restart command"` and
 * was then rendered a third time with `orchestron token rotate`. axe reported
 * nothing — it checks a name exists, never that it is true — so the guard here
 * is the source-level property instead: a name built from the content cannot
 * disagree with it.
 *
 * No DOM in this suite, so nothing renders. The call-site assertions read
 * `app/settings/page.tsx` from disk and resolve what each of the three
 * `CopyableCommand` invocations would compute.
 */

const WEB = join(__dirname, '..')
const SETTINGS = join(WEB, 'app/settings/page.tsx')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'node_modules' || e.name.startsWith('.')) return []
    const p = join(dir, e.name)
    if (e.isDirectory()) return sourceFiles(p)
    return e.name.endsWith('.tsx') ? [p] : []
  })
}

describe('commandRegionLabel', () => {
  it('names the block by the command it holds', () => {
    expect(commandRegionLabel('orchestron token rotate')).toBe('Command: orchestron token rotate')
  })

  it('gives three different commands three different names', () => {
    const names = [
      'systemctl --user restart orchestron-api.service orchestron-web.service',
      'launchctl kickstart -k gui/$(id -u)/com.orchestron.api',
      'orchestron token rotate',
    ].map((c) => commandRegionLabel(c))
    expect(new Set(names).size).toBe(3)
  })

  it('carries the whole command, not the part that fits the box', () => {
    const long = 'launchctl kickstart -k gui/$(id -u)/com.orchestron.api && launchctl kickstart -k gui/$(id -u)/com.orchestron.web'
    expect(commandRegionLabel(long)).toContain(long)
  })

  it('lets a call site name itself', () => {
    expect(commandRegionLabel('orchestron token rotate', 'Token rotation command')).toBe(
      'Token rotation command',
    )
  })

  it('falls back rather than announce an empty name', () => {
    expect(commandRegionLabel('orchestron token rotate', '   ')).toBe(
      'Command: orchestron token rotate',
    )
  })
})

describe('commandCopyLabel', () => {
  it('says which command it copies — three buttons called "Copy" are one name between them', () => {
    expect(commandCopyLabel('orchestron token rotate', false)).toBe('Copy orchestron token rotate')
  })

  it('announces the state the icon shows', () => {
    expect(commandCopyLabel('orchestron token rotate', true)).toBe('Copied orchestron token rotate')
  })

  it('prefers an explicit label over the raw command', () => {
    expect(commandCopyLabel('orchestron token rotate', false, 'the rotation command')).toBe(
      'Copy the rotation command',
    )
  })
})

describe('findMisnamedDynamicRegions', () => {
  it('flags the NF37 shape — a fixed name over content the caller chose', () => {
    const found = findMisnamedDynamicRegions(
      'X.tsx',
      [
        '<pre',
        '  tabIndex={0}',
        '  role="group"',
        '  aria-label="Restart command"',
        '  className="overflow-x-auto whitespace-pre"',
        '>',
        '  {command}',
        '</pre>',
      ].join('\n'),
    )
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      reason: 'literal-name-on-dynamic-content',
      content: '{command}',
      name: 'Restart command',
      line: 1,
    })
  })

  it('accepts a name derived from the same value', () => {
    expect(
      findMisnamedDynamicRegions(
        'X.tsx',
        [
          '<pre',
          '  role="group"',
          '  aria-label={commandRegionLabel(command, label)}',
          '>',
          '  {command}',
          '</pre>',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('accepts a template name that reaches into the same object', () => {
    expect(
      findMisnamedDynamicRegions(
        'X.tsx',
        [
          '<pre',
          '  role="group"',
          '  aria-label={`Tool result, ${entry.content.length} characters`}',
          '>',
          '  {entry.content}',
          '</pre>',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('flags a computed name that shares nothing with what it names', () => {
    const found = findMisnamedDynamicRegions(
      'X.tsx',
      ['<pre', '  aria-label={`${kind} output`}', '>', '  {entry.content}', '</pre>'].join('\n'),
    )
    expect(found).toHaveLength(1)
    expect(found[0].reason).toBe('name-unrelated-to-content')
  })

  it('leaves literal content alone — a fixed name cannot drift from fixed text', () => {
    expect(
      findMisnamedDynamicRegions(
        'X.tsx',
        ['<button aria-label="Close">', '  Close', '</button>'].join('\n'),
      ),
    ).toEqual([])
  })

  it('leaves JSX content alone — an icon is not text the name could contradict', () => {
    expect(
      findMisnamedDynamicRegions(
        'X.tsx',
        [
          '<button aria-label="Dismiss">',
          '  {copied ? <Check className="w-3" /> : <Copy className="w-3" />}',
          '</button>',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('leaves a self-closing element alone — it has no content to disagree with', () => {
    expect(
      findMisnamedDynamicRegions('X.tsx', ['<input aria-label="From date" value={from} />'].join('\n')),
    ).toEqual([])
  })

  it('defers to aria-labelledby — the name lives in another element', () => {
    expect(
      findMisnamedDynamicRegions(
        'X.tsx',
        ['<pre aria-labelledby="cmd-1" aria-label="Restart command">', '  {command}', '</pre>'].join(
          '\n',
        ),
      ),
    ).toEqual([])
  })
})

describe('the three /settings command blocks', () => {
  const source = readFileSync(SETTINGS, 'utf8')

  /** The `command=` expression of each `<CopyableCommand …/>`, in page order. */
  const callSites = [...source.matchAll(/<CopyableCommand\s+command=(?:\{(\w+)\}|"([^"]*)")/g)].map(
    (m) => m[1] ?? m[2],
  )

  /** `const name = '…'` string constants the call sites refer to. */
  function resolve(expr: string): string {
    if (!/^\w+$/.test(expr)) return expr
    const decl = new RegExp(`const ${expr} = '([^']*)'`).exec(source)
    return decl ? decl[1] : expr
  }

  it('finds all three', () => {
    expect(callSites).toHaveLength(3)
  })

  it('names each one after its own command, so none inherits another\'s', () => {
    const names = callSites.map((c) => commandRegionLabel(resolve(c)))
    expect(names).toEqual([
      'Command: systemctl --user restart orchestron-api.service orchestron-web.service',
      'Command: launchctl kickstart -k gui/$(id -u)/com.orchestron.api && launchctl kickstart -k gui/$(id -u)/com.orchestron.web',
      'Command: orchestron token rotate',
    ])
    expect(new Set(names).size).toBe(3)
  })

  it('does not announce the rotation block as a restart', () => {
    const rotate = callSites.find((c) => resolve(c).includes('token rotate'))
    expect(rotate).toBeDefined()
    expect(commandRegionLabel(resolve(rotate!))).not.toMatch(/restart/i)
    expect(commandCopyLabel(resolve(rotate!), false)).not.toMatch(/restart/i)
  })

  it('gives the three copy buttons three names', () => {
    const names = callSites.map((c) => commandCopyLabel(resolve(c), false))
    expect(new Set(names).size).toBe(3)
  })

  it('holds no literal name anywhere in the component', () => {
    expect(source).not.toMatch(/aria-label="/)
  })
})

describe('no named element in the app contradicts its own content', () => {
  const files = sourceFiles(WEB)

  it('finds the app to scan', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('scans the two elements whose whole content is a caller-supplied value', () => {
    const scanned = files.flatMap((f) => {
      const src = readFileSync(f, 'utf8')
      // Re-run with every name blanked to a literal: whatever the scanner then
      // reports is the set it is actually looking at. A scanner that silently
      // stopped matching would report none and pass the check below vacuously.
      return findMisnamedDynamicRegions(
        f.slice(WEB.length + 1),
        src.replace(/aria-label=\{[\s\S]*?\}\s*$/gm, 'aria-label="x"'),
      )
    })
    expect(scanned.map((s) => `${s.file}:${s.line}`)).toEqual([
      'app/settings/page.tsx:55',
      'components/TranscriptPanePoll.tsx:181',
    ])
  })

  it('reports none misnamed', () => {
    const offenders = files.flatMap((f) =>
      findMisnamedDynamicRegions(f.slice(WEB.length + 1), readFileSync(f, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
