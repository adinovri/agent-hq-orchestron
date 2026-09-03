import path from 'node:path'
import os from 'node:os'
import fsPromises from 'node:fs/promises'
import matter from 'gray-matter'
import type { ProjectMetadata, TemplateFrontmatter } from '@agent-hq-orchestron/shared'
import { resolveGitContext } from './git-context.js'

export class TemplateNotFoundError extends Error {
  constructor(name: string) {
    super(`Template not found: ${name}`)
    this.name = 'TemplateNotFoundError'
  }
}

export class TemplateValidationError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing required template variables: ${missing.join(', ')}`)
    this.name = 'TemplateValidationError'
  }
}

export interface ResolveOptions {
  project?: ProjectMetadata
  vars?: Record<string, string | number | boolean>
}

export class TemplateResolver {
  private readonly templatesDir: string

  constructor(dataDir: string) {
    this.templatesDir = path.join(dataDir, 'templates')
  }

  async resolve(name: string, options: ResolveOptions = {}): Promise<string> {
    const filePath = path.join(this.templatesDir, `${name}.md`)

    let raw: string
    try {
      raw = await fsPromises.readFile(filePath, 'utf8')
    } catch {
      throw new TemplateNotFoundError(name)
    }

    const parsed = matter(raw)
    const frontmatter = parsed.data as TemplateFrontmatter
    const body = parsed.content

    // Validate required variables
    const varSpec = frontmatter.variables ?? {}
    const missing: string[] = []
    for (const [key, spec] of Object.entries(varSpec)) {
      if (spec.required && spec.default === undefined && !options.vars?.[key]) {
        missing.push(key)
      }
    }
    if (missing.length > 0) throw new TemplateValidationError(missing)

    // Build git context lazily
    const projectPath = options.project?.path ?? process.cwd()
    const gitCtx = await resolveGitContext(projectPath)

    const now = new Date()
    const user = os.userInfo().username

    const resolvers: Record<string, string | ((m: string) => string | Promise<string>)> = {
      'project.name': options.project?.name ?? '',
      'project.path': options.project?.path ?? '',
      'git.branch': gitCtx.branch,
      'git.status': gitCtx.status,
      'git.diff': gitCtx.diff,
      date: now.toLocaleDateString(),
      'date.iso': now.toISOString(),
      user,
    }

    // Interpolate all {{...}} placeholders (Mustache-style)
    let result = body
    const placeholders = [...body.matchAll(/\{\{([^}]+)\}\}/g)]

    for (const match of placeholders) {
      const key = match[1].trim()
      let value = ''

      if (key in resolvers) {
        const r = resolvers[key]
        value = typeof r === 'function' ? await r(key) : r
      } else if (key.startsWith('git.log-')) {
        const n = parseInt(key.slice('git.log-'.length), 10)
        value = isNaN(n) ? '' : await gitCtx.log(n)
      } else if (key.startsWith('env.')) {
        value = process.env[key.slice(4)] ?? ''
      } else if (key.startsWith('vars.')) {
        const varKey = key.slice(5)
        const v = options.vars?.[varKey] ?? varSpec[varKey]?.default
        value = v !== undefined ? String(v) : ''
      }
      // missing → empty string (no throw)

      result = result.replaceAll(`{{${match[1]}}}`, value)
    }

    return result.trim()
  }
}
