import { describe, it, expect } from 'vitest'
import {
  projectFieldDefaults,
  defaultRowLabel,
  projectConfigDir,
  projectInfoRows,
  configDirEnvName,
  configDirFallback,
  type ProjectFormOption,
} from './project-info'

const claudeProject: ProjectFormOption = {
  id: 'p1', name: 'Claude project', agentType: 'claude',
  path: '/home/adi/Works/orchestron',
  configDir: '/home/adi/ClaudeConfigs/adi',
  defaultModel: 'claude-opus-5', defaultEffort: 'high', defaultUseTmux: false,
}

const bareCodexProject: ProjectFormOption = {
  id: 'p2', name: 'Codex project', agentType: 'codex', path: '/home/adi/Works/other',
}

describe('projectFieldDefaults', () => {
  it("reports the project's own settings when it has them", () => {
    expect(projectFieldDefaults(claudeProject)).toEqual({
      model: 'claude-opus-5', modelSource: 'project',
      effort: 'high', effortSource: 'project',
      useTmux: false,
    })
  })

  it('falls back to the harness defaults for a project that pins nothing', () => {
    expect(projectFieldDefaults(bareCodexProject)).toEqual({
      model: 'gpt-6-astra', modelSource: 'harness',
      effort: 'medium', effortSource: 'harness',
      useTmux: true,
    })
  })

  it('changes with the project, which is what re-labels the dropdowns', () => {
    expect(projectFieldDefaults(claudeProject).model)
      .not.toBe(projectFieldDefaults(bareCodexProject).model)
  })

  it('leaves the model unknown for a claude project with no default', () => {
    // The harness fallback there depends on the operator's own settings, so
    // the dialog shows a blank rather than guessing.
    const d = projectFieldDefaults({ id: 'p3', name: 'Bare', agentType: 'claude' })
    expect(d.model).toBeUndefined()
    expect(d.useTmux).toBe(true)
  })

  it('treats no project at all as the empty case', () => {
    expect(projectFieldDefaults(undefined).useTmux).toBe(true)
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

describe('projectConfigDir', () => {
  it('reads the env var the harness actually looks at', () => {
    expect(projectConfigDir({
      agentType: 'claude',
      agentConfig: { env: { CLAUDE_CONFIG_DIR: '/cfg/claude', CODEX_HOME: '/cfg/codex' } },
    })).toBe('/cfg/claude')
    expect(projectConfigDir({
      agentType: 'codex',
      agentConfig: { env: { CLAUDE_CONFIG_DIR: '/cfg/claude', CODEX_HOME: '/cfg/codex' } },
    })).toBe('/cfg/codex')
  })

  it('is undefined for a project that pins nothing', () => {
    expect(projectConfigDir({ agentType: 'claude' })).toBeUndefined()
    expect(projectConfigDir(undefined)).toBeUndefined()
  })

  it('treats an unknown harness as claude, matching configDirEnvName', () => {
    expect(configDirEnvName(undefined)).toBe('CLAUDE_CONFIG_DIR')
    expect(configDirFallback(undefined)).toBe('~/.claude')
  })
})

describe('projectInfoRows', () => {
  it('renders nothing until a project is picked', () => {
    expect(projectInfoRows(undefined)).toEqual([])
  })

  it('describes a fully configured project in a fixed order', () => {
    const rows = projectInfoRows(claudeProject)
    expect(rows.map(r => r.key)).toEqual(['agent', 'workspace', 'configDir', 'model', 'effort'])
    expect(rows.map(r => [r.label, r.value])).toEqual([
      ['agent', 'claude'],
      ['workspace', '/home/adi/Works/orchestron'],
      ['claude config dir', '/home/adi/ClaudeConfigs/adi'],
      ['default model', 'claude-opus-5'],
      ['default effort', 'high'],
    ])
    // Its own config dir, so no "(harness default)" marker.
    expect(rows.find(r => r.key === 'configDir')!.note).toBeUndefined()
  })

  it('marks the config dir as the harness default when the project overrides nothing', () => {
    const cfg = projectInfoRows(bareCodexProject).find(r => r.key === 'configDir')!
    expect(cfg).toMatchObject({ label: 'codex home', value: '~/.codex', note: 'harness default' })
    expect(cfg.title).toContain('CODEX_HOME')
  })

  it('tags each default with where it came from', () => {
    expect(projectInfoRows(claudeProject).find(r => r.key === 'model')!.note).toBe('project')
    expect(projectInfoRows(bareCodexProject).find(r => r.key === 'model')!.note).toBe('harness')
  })

  it('omits rows the project has nothing to say about', () => {
    // No path, and a claude project with no model/effort of its own has no
    // harness fallback to name either — three rows simply do not appear.
    const rows = projectInfoRows({ id: 'p4', name: 'Bare claude', agentType: 'claude' })
    expect(rows.map(r => r.key)).toEqual(['agent', 'configDir'])
  })

  it('still names the config dir for a project with no agent type at all', () => {
    const rows = projectInfoRows({ id: 'p5', name: 'Unknown' })
    expect(rows.map(r => r.key)).toEqual(['configDir'])
    expect(rows[0]!.value).toBe('~/.claude')
  })

  it('flags the long values so the dialog wraps rather than overflows', () => {
    const rows = projectInfoRows(claudeProject)
    expect(rows.filter(r => r.wrap).map(r => r.key)).toEqual(['workspace', 'configDir'])
  })

  it('names the same defaults the dropdown rows do', () => {
    // The panel and the "Default — …" rows sit next to each other now; if
    // they ever disagreed, one of them would be lying about the same project.
    const d = projectFieldDefaults(claudeProject)
    const rows = projectInfoRows(claudeProject)
    expect(defaultRowLabel(d.model, d.modelSource))
      .toContain(rows.find(r => r.key === 'model')!.value)
    expect(defaultRowLabel(d.effort, d.effortSource))
      .toContain(rows.find(r => r.key === 'effort')!.value)
  })
})
