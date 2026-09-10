import { describe, it, expect } from 'vitest'
import {
  scheduleFieldDefaults,
  defaultRowLabel,
  buildSchedulePayload,
  scheduleOverrideBadges,
  type ScheduleFormValues,
  type ScheduleProjectOption,
} from './schedule-fields'

const claudeProject: ScheduleProjectOption = {
  id: 'p1', name: 'Claude project', agentType: 'claude',
  defaultModel: 'claude-opus-5', defaultEffort: 'high', defaultUseTmux: false,
}

const bareCodexProject: ScheduleProjectOption = {
  id: 'p2', name: 'Codex project', agentType: 'codex',
}

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

describe('scheduleFieldDefaults', () => {
  it("reports the project's own settings when it has them", () => {
    expect(scheduleFieldDefaults(claudeProject)).toEqual({
      model: 'claude-opus-5', modelSource: 'project',
      effort: 'high', effortSource: 'project',
      useTmux: false,
    })
  })

  it('falls back to the harness defaults for a project that pins nothing', () => {
    expect(scheduleFieldDefaults(bareCodexProject)).toEqual({
      model: 'gpt-6-astra', modelSource: 'harness',
      effort: 'medium', effortSource: 'harness',
      useTmux: true,
    })
  })

  it('changes with the project, which is what re-labels the dropdowns', () => {
    expect(scheduleFieldDefaults(claudeProject).model)
      .not.toBe(scheduleFieldDefaults(bareCodexProject).model)
  })

  it('leaves the model unknown for a claude project with no default', () => {
    // The harness fallback there depends on the operator's own settings, so
    // the dialog shows a blank rather than guessing.
    const d = scheduleFieldDefaults({ id: 'p3', name: 'Bare', agentType: 'claude' })
    expect(d.model).toBeUndefined()
    expect(d.useTmux).toBe(true)
  })

  it('treats no project at all as the empty case', () => {
    expect(scheduleFieldDefaults(undefined).useTmux).toBe(true)
  })
})

describe('defaultRowLabel', () => {
  it('names the value the schedule will fire with, and where it came from', () => {
    expect(defaultRowLabel('claude-opus-5', 'project')).toBe('Default — claude-opus-5 (project)')
    expect(defaultRowLabel('gpt-6-astra', 'harness')).toBe('Default — gpt-6-astra (harness)')
  })

  it('falls back to a bare label when there is no value to name', () => {
    expect(defaultRowLabel(undefined, 'harness')).toBe('Default (project setting)')
  })
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
