import { describe, it, expect } from 'vitest'
import { buildProjectBody, type ProjectFormInput } from './project-body'

const BASE: ProjectFormInput = {
  name: '  Orchestron  ',
  path: '  /home/x/Works/orchestron  ',
  agentType: 'claude',
  defaultModel: '',
  defaultEffort: '',
  defaultUseTmux: true,
  claudeConfigDir: '',
  codexHome: '',
  group: '',
  tags: '',
  extraEnvPairs: [],
  extraArgs: '',
}

function form(over: Partial<ProjectFormInput> = {}): ProjectFormInput {
  return { ...BASE, ...over }
}

describe('buildProjectBody — update sends an explicit clear (B6-F2)', () => {
  it('sends null for every clearable field left empty', () => {
    const body = buildProjectBody(form(), { isUpdate: true })
    expect(body.defaultModel).toBeNull()
    expect(body.defaultEffort).toBeNull()
    expect(body.agentConfig).toBeNull()
  })

  it('has the clearable keys present, not merely undefined', () => {
    // The whole defect was omission: `{...(x ? {x} : {})}` produced a body
    // with no key at all, which the shallow merge read as "keep".
    const body = buildProjectBody(form(), { isUpdate: true })
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(['defaultModel', 'defaultEffort', 'agentConfig']),
    )
    expect(JSON.parse(JSON.stringify(body))).toMatchObject({
      defaultModel: null,
      defaultEffort: null,
      agentConfig: null,
    })
  })

  it('sends the chosen values when they are set', () => {
    const body = buildProjectBody(
      form({ defaultModel: 'claude-haiku-4-5', defaultEffort: 'medium' }),
      { isUpdate: true },
    )
    expect(body.defaultModel).toBe('claude-haiku-4-5')
    expect(body.defaultEffort).toBe('medium')
  })

  it('never sends an empty string — empty means null, and "" is a 400', () => {
    const body = buildProjectBody(form({ defaultModel: '', defaultEffort: '' }), {
      isUpdate: true,
    })
    expect(body.defaultModel).not.toBe('')
    expect(body.defaultEffort).not.toBe('')
  })
})

describe('buildProjectBody — create omits instead of nulling', () => {
  it('omits clearable fields left empty (RegisterProjectBodySchema rejects null)', () => {
    const body = buildProjectBody(form(), { isUpdate: false })
    expect('defaultModel' in body).toBe(false)
    expect('defaultEffort' in body).toBe(false)
    expect('agentConfig' in body).toBe(false)
  })

  it('includes them when set', () => {
    const body = buildProjectBody(
      form({ defaultModel: 'claude-opus-5', defaultEffort: 'high' }),
      { isUpdate: false },
    )
    expect(body.defaultModel).toBe('claude-opus-5')
    expect(body.defaultEffort).toBe('high')
  })
})

describe('buildProjectBody — fields that were already always-sent', () => {
  it('sends defaultUseTmux false rather than dropping it', () => {
    const body = buildProjectBody(form({ defaultUseTmux: false }), { isUpdate: true })
    expect(body.defaultUseTmux).toBe(false)
  })

  it('trims name and path, nulls a blank group, drops blank tags', () => {
    const body = buildProjectBody(form({ tags: ' a , , b ' }), { isUpdate: true })
    expect(body.name).toBe('Orchestron')
    expect(body.path).toBe('/home/x/Works/orchestron')
    expect(body.group).toBeNull()
    expect(body.tags).toEqual(['a', 'b'])
  })
})

describe('buildProjectBody — agentConfig assembly', () => {
  it('keeps CLAUDE_CONFIG_DIR for a claude project and drops CODEX_HOME', () => {
    const body = buildProjectBody(
      form({ agentType: 'claude', claudeConfigDir: '/cfg/claude', codexHome: '/cfg/codex' }),
      { isUpdate: true },
    )
    expect(body.agentConfig?.env).toEqual({ CLAUDE_CONFIG_DIR: '/cfg/claude' })
  })

  it('keeps CODEX_HOME for a codex project and drops CLAUDE_CONFIG_DIR', () => {
    const body = buildProjectBody(
      form({ agentType: 'codex', claudeConfigDir: '/cfg/claude', codexHome: '/cfg/codex' }),
      { isUpdate: true },
    )
    expect(body.agentConfig?.env).toEqual({ CODEX_HOME: '/cfg/codex' })
  })

  it('carries extraEnvPairs and extraArgs', () => {
    const body = buildProjectBody(
      form({ extraEnvPairs: [{ key: 'FOO', value: 'bar' }], extraArgs: '--verbose, --debug' }),
      { isUpdate: true },
    )
    expect(body.agentConfig).toEqual({
      env: { FOO: 'bar' },
      extraArgs: ['--verbose', '--debug'],
    })
  })

  it('clearing every agentConfig input yields null on update, not {}', () => {
    // `{}` would merge as an empty object and still overwrite — but it
    // would also read as "configured with nothing". null deletes the key.
    const body = buildProjectBody(
      form({ extraEnvPairs: [], extraArgs: '  ,  ', claudeConfigDir: '' }),
      { isUpdate: true },
    )
    expect(body.agentConfig).toBeNull()
  })
})
