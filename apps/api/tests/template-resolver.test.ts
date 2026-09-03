import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TemplateResolver, TemplateNotFoundError, TemplateValidationError } from '../src/domain/template-resolver.js'

let tmpDir: string
let resolver: TemplateResolver

function writeTemplate(name: string, content: string) {
  const dir = path.join(tmpDir, 'templates')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.md`), content, 'utf8')
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'template-resolver-test-'))
  resolver = new TemplateResolver(tmpDir)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('TemplateResolver — basic', () => {
  it('throws TemplateNotFoundError for missing template', async () => {
    await expect(resolver.resolve('nonexistent')).rejects.toThrowError(TemplateNotFoundError)
  })

  it('resolves template without variables', async () => {
    writeTemplate('simple', '---\nname: simple\n---\nHello world')
    const result = await resolver.resolve('simple')
    expect(result).toBe('Hello world')
  })
})

describe('TemplateResolver — required variables', () => {
  it('throws TemplateValidationError when required var missing', async () => {
    writeTemplate('req', `---
name: req
variables:
  ticket:
    type: string
    required: true
---
Ticket: {{vars.ticket}}`)
    await expect(resolver.resolve('req')).rejects.toThrowError(TemplateValidationError)
  })

  it('includes missing var name in error', async () => {
    writeTemplate('req', `---
name: req
variables:
  ticket:
    type: string
    required: true
---
{{vars.ticket}}`)
    const err = await resolver.resolve('req').catch(e => e)
    expect(err).toBeInstanceOf(TemplateValidationError)
    expect((err as TemplateValidationError).missing).toContain('ticket')
  })

  it('succeeds when required var is provided', async () => {
    writeTemplate('req', `---
name: req
variables:
  ticket:
    type: string
    required: true
---
Ticket: {{vars.ticket}}`)
    const result = await resolver.resolve('req', { vars: { ticket: 'ABC-123' } })
    expect(result).toBe('Ticket: ABC-123')
  })

  it('uses default value for optional var', async () => {
    writeTemplate('opt', `---
name: opt
variables:
  env:
    type: string
    required: false
    default: production
---
Env: {{vars.env}}`)
    const result = await resolver.resolve('opt')
    expect(result).toBe('Env: production')
  })
})

describe('TemplateResolver — namespace interpolation', () => {
  it('resolves {{project.name}} and {{project.path}}', async () => {
    writeTemplate('proj', `---\nname: proj\n---\nProject: {{project.name}} at {{project.path}}`)
    const result = await resolver.resolve('proj', {
      project: {
        id: 'proj-1',
        name: 'MyApp',
        path: '/tmp/myapp',
        agentType: 'claude',
        createdAt: new Date().toISOString(),
        config: {},
      },
    })
    expect(result).toContain('MyApp')
    expect(result).toContain('/tmp/myapp')
  })

  it('resolves {{date}} and {{date.iso}}', async () => {
    writeTemplate('dates', `---\nname: dates\n---\n{{date}} | {{date.iso}}`)
    const result = await resolver.resolve('dates')
    expect(result).toMatch(/\|/)
    // date.iso should be ISO format
    expect(result).toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('resolves {{user}}', async () => {
    writeTemplate('usr', `---\nname: usr\n---\nUser: {{user}}`)
    const result = await resolver.resolve('usr')
    expect(result).toContain('User:')
    expect(result.length).toBeGreaterThan('User:'.length)
  })

  it('resolves {{env.FOO}}', async () => {
    process.env['TEST_TPL_VAR'] = 'hello-env'
    writeTemplate('env', `---\nname: env\n---\n{{env.TEST_TPL_VAR}}`)
    const result = await resolver.resolve('env')
    expect(result).toBe('hello-env')
    delete process.env['TEST_TPL_VAR']
  })

  it('unresolved variable → empty string', async () => {
    writeTemplate('unknown', `---\nname: unknown\n---\nfoo {{undefined.key}} bar`)
    const result = await resolver.resolve('unknown')
    expect(result).toBe('foo  bar')
  })

  it('resolves {{vars.key}} from user-supplied vars', async () => {
    writeTemplate('vars', `---\nname: vars\n---\nHello {{vars.name}}`)
    const result = await resolver.resolve('vars', { vars: { name: 'World' } })
    expect(result).toBe('Hello World')
  })
})

describe('TemplateResolver — git context', () => {
  it('resolves {{git.branch}} in a real git repo', async () => {
    writeTemplate('git', `---\nname: git\n---\nBranch: {{git.branch}}`)
    const project = {
      id: 'p1',
      name: 'test',
      path: process.cwd(), // real git repo
      agentType: 'claude' as const,
      createdAt: new Date().toISOString(),
      config: {},
    }
    const result = await resolver.resolve('git', { project })
    expect(result).toMatch(/Branch: .+/)
  })

  it('resolves {{git.branch}} as empty in non-git dir', async () => {
    writeTemplate('git2', `---\nname: git2\n---\nBranch: "{{git.branch}}"`)
    const project = {
      id: 'p1',
      name: 'test',
      path: os.tmpdir(),
      agentType: 'claude' as const,
      createdAt: new Date().toISOString(),
      config: {},
    }
    const result = await resolver.resolve('git2', { project })
    expect(result).toBe('Branch: ""')
  })
})
