/**
 * Builds the request body `ProjectDialog` sends, split out of the
 * component so the omit-vs-null rule is unit-testable (apps/web's vitest
 * is node-only — see vitest.config.ts).
 *
 * The rule, and why it exists: `PATCH /api/projects/:id` shallow-merges,
 * so an omitted key keeps the stored value. The dialog used to spread
 * `defaultModel` / `defaultEffort` / `agentConfig` in only when truthy,
 * which meant picking "— Harness default" omitted the key and the old
 * value survived. A project pinned to an expensive model could not be
 * un-pinned from the dashboard at all (B6-F2).
 *
 * So on **update** these three fields are always present: the chosen
 * value, or `null` to unset. On **create** there is nothing to clear, and
 * `RegisterProjectBodySchema` does not accept `null`, so an empty field
 * is simply omitted.
 */

export type EffortValue = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ProjectFormInput {
  name: string
  path: string
  agentType: 'claude' | 'codex' | 'opencode'
  defaultModel: string
  defaultEffort: string
  defaultUseTmux: boolean
  claudeConfigDir: string
  codexHome: string
  group: string
  tags: string
  extraEnvPairs: Array<{ key: string; value: string }>
  extraArgs: string
}

export interface AgentConfigBody {
  env?: Record<string, string>
  extraArgs?: string[]
}

export interface ProjectBody {
  name: string
  path: string
  agentType: 'claude' | 'codex' | 'opencode'
  defaultUseTmux: boolean
  group: string | null
  tags: string[]
  defaultModel?: string | null
  defaultEffort?: EffortValue | null
  agentConfig?: AgentConfigBody | null
}

/** The env block the dialog persists: the harness-specific config-dir var
 *  for the *selected* agent type only (so switching harness does not drag
 *  the other one along), plus any explicit key/value pairs. */
export function buildAgentEnv(form: ProjectFormInput): Record<string, string> {
  const env: Record<string, string> = {}
  if (form.agentType === 'claude' && form.claudeConfigDir.trim()) {
    env['CLAUDE_CONFIG_DIR'] = form.claudeConfigDir.trim()
  }
  if (form.agentType === 'codex' && form.codexHome.trim()) {
    env['CODEX_HOME'] = form.codexHome.trim()
  }
  form.extraEnvPairs.forEach(({ key, value }) => { if (key) env[key] = value })
  return env
}

export function buildProjectBody(
  form: ProjectFormInput,
  opts: { isUpdate: boolean },
): ProjectBody {
  const env = buildAgentEnv(form)
  const extraArgs = form.extraArgs.split(',').map((s) => s.trim()).filter(Boolean)

  const agentConfig: AgentConfigBody = {
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(extraArgs.length > 0 ? { extraArgs } : {}),
  }
  const hasAgentConfig = Object.keys(agentConfig).length > 0

  const body: ProjectBody = {
    name: form.name.trim(),
    path: form.path.trim(),
    agentType: form.agentType,
    // Always sent, on create as well as update: `false` is the meaningful
    // value here, so an "only when truthy" spread would make headless
    // unsavable. The three fields below now follow the same principle —
    // they just need `null` rather than `false` to say "nothing".
    defaultUseTmux: form.defaultUseTmux,
    group: form.group.trim() || null,
    tags: form.tags.split(',').map((s) => s.trim()).filter(Boolean),
  }

  if (opts.isUpdate) {
    body.defaultModel = form.defaultModel || null
    body.defaultEffort = (form.defaultEffort as EffortValue) || null
    body.agentConfig = hasAgentConfig ? agentConfig : null
  } else {
    if (form.defaultModel) body.defaultModel = form.defaultModel
    if (form.defaultEffort) body.defaultEffort = form.defaultEffort as EffortValue
    if (hasAgentConfig) body.agentConfig = agentConfig
  }

  return body
}
