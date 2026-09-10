import { describe, it, expect } from 'vitest'
import {
  buildSchedulePayload,
  scheduleOverrideBadges,
  type ScheduleFormValues,
} from './schedule-fields'

// The project-shaped helpers the form also uses — what a field left on
// "Default" resolves to, and how that is labelled — live in lib/project-info
// and are covered by project-info.test.ts.

const form = (over: Partial<ScheduleFormValues> = {}): ScheduleFormValues => ({
  projectId: 'p1',
  cron: ' 0 9 * * 1 ',
  prompt: '  standup  ',
  enabled: true,
  model: '',
  effort: '',
  useTmuxOverride: null,
  ...over,
})

describe('buildSchedulePayload — create', () => {
  const opts = { isEdit: false, headlessEnabled: true }

  it('omits every field left at its default', () => {
    const payload = buildSchedulePayload(form(), opts)
    expect(payload).toEqual({ projectId: 'p1', cron: '0 9 * * 1', prompt: 'standup', enabled: true })
  })

  it('sends the fields the user pinned', () => {
    const payload = buildSchedulePayload(
      form({ model: 'claude-sonnet-5', effort: 'low', useTmuxOverride: false }),
      opts,
    )
    expect(payload).toMatchObject({ model: 'claude-sonnet-5', effort: 'low', useTmux: false })
  })

  it('sends an explicit tmux choice rather than dropping it as "the same as true"', () => {
    expect(buildSchedulePayload(form({ useTmuxOverride: true }), opts).useTmux).toBe(true)
  })
})

describe('buildSchedulePayload — edit', () => {
  const opts = { isEdit: true, headlessEnabled: true }

  it('sends the clear spellings so an override can be taken back off', () => {
    const payload = buildSchedulePayload(form(), opts)
    expect(payload.model).toBe('')
    expect(payload.effort).toBe('')
    expect(payload.useTmux).toBeNull()
  })

  it('sends pinned values as themselves', () => {
    const payload = buildSchedulePayload(
      form({ model: 'claude-opus-5', effort: 'max', useTmuxOverride: false }),
      opts,
    )
    expect(payload).toMatchObject({ model: 'claude-opus-5', effort: 'max', useTmux: false })
  })
})

describe('buildSchedulePayload — global headless switch off', () => {
  it('leaves the mode out of a create entirely', () => {
    const payload = buildSchedulePayload(
      form({ useTmuxOverride: false }),
      { isEdit: false, headlessEnabled: false },
    )
    expect('useTmux' in payload).toBe(false)
  })

  it('leaves the mode out of an edit, so a stored headless preference survives', () => {
    const payload = buildSchedulePayload(
      form({ useTmuxOverride: false }),
      { isEdit: true, headlessEnabled: false },
    )
    expect('useTmux' in payload).toBe(false)
    // The other two overrides are still editable while the switch is off.
    expect(payload.model).toBe('')
  })
})

describe('scheduleOverrideBadges', () => {
  it('shows nothing for a schedule that follows its project', () => {
    expect(scheduleOverrideBadges({}, true)).toEqual([])
  })

  it('badges each pinned field', () => {
    const badges = scheduleOverrideBadges(
      { model: 'claude-opus-5', effort: 'high', useTmux: false },
      true,
    )
    expect(badges.map(b => b.key)).toEqual(['mode', 'model', 'effort'])
    expect(badges.map(b => b.label)).toEqual(['headless', 'claude-opus-5', 'effort high'])
  })

  it('badges an explicit tmux choice too — it is still an override', () => {
    expect(scheduleOverrideBadges({ useTmux: true }, true)[0]).toMatchObject({ key: 'mode', label: 'tmux' })
  })

  it('drops the mode badge while the global switch is off', () => {
    const badges = scheduleOverrideBadges({ model: 'claude-opus-5', useTmux: false }, false)
    expect(badges.map(b => b.key)).toEqual(['model'])
  })
})
