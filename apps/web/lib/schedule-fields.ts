import type { ProjectFormOption } from './project-info'

/** The schedule form talks about projects in exactly the same terms the spawn
 *  form does — see `lib/project-info.ts` for the shape and for what an
 *  unpinned model/effort/mode resolves to. */
export type ScheduleProjectOption = ProjectFormOption

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
