import { describe, it, expect } from 'vitest'
import { DEFAULT_USE_TMUX, resolveUseTmux, isHeadless } from '@agent-hq-orchestron/shared'

/**
 * The whole headless feature rests on one rule: an absent `useTmux` means
 * tmux. Every session and project record written before the toggle existed
 * has the field undefined, and they are all tmux sessions — so a bare
 * truthiness test would reclassify the entire existing fleet as headless.
 * These cases pin the nullish semantics so a later refactor to `||` or
 * `!useTmux` fails here instead of in production.
 */
describe('resolveUseTmux', () => {
  it('defaults to tmux', () => {
    expect(DEFAULT_USE_TMUX).toBe(true)
    expect(resolveUseTmux()).toBe(true)
  })

  it.each([
    ['both undefined', undefined, undefined, true],
    ['both null', null, null, true],
    ['session undefined, project true', undefined, true, true],
    ['session undefined, project false', undefined, false, false],
    ['session null, project false', null, false, false],
    ['session true wins over project false', true, false, true],
    ['session false wins over project true', false, true, false],
    ['session false, project undefined', false, undefined, false],
    ['session true, project undefined', true, undefined, true],
  ] as const)('%s → %s', (_label, session, project, expected) => {
    expect(resolveUseTmux(session, project)).toBe(expected)
    expect(isHeadless(session, project)).toBe(!expected)
  })

  it('does not treat false as unset — the failure mode a || cascade would have', () => {
    // `session ?? project` keeps false; `session || project` would discard it
    // and silently promote an explicit headless request back to tmux.
    expect(resolveUseTmux(false, true)).toBe(false)
  })
})
