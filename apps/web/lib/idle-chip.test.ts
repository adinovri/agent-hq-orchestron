import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  formatIdleTimeout,
  formatIdleTooltip,
  isNearSleep,
  idleChipState,
  tickIntervalMs,
  DEFAULT_IDLE_TIMEOUT_MS,
  WARN_LEAD_MS,
  MIN_TICK_MS,
  MAX_TICK_MS,
} from './idle-chip'

describe('formatIdleTimeout', () => {
  it('renders the schema default the way the old hardcoded string did', () => {
    expect(formatIdleTimeout(DEFAULT_IDLE_TIMEOUT_MS)).toBe('15 min')
  })

  it('keeps sub-minute timeouts in seconds — the E2E instance runs 60s', () => {
    expect(formatIdleTimeout(30_000)).toBe('30s')
    expect(formatIdleTimeout(45_500)).toBe('46s')
    expect(formatIdleTimeout(60_000)).toBe('1 min')
  })

  it('renders hours past 60 minutes', () => {
    expect(formatIdleTimeout(60 * 60_000)).toBe('1h')
    expect(formatIdleTimeout(90 * 60_000)).toBe('1h 30m')
    expect(formatIdleTimeout(150 * 60_000)).toBe('2h 30m')
  })

  it('calls 0 and nonsense "disabled" rather than promising a sleep at 0 min', () => {
    expect(formatIdleTimeout(0)).toBe('disabled')
    expect(formatIdleTimeout(-1)).toBe('disabled')
    expect(formatIdleTimeout(NaN)).toBe('disabled')
  })
})

describe('formatIdleTooltip', () => {
  const since = new Date('2026-09-11T04:03:07Z')

  it('states the server threshold, not 15 min, on a tuned instance', () => {
    const text = formatIdleTooltip(since, 60_000)
    expect(text).toContain('Auto-sleeps at 1 min.')
    expect(text).not.toContain('15 min')
    expect(text).toContain(since.toLocaleTimeString())
  })

  it('still reads as before on a default instance', () => {
    expect(formatIdleTooltip(since, DEFAULT_IDLE_TIMEOUT_MS)).toBe(
      `Idle since ${since.toLocaleTimeString()}. Auto-sleeps at 15 min.`,
    )
  })

  it('accepts the ISO string the API actually sends', () => {
    expect(formatIdleTooltip(since.toISOString(), 60_000)).toBe(formatIdleTooltip(since, 60_000))
  })

  it('says so when auto-sleep is off instead of promising one', () => {
    expect(formatIdleTooltip(since, 0)).toContain('Auto-sleep is disabled on this server.')
  })

  it('degrades to "unknown" on an unparseable timestamp rather than "Invalid Date"', () => {
    expect(formatIdleTooltip('not-a-date', 60_000)).toBe('Idle since unknown. Auto-sleeps at 1 min.')
  })
})

describe('isNearSleep', () => {
  it('reproduces the old 10-minute rule exactly on the 15-minute default', () => {
    expect(isNearSleep(9 * 60_000 + 59_000, DEFAULT_IDLE_TIMEOUT_MS)).toBe(false)
    expect(isNearSleep(10 * 60_000, DEFAULT_IDLE_TIMEOUT_MS)).toBe(true)
  })

  it('fires at all on a 60s timeout — under the old rule it never did', () => {
    expect(isNearSleep(39_000, 60_000)).toBe(false)
    expect(isNearSleep(40_000, 60_000)).toBe(true)
    // The old hardcoded rule: 10 minutes of idling against a 60s timeout.
    // The session would have slept nine minutes earlier.
    expect(10 * 60_000 >= 10 * 60_000).toBe(true)
  })

  it('caps the warning lead so a long timeout is not amber for hours', () => {
    const twoHours = 2 * 60 * 60_000
    expect(isNearSleep(twoHours - WARN_LEAD_MS - 1000, twoHours)).toBe(false)
    expect(isNearSleep(twoHours - WARN_LEAD_MS, twoHours)).toBe(true)
  })

  it('never warns when auto-sleep is disabled', () => {
    expect(isNearSleep(10 * 60 * 60_000, 0)).toBe(false)
  })
})

describe('idleChipState', () => {
  const since = new Date('2026-09-11T04:00:00Z')

  it('gives the chip its label, colour and tooltip from one call', () => {
    const now = since.getTime() + 11 * 60_000
    expect(idleChipState(since, DEFAULT_IDLE_TIMEOUT_MS, now)).toEqual({
      idleMin: 11,
      nearSleep: true,
      title: `Idle since ${since.toLocaleTimeString()}. Auto-sleeps at 15 min.`,
    })
  })

  it('floors the minute count the way the chips did', () => {
    expect(idleChipState(since, DEFAULT_IDLE_TIMEOUT_MS, since.getTime() + 119_000).idleMin).toBe(1)
  })

  it('clamps a clock-skewed future idleSince to 0 rather than showing idle -3m', () => {
    const state = idleChipState(since, DEFAULT_IDLE_TIMEOUT_MS, since.getTime() - 180_000)
    expect(state.idleMin).toBe(0)
    expect(state.nearSleep).toBe(false)
  })
})

