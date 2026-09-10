import type { AgentType, EffortLevel } from '@agent-hq-orchestron/shared'
import { implicitDefaultModel, implicitDefaultEffort } from './models'

/**
 * The slice of a project every spawn-shaped form needs: enough to know which
 * harness catalogs to offer, where the session will run, and what the fields
 * left unpinned will resolve to.
 *
 * `path` and `configDir` are optional because not every caller has them — a
 * form that only picks a model does not need to show a workspace.
 */
export interface ProjectFormOption {
  id: string
  name: string
  agentType?: AgentType
  path?: string
  /** Resolved from `project.agentConfig.env` — see `projectConfigDir()`. */
  configDir?: string
  defaultModel?: string
  defaultEffort?: EffortLevel
  defaultUseTmux?: boolean
}

/** Where a displayed default came from — the project's own setting, or the
 *  harness fallback that applies when the project set nothing. */
export type DefaultSource = 'project' | 'harness'

export interface ProjectFieldDefaults {
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
export function projectFieldDefaults(project: ProjectFormOption | undefined): ProjectFieldDefaults {
  return {
    model: project?.defaultModel ?? implicitDefaultModel(project?.agentType),
    modelSource: project?.defaultModel ? 'project' : 'harness',
    effort: project?.defaultEffort ?? implicitDefaultEffort(project?.agentType),
    effortSource: project?.defaultEffort ? 'project' : 'harness',
    useTmux: project?.defaultUseTmux ?? true,
  }
}

/** Label for the leading "leave it to the project" row of a model/effort
 *  dropdown. Names the value the form will actually fire with, so the choice
 *  is between two concrete models rather than between one model and a blank. */
export function defaultRowLabel(value: string | undefined, source: DefaultSource): string {
  if (!value) return 'Default (project setting)'
  return `Default — ${value}${source === 'harness' ? ' (harness)' : ' (project)'}`
}

/** The env var each harness reads its config directory from. */
export function configDirEnvName(agentType: AgentType | undefined): string {
  return agentType === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
}

/** Where the harness looks when the project overrides nothing. */
export function configDirFallback(agentType: AgentType | undefined): string {
  return agentType === 'codex' ? '~/.codex' : '~/.claude'
}

/** Pull the config dir a project pins out of its agent config. The env var
 *  differs per harness, and three dialogs were each spelling this out. */
export function projectConfigDir(
  project: { agentType?: AgentType; agentConfig?: { env?: Record<string, string> } } | undefined,
): string | undefined {
  if (!project) return undefined
  return project.agentConfig?.env?.[configDirEnvName(project.agentType)]
}

export interface ProjectInfoRow {
  key: 'agent' | 'workspace' | 'configDir' | 'model' | 'effort'
  label: string
  value: string
  /** Parenthetical shown after the value — where the value came from. */
  note?: string
  /** Tooltip, for rows whose provenance is worth spelling out. */
  title?: string
  /** Long values that need `break-all` rather than overflowing the dialog. */
  wrap?: boolean
}

/**
 * The read-only facts a project contributes to a spawn: which harness runs,
 * where, under which config dir, and what model/effort a field left on
 * "Default" will land on.
 *
 * A pure builder rather than JSX so the rows can be asserted in a node test
 * and rendered into a static preview page — the dialog markup itself has no
 * test environment. Rows a project has nothing to say about are omitted
 * rather than rendered blank.
 */
export function projectInfoRows(project: ProjectFormOption | undefined): ProjectInfoRow[] {
  if (!project) return []
  const rows: ProjectInfoRow[] = []
  const defaults = projectFieldDefaults(project)

  if (project.agentType) {
    rows.push({ key: 'agent', label: 'agent', value: project.agentType })
  }
  if (project.path) {
    rows.push({ key: 'workspace', label: 'workspace', value: project.path, wrap: true })
  }

  const envName = configDirEnvName(project.agentType)
  rows.push({
    key: 'configDir',
    label: envName.toLowerCase().replace(/_/g, ' '),
    value: project.configDir ?? configDirFallback(project.agentType),
    note: project.configDir ? undefined : 'harness default',
    title: `${envName} (from project.agentConfig.env)`,
    wrap: true,
  })

  if (defaults.model) {
    rows.push({
      key: 'model',
      label: 'default model',
      value: defaults.model,
      note: defaults.modelSource,
    })
  }
  if (defaults.effort) {
    rows.push({
      key: 'effort',
      label: 'default effort',
      value: defaults.effort,
      note: defaults.effortSource,
    })
  }
  return rows
}
