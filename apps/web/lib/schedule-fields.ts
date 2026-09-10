import type { AgentType, EffortLevel } from '@agent-hq-orchestron/shared'
import { implicitDefaultModel, implicitDefaultEffort } from './models'

/** The slice of a project the schedule form needs: enough to know which
 *  harness catalogs to offer and what "Default" will resolve to. */
export interface ScheduleProjectOption {
  id: string
  name: string
  agentType?: AgentType
  defaultModel?: string
  defaultEffort?: EffortLevel
  defaultUseTmux?: boolean
}

/** Where a displayed default came from — the project's own setting, or the
 *  harness fallback that applies when the project set nothing. */
export type DefaultSource = 'project' | 'harness'

export interface ScheduleFieldDefaults {
  model?: string
  modelSource: DefaultSource
  effort?: string
  effortSource: DefaultSource
  /** No third state: a project that set nothing means tmux. */
  useTmux: boolean
}

/**
 * What the three unpinned fields will resolve to for a given project.
 *
 * Derived from the project on every render rather than copied into form
 * state, so switching the project dropdown re-labels the "Default" rows
 * immediately — and, more importantly, so the labels can never drift from the
 * project they claim to describe.
 */
export function scheduleFieldDefaults(project: ScheduleProjectOption | undefined): ScheduleFieldDefaults {
  return {
    model: project?.defaultModel ?? implicitDefaultModel(project?.agentType),
    modelSource: project?.defaultModel ? 'project' : 'harness',
    effort: project?.defaultEffort ?? implicitDefaultEffort(project?.agentType),
    effortSource: project?.defaultEffort ? 'project' : 'harness',
    useTmux: project?.defaultUseTmux ?? true,
  }
}

/** Label for the leading "leave it to the project" row of a model/effort
 *  dropdown. Names the value the schedule will actually fire with, so the
 *  choice is between two concrete models rather than between one model and a
 *  blank. */
export function defaultRowLabel(value: string | undefined, source: DefaultSource): string {
  if (!value) return 'Default (project setting)'
  return `Default — ${value}${source === 'harness' ? ' (harness)' : ' (project)'}`
}

export interface ScheduleFormValues {
  projectId: string
  cron: string
  prompt: string
  enabled: boolean
  /** `''` = follow the project. */
  model: string
  /** `''` = follow the project. */
  effort: string
  /** `null` = follow the project. */
  useTmuxOverride: boolean | null
}

/**
 * The request body for create (POST) or edit (PATCH).
 *
 * The two differ in how they say "no override": a create simply omits the
 * field, while an edit has to send the *clear* spelling — `''`, or `null` for
 * the boolean — because on a PATCH an absent key already means "leave whatever
 * is stored alone". Without that an edit could add an override but never take
 * one back off.
 *
 * With the global headless switch off, the mode is left out of the payload
 * entirely rather than sent as `true`. The dialog is not showing that control,
 * so it has no business rewriting the field: a schedule already configured
 * headless keeps its stored preference and gets it back when the switch is
 * flipped on again, and until then the coercion at fire time is what actually
 * decides the mode.
 */
export function buildSchedulePayload(
  values: ScheduleFormValues,
  opts: { isEdit: boolean; headlessEnabled: boolean },
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    projectId: values.projectId,
    cron: values.cron.trim(),
    prompt: values.prompt.trim(),
    enabled: values.enabled,
  }

  if (opts.isEdit) {
    payload.model = values.model
    payload.effort = values.effort
  } else {
    if (values.model) payload.model = values.model
    if (values.effort) payload.effort = values.effort
  }

  if (opts.headlessEnabled) {
    if (opts.isEdit) payload.useTmux = values.useTmuxOverride
    else if (values.useTmuxOverride !== null) payload.useTmux = values.useTmuxOverride
  }

  return payload
}

export interface ScheduleOverrideBadge {
  key: 'mode' | 'model' | 'effort'
  label: string
  title: string
}

/**
 * Small badges for the schedules list, one per field the schedule pins for
 * itself. A field it leaves to the project gets nothing — most schedules pin
 * nothing at all, and a row of "default / default / default" would be noise on
 * every card.
 *
 * The mode badge drops out entirely while the global headless switch is off:
 * every schedule fires tmux in that state regardless of what it stored, so
 * showing "headless" would describe something that is not going to happen.
 */
export function scheduleOverrideBadges(
  schedule: { model?: string; effort?: string; useTmux?: boolean },
  headlessEnabled: boolean,
): ScheduleOverrideBadge[] {
  const badges: ScheduleOverrideBadge[] = []
  if (headlessEnabled && schedule.useTmux !== undefined) {
    badges.push(
      schedule.useTmux
        ? { key: 'mode', label: 'tmux', title: 'Runs in tmux — overrides the project default' }
        : { key: 'mode', label: 'headless', title: 'Runs headless — overrides the project default' },
    )
  }
  if (schedule.model) {
    badges.push({ key: 'model', label: schedule.model, title: `Model ${schedule.model} — overrides the project default` })
  }
  if (schedule.effort) {
    badges.push({ key: 'effort', label: `effort ${schedule.effort}`, title: `Effort ${schedule.effort} — overrides the project default` })
  }
  return badges
}
