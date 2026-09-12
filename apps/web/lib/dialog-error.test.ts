import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  dialogErrorAttrs,
  DIALOG_ERROR_ROLE,
  DIALOG_ERROR_ARIA_LIVE,
  DIALOG_ERROR_SLOT,
  findUnannouncedErrorSurfaces,
} from './dialog-error'
import { cn } from './utils'

/**
 * NF30: seven of the thirteen dialogs rendered a failed mutation as colour
 * only — no role, no live region, no slot — so a screen-reader operator got
 * silence from a dialog that had stayed open, which reads as "still working".
 *
 * There is no DOM in this suite (see `vitest.config.ts`), so the component is
 * not rendered here. What is asserted instead is the pair that actually keeps
 * the fix alive: the attribute set is one exported object, and no dialog in the
 * tree paints an error red without it.
 */

const COMPONENTS = join(__dirname, '..', 'components')

/**
 * Every dialog with a failure surface, by file. Thirteen dialog *instances*
 * live in these ten files — `SessionActionDialog` is Reopen, Fork and Respawn,
 * and `ProjectDialog` is both Register and Edit.
 */
const DIALOG_FILES = [
  'SpawnDialog.tsx',
  'ScheduleDialog.tsx',
  'AdoptSessionDialog.tsx',
  'ImportSessionDialog.tsx',
  'DeleteRecordDialog.tsx',
  'SessionActionDialog.tsx',
  'SessionMetadataEditDialog.tsx',
  'ProjectDialog.tsx',
  'DeleteProjectDialog.tsx',
  'KillConfirmDialog.tsx',
]

describe('dialog error attributes', () => {
  it('announces assertively and is addressable', () => {
    expect(dialogErrorAttrs).toEqual({
      role: 'alert',
      'aria-live': 'assertive',
      'data-slot': 'dialog-error',
    })
    expect(DIALOG_ERROR_ROLE).toBe('alert')
    expect(DIALOG_ERROR_ARIA_LIVE).toBe('assertive')
    expect(DIALOG_ERROR_SLOT).toBe('dialog-error')
  })

  it('is spread by the shared component rather than retyped', () => {
    const src = readFileSync(join(COMPONENTS, 'ui', 'dialog-error.tsx'), 'utf8')
    const body = src.slice(src.indexOf('export function DialogError'))
    expect(body).toContain('dialogErrorAttrs')
    // If someone hand-writes the role back into the element, the constants stop
    // being the single source and this fix can rot one attribute at a time.
    // (The prose above the function may still explain `role="alert"`; only the
    // rendered element is held to this.)
    expect(body).not.toContain('role=')
  })
})

describe('the in-body gutter override', () => {
  it('drops the outer margin rather than fighting it', () => {
    // The seven dialogs fixed for NF30 render the message inside an already
    // padded body and pass `mx-0 mb-0`. That only works because `cn` runs
    // tailwind-merge — string concatenation would leave `mx-4` winning or
    // losing by stylesheet order, which is how a dialog ends up double-padded.
    const merged = cn('mx-4 mb-3 flex items-start gap-2 rounded px-3 py-2', 'mx-0 mb-0')
    expect(merged).toContain('mx-0')
    expect(merged).toContain('mb-0')
    expect(merged).not.toContain('mx-4')
    expect(merged).not.toContain('mb-3')
    // and the rest of the box survives
    expect(merged).toContain('px-3')
  })
})

describe('findUnannouncedErrorSurfaces', () => {
  it('flags a bare red error surface', () => {
    const found = findUnannouncedErrorSurfaces(
      'X.tsx',
      `        <div>\n          {error && <p className="text-sm text-red-500">{error}</p>}\n        </div>\n`,
    )
    expect(found).toHaveLength(1)
    expect(found[0].line).toBe(2)
    expect(found[0].file).toBe('X.tsx')
  })

  it('flags a multi-line one, where the message is three lines below the tag', () => {
    const found = findUnannouncedErrorSurfaces(
      'X.tsx',
      [
        '{mut.error && (',
        '  <div className="rounded border border-red-300 px-3 py-2 text-xs">',
        '    <span>',
        '      {(mut.error as Error).message}',
        '    </span>',
        '  </div>',
        ')}',
      ].join('\n'),
    )
    expect(found).toHaveLength(1)
    expect(found[0].line).toBe(2)
  })

  it('accepts the shared component', () => {
    expect(
      findUnannouncedErrorSurfaces(
        'X.tsx',
        `<DialogError message={error} className="mx-0 mb-0" />\n`,
      ),
    ).toEqual([])
  })

  it('accepts a hand-rolled surface that does announce', () => {
    expect(
      findUnannouncedErrorSurfaces(
        'X.tsx',
        `<div role="alert" className="text-sm text-red-500">{error}</div>\n`,
      ),
    ).toEqual([])
  })

  it('accepts a role carried by the wrapper two lines above', () => {
    expect(
      findUnannouncedErrorSurfaces(
        'X.tsx',
        [
          '<div role="alert" className="rounded border border-red-300">',
          '  <div className="flex text-red-700">',
          '    <span>{validation.error}</span>',
          '  </div>',
          '</div>',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('ignores red that is not an error — a required-field asterisk', () => {
    expect(
      findUnannouncedErrorSurfaces(
        'X.tsx',
        [
          '{spec.required && <span className="text-red-500 ml-1">*</span>}',
          '<input value={vars[key] ?? \'\'} />',
        ].join('\n'),
      ),
    ).toEqual([])
  })
})

describe('every dialog announces its failures', () => {
  it.each(DIALOG_FILES)('%s renders errors through DialogError', (file) => {
    const src = readFileSync(join(COMPONENTS, file), 'utf8')
    expect(src).toContain("from '@/components/ui/dialog-error'")
    expect(src).toContain('<DialogError')
  })

  it('leaves no unannounced error surface anywhere in components/', () => {
    const offenders = DIALOG_FILES.flatMap((file) =>
      findUnannouncedErrorSurfaces(file, readFileSync(join(COMPONENTS, file), 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