describe('the chips actually consume the server value', () => {
  // No DOM here (vitest.config.mts is node-only on purpose), so the wiring is
  // pinned at the source. That is exactly the gap NF13 fell through — a green
  // test against a stub — so these assert the real call, not a stand-in.
  const read = (rel: string) =>
    fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8')

  for (const file of ['components/SessionCard.tsx', 'components/SessionHeader.tsx']) {
    it(`${file} reads idleTimeoutMs from the health endpoint`, () => {
      const src = read(file)
      expect(src).toContain('useIdleTimeoutMs()')
      expect(src).toContain('useIdleChip(')
    })

    it(`${file} does not compute the chip during render (NF16)`, () => {
      // The frozen chip was exactly this call inline in JSX: `Date.now()` read
      // once, at the render that mounted it, with nothing to re-render it
      // afterwards. The hook is the only sanctioned caller now.
      const src = read(file)
      expect(src).not.toContain('idleChipState(')
      expect(src).toContain("from '@/lib/use-idle-chip'")
    })

    it(`${file} leaves the ticker unarmed outside the idle states`, () => {
      // Passing `null` rather than guarding the hook call keeps it
      // unconditional (rules of hooks) AND stops a running session from
      // holding a live interval for a chip it never shows.
      const src = read(file)
      expect(src).toMatch(/useIdleChip\(\s*\n?\s*session\.status === 'idle' \|\| session\.status === 'needs_input'\s*\? session\.idleSince\s*: null,/)
    })

    it(`${file} hardcodes no sleep threshold`, () => {
      const code = read(file)
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n')
      expect(code).not.toContain('Auto-sleeps at 15 min')
      expect(code).not.toMatch(/idleMin\s*>=\s*10/)
    })
  }
})

describe('tickIntervalMs', () => {
  it('gives the 60s E2E instance second resolution — the amber window is 20s wide', () => {
    expect(tickIntervalMs(60_000)).toBe(MIN_TICK_MS)
  })

  it('does not re-render a 15-minute instance 900 times', () => {
    expect(tickIntervalMs(DEFAULT_IDLE_TIMEOUT_MS)).toBe(MAX_TICK_MS)
  })

  it('keeps the counter within MAX_TICK_MS of the truth however long the threshold', () => {
    expect(tickIntervalMs(24 * 60 * 60_000)).toBe(MAX_TICK_MS)
  })

  it('never spins faster than MIN_TICK_MS on a pathologically small timeout', () => {
    expect(tickIntervalMs(1)).toBe(MIN_TICK_MS)
    expect(tickIntervalMs(5_000)).toBe(MIN_TICK_MS)
  })

  it('still ticks when auto-sleep is disabled — `idle Nm` keeps counting', () => {
    expect(tickIntervalMs(0)).toBe(MAX_TICK_MS)
    expect(tickIntervalMs(NaN)).toBe(MAX_TICK_MS)
  })
})

describe('the chip as a clock advances it (NF16)', () => {
  // No DOM, so the hook itself cannot be mounted here. What is testable — and
  // what actually broke — is that advancing `now` at the interval the hook
  // uses walks the chip through grey → amber and ages the counter. Before the
  // fix `now` never advanced at all, so this sequence never happened in a
  // browser however correct the arithmetic was.
  const since = new Date('2026-09-11T04:00:00Z')
  const tick = (timeout: number) => {
    const step = tickIntervalMs(timeout)
    const states: { t: number; idleMin: number; nearSleep: boolean }[] = []
    for (let t = 0; t <= timeout; t += step) {
      const { idleMin, nearSleep } = idleChipState(since, timeout, since.getTime() + t)
      states.push({ t, idleMin, nearSleep })
    }
    return states
  }

  it('turns amber exactly once on the 60s instance, 40s in', () => {
    const states = tick(60_000)
    const flips = states.filter((s, i) => i > 0 && s.nearSleep !== states[i - 1]!.nearSleep)
    expect(flips).toHaveLength(1)
    expect(flips[0]!.t).toBe(40_000)
    expect(states[0]!.nearSleep).toBe(false)
    expect(states[states.length - 1]!.nearSleep).toBe(true)
  })

  it('turns amber exactly once on the 15-minute default, 10 minutes in', () => {
    const states = tick(DEFAULT_IDLE_TIMEOUT_MS)
    const flips = states.filter((s, i) => i > 0 && s.nearSleep !== states[i - 1]!.nearSleep)
    expect(flips).toHaveLength(1)
    expect(flips[0]!.t).toBe(10 * 60_000)
  })

  it('ages the counter through every whole minute rather than freezing at 0', () => {
    const seen = [...new Set(tick(DEFAULT_IDLE_TIMEOUT_MS).map((s) => s.idleMin))]
    expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
  })
})
