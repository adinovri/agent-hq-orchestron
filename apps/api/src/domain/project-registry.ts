import crypto from 'node:crypto'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import { writeJson, readJson, listDir } from '@agent-hq-orchestron/file-store'
import { UNSETTABLE_PROJECT_FIELDS, type ProjectMetadata } from '@agent-hq-orchestron/shared'

/**
 * Patch accepted by `ProjectRegistry.update`.
 *
 * Mirrors `PatchProjectBodySchema`: any field of the record, plus `null`
 * on the three clearable ones. `null` means "delete this key", which is
 * distinct from omitting it (keep the stored value).
 */
export type UpdateProjectPatch = Partial<
  Omit<ProjectMetadata, 'id' | 'createdAt' | 'defaultModel' | 'defaultEffort' | 'agentConfig'>
> & {
  defaultModel?: ProjectMetadata['defaultModel'] | null
  defaultEffort?: ProjectMetadata['defaultEffort'] | null
  agentConfig?: ProjectMetadata['agentConfig'] | null
}

export interface CreateProjectInput {
  name: string
  path: string
  agentType?: ProjectMetadata['agentType']
  defaultModel?: ProjectMetadata['defaultModel']
  defaultEffort?: ProjectMetadata['defaultEffort']
  defaultUseTmux?: ProjectMetadata['defaultUseTmux']
  group?: string | null
  tags?: string[]
  agentConfig?: ProjectMetadata['agentConfig']
  config?: Record<string, unknown>
}

export interface ProjectFilter {
  group?: string
  tags?: string[]
}

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`Project not found: ${id}`)
    this.name = 'ProjectNotFoundError'
  }
}

export class ProjectPathError extends Error {
  constructor(projectPath: string, reason: string) {
    super(`Project path "${projectPath}" ${reason}`)
    this.name = 'ProjectPathError'
  }
}

export class ProjectRegistry {
  private readonly projectsDir: string

  constructor(dataDir: string) {
    this.projectsDir = path.join(dataDir, 'projects')
  }

  private projectPath(id: string): string {
    return path.join(this.projectsDir, `${id}.json`)
  }

  async create(input: CreateProjectInput): Promise<ProjectMetadata> {
    // Validate path exists and is writable
    try {
      await fsPromises.access(input.path, fsPromises.constants.F_OK | fsPromises.constants.W_OK)
    } catch {
      throw new ProjectPathError(input.path, 'does not exist or is not writable')
    }

    const id = crypto.randomUUID()
    const now = new Date().toISOString()

    const project: ProjectMetadata = {
      id,
      name: input.name,
      path: input.path,
      agentType: input.agentType ?? 'claude',
      defaultModel: input.defaultModel,
      defaultEffort: input.defaultEffort,
      // Left undefined when unset rather than defaulted to true — an absent
      // field already means tmux via resolveUseTmux, and storing an explicit
      // default here would make a later change of the global default invisible
      // to projects created before it.
      defaultUseTmux: input.defaultUseTmux,
      group: input.group ?? null,
      tags: input.tags ?? [],
      agentConfig: input.agentConfig,
      createdAt: now,
      config: input.config ?? {},
    }

    await writeJson(this.projectPath(id), project)
    return project
  }

  async get(id: string): Promise<ProjectMetadata> {
    const record = await readJson<ProjectMetadata | null>(this.projectPath(id), null)
    if (!record) throw new ProjectNotFoundError(id)
    return record
  }

  async list(): Promise<ProjectMetadata[]> {
    const files = await listDir(this.projectsDir)
    const projects: ProjectMetadata[] = []

    await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => {
          const id = f.replace(/\.json$/, '')
          const record = await readJson<ProjectMetadata | null>(this.projectPath(id), null)
          if (record) projects.push(record)
        }),
    )

    return projects
  }

  /**
   * Shallow-merge a patch over the stored record.
   *
   * An **absent** key keeps the stored value — that is what makes this a
   * partial update, and every existing API client depends on it.
   *
   * An explicit `null` on one of `UNSETTABLE_PROJECT_FIELDS` **deletes**
   * the key instead. Without this there was no way to clear a default
   * from the UI at all: the dialog omitted the field when the user chose
   * "harness default", the merge kept the old value, and a project
   * pinned to an expensive model stayed pinned forever (B6-F2).
   *
   * `group` is deliberately not in that set — it is `string | null` in
   * `ProjectMetadata`, so `null` there is a value, not an erasure.
   */
  async update(id: string, patch: UpdateProjectPatch): Promise<ProjectMetadata> {
    const existing = await this.get(id)
    const merged: Record<string, unknown> = { ...existing, ...patch }

    for (const key of UNSETTABLE_PROJECT_FIELDS) {
      if (key in patch && patch[key] === null) delete merged[key]
    }

    const updated = { ...merged, id: existing.id, createdAt: existing.createdAt } as ProjectMetadata
    await writeJson(this.projectPath(id), updated)
    return updated
  }

  async delete(id: string): Promise<void> {
    const filePath = this.projectPath(id)
    const bakPath = `${filePath}.bak`

    // Verify exists first
    const record = await readJson<ProjectMetadata | null>(filePath, null)
    if (!record) throw new ProjectNotFoundError(id)

    await fsPromises.unlink(filePath).catch(() => {})
    await fsPromises.unlink(bakPath).catch(() => {})
  }

  async filter(criteria: ProjectFilter): Promise<ProjectMetadata[]> {
    const all = await this.list()
    return all.filter((p) => {
      if (criteria.group !== undefined && p.group !== criteria.group) return false
      if (criteria.tags && criteria.tags.length > 0) {
        if (!criteria.tags.every((t) => (p.tags ?? []).includes(t))) return false
      }
      return true
    })
  }
}
