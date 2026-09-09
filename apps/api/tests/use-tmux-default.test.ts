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

/**
 * The same rule applied to the three-valued `useTmux` the revival routes
 * accept. Absent there means "keep the session's current mode", so the API
 * cannot collapse it to a boolean before it reaches the manager — an
 * untouched checkbox would otherwise read as a deliberate request for tmux
 * and convert every headless session the user merely reopened.
 */
describe('the revival override is a tri-state', () => {
  const resolveTarget = (override: boolean | undefined, sessionUseTmux: boolean | undefined) =>
    override ?? resolveUseTmux(sessionUseTmux)

  it.each([
    ['no override keeps a tmux session in tmux', undefined, true, true],
    ['no override keeps a headless session headless', undefined, false, false],
    ['no override keeps a legacy record in tmux', undefined, undefined, true],
    ['override true converts headless to tmux', true, false, true],
    ['override false converts tmux to headless', false, true, false],
    ['override false on a legacy record converts it', false, undefined, false],
    ['override true is a no-op on a tmux session', true, true, true],
  ] as const)('%s', (_label, override, session, expected) => {
    expect(resolveTarget(override, session)).toBe(expected)
  })
})
