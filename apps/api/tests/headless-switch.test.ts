import { describe, it, expect } from 'vitest'
import {
  applyHeadlessSwitch,
  headlessCoercion,
  HEADLESS_COERCED_REASON,
} from '@agent-hq-orchestron/shared'

/**
 * The masking rule, pinned at its source. Route, session-manager and the
 * web toast all defer to `applyHeadlessSwitch`, so these cases are the
 * only place the semantics are actually stated.
 *
 * The distinction that matters most: `undefined` requested is NOT a
 * coercion. Nobody expressed a preference, so nothing got overridden —
 * and if this drifted, every ordinary spawn made while the switch is off
 * would pop a toast telling the user their headless request was denied.
 */
describe('applyHeadlessSwitch — switch on', () => {
  it.each([
    ['explicit headless survives', false, false],
    ['explicit tmux survives', true, true],
    ['unset resolves to tmux', undefined, true],
  ] as const)('%s', (_label, requested, expected) => {
    expect(applyHeadlessSwitch(requested, true)).toEqual({ useTmux: expected, coerced: false })
  })
})

describe('applyHeadlessSwitch — switch off', () => {
  it('turns an explicit headless request into tmux and reports it', () => {
    expect(applyHeadlessSwitch(false, false)).toEqual({ useTmux: true, coerced: true })
  })

  it('leaves an explicit tmux request alone and reports nothing', () => {
    expect(applyHeadlessSwitch(true, false)).toEqual({ useTmux: true, coerced: false })
  })

  it('does not call an unset preference a coercion', () => {
    // The case that would otherwise toast on every spawn in the fleet.
    expect(applyHeadlessSwitch(undefined, false)).toEqual({ useTmux: true, coerced: false })
  })

  it('never returns headless, whatever it was handed', () => {
    for (const requested of [true, false, undefined] as const) {
      expect(applyHeadlessSwitch(requested, false).useTmux).toBe(true)
    }
  })
})

describe('headlessCoercion', () => {
  it('builds the exact payload a client keys off', () => {
    expect(headlessCoercion(true)).toEqual({
      useTmux: true,
      reason: HEADLESS_COERCED_REASON,
    })
  })

  it('is undefined when nothing was coerced, so presence is the signal', () => {
    // Clients check `body.coerced` alone rather than inspecting values;
    // an always-present object with `useTmux: false` would break that.
    expect(headlessCoercion(false)).toBeUndefined()
  })
})

describe('coercion reason', () => {
  it('is a stable wire value', () => {
    // Pinned because it goes out in a response body and into log lines
    // that someone will grep. Display copy is deliberately elsewhere —
    // apps/web/lib/notice.ts — so this stays machine-shaped.
    expect(HEADLESS_COERCED_REASON).toBe('headless disabled globally')
  })
})
