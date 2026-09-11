import type { Command } from 'commander'
import pc from 'picocolors'
import Table from 'cli-table3'
import type { ProjectMetadata } from '@agent-hq-orchestron/shared'
import { apiRequest, type CommonOpts } from '../helpers/api.js'
import { action, emit, withCommonOptions } from '../helpers/output.js'
import { compact, parseBoolFlag } from '../helpers/mode.js'

export function registerProject(program: Command): void {
  const project = program.command('project').description('Manage projects')

  withCommonOptions(
    project
      .command('list')
      .description('List all projects')
      .option('--group <group>', 'Filter by group')
      .option('--tag <tag>', 'Filter by tag'),
  ).action(
    action(async (opts: CommonOpts & { group?: string; tag?: string }) => {
      const params = new URLSearchParams()
      if (opts.group) params.set('group', opts.group)
      if (opts.tag) params.set('tag', opts.tag)
      const qs = params.toString()
      // `{ projects: [...] }`, not a bare array — same shape mistake, same
      // "not iterable" crash, as `session list` carried.
      const { projects } = await apiRequest<{ projects: ProjectMetadata[] }>(
        opts,
        `/api/projects${qs ? `?${qs}` : ''}`,
      )
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, count: projects.length, projects }, null, 2) + '\n')
        return
      }
      if (projects.length === 0) {
        process.stdout.write(pc.dim('No projects.\n'))
        return
      }
      const t = new Table({ head: ['ID', 'Name', 'Path', 'Agent', 'Group', 'Default model', 'Mode'] })
      for (const p of projects) {
        t.push([
          pc.gray(p.id.slice(0, 8)),
          pc.bold(p.name),
          p.path,
          pc.cyan(p.agentType),
          p.group ?? '—',
          p.defaultModel ?? '—',
          p.defaultUseTmux === undefined ? 'tmux' : p.defaultUseTmux ? 'tmux' : 'headless',
        ])
      }
      process.stdout.write(t.toString() + '\n')
    }),
  )

  withCommonOptions(project.command('get <id>').description('Show one project')).action(
    action(async (id: string, opts: CommonOpts) => {
      const p = await apiRequest<ProjectMetadata>(opts, `/api/projects/${id}`)
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, project: p }, null, 2) + '\n')
        return
      }
      const t = new Table()
      t.push(
        { ID: p.id },
        { Name: p.name },
        { Path: p.path },
        { Agent: p.agentType },
        { Group: p.group ?? '—' },
        { 'Default model': p.defaultModel ?? '—' },
        { 'Default effort': p.defaultEffort ?? '—' },
        { 'Default mode': p.defaultUseTmux === false ? 'headless' : 'tmux' },
      )
      process.stdout.write(t.toString() + '\n')
    }),
  )

  withCommonOptions(
    project
      .command('add')
      .description('Register a new project')
      .requiredOption('--name <name>', 'Project name')
      .requiredOption('--path <path>', 'Project path')
      .option('--agent <agent>', 'Agent type', 'claude')
      .option('--group <group>', 'Group')
      .option('--default-model <model>', 'Model every spawn inherits')
      .option('--default-effort <level>', 'Effort every spawn inherits')
      .option('--default-headless', 'Spawn headless by default')
      .option('--default-tmux', 'Spawn in tmux by default'),
  ).action(
    action(
      async (
        opts: CommonOpts & {
          name: string
          path: string
          agent: string
          group?: string
          defaultModel?: string
          defaultEffort?: string
          defaultHeadless?: boolean
          defaultTmux?: boolean
        },
      ) => {
        if (opts.defaultHeadless && opts.defaultTmux) {
          throw new Error('--default-headless and --default-tmux are mutually exclusive')
        }
        const result = await apiRequest<ProjectMetadata>(opts, '/api/projects', {
          method: 'POST',
          body: compact({
            name: opts.name,
            path: opts.path,
            agentType: opts.agent,
            group: opts.group ?? null,
            defaultModel: opts.defaultModel,
            defaultEffort: opts.defaultEffort,
            defaultUseTmux: opts.defaultHeadless ? false : opts.defaultTmux ? true : undefined,
          }),
        })
        emit(
          opts,
          { id: result.id, name: result.name, path: result.path, agentType: result.agentType },
          pc.green('Project registered: ') + result.id,
        )
      },
    ),
  )

  withCommonOptions(
    project
      .command('edit <id>')
      .description('Edit a project')
      .option('--name <name>', 'New name')
      .option('--path <path>', 'New path')
      .option('--group <group>', 'New group (empty string clears it)')
      .option('--default-model <model>', 'New default model')
      .option('--clear-default-model', 'Un-pin the default model')
      .option('--default-effort <level>', 'New default effort')
      .option('--clear-default-effort', 'Un-pin the default effort')
      .option('--default-use-tmux <bool>', 'true spawns in tmux, false spawns headless'),
  ).action(
    action(
      async (
        id: string,
        opts: CommonOpts & {
          name?: string
          path?: string
          group?: string
          defaultModel?: string
          clearDefaultModel?: boolean
          defaultEffort?: string
          clearDefaultEffort?: boolean
          defaultUseTmux?: string
        },
      ) => {
        if (opts.clearDefaultModel && opts.defaultModel) {
          throw new Error('--default-model and --clear-default-model are mutually exclusive')
        }
        if (opts.clearDefaultEffort && opts.defaultEffort) {
          throw new Error('--default-effort and --clear-default-effort are mutually exclusive')
        }
        // `null` is the clear, `''` is a typo — B6-F2. An omitted key merges,
        // so the CLI has to say "unset" out loud for the caller to ever get a
        // pinned model back off a project.
        const body: Record<string, unknown> = compact({
          name: opts.name,
          path: opts.path,
          defaultModel: opts.defaultModel,
          defaultEffort: opts.defaultEffort,
          defaultUseTmux: parseBoolFlag(opts.defaultUseTmux, '--default-use-tmux'),
        })
        if (opts.clearDefaultModel) body['defaultModel'] = null
        if (opts.clearDefaultEffort) body['defaultEffort'] = null
        // `group` is nullable on the schema but not in UNSETTABLE_PROJECT_FIELDS;
        // an empty `--group ""` is the documented way to clear it.
        if (opts.group !== undefined) body['group'] = opts.group === '' ? null : opts.group
        if (Object.keys(body).length === 0) {
          throw new Error('nothing to change — pass at least one field to edit')
        }
        const result = await apiRequest<ProjectMetadata>(opts, `/api/projects/${id}`, { method: 'PATCH', body })
        emit(
          opts,
          { id: result.id, changed: Object.keys(body) },
          pc.green('Project updated: ') + result.id + pc.dim(` (${Object.keys(body).join(', ')})`),
        )
      },
    ),
  )

  withCommonOptions(project.command('rm <id>').alias('remove').description('Remove a project')).action(
    action(async (id: string, opts: CommonOpts) => {
      await apiRequest<void>(opts, `/api/projects/${id}`, { method: 'DELETE' })
      emit(opts, { id, removed: true }, pc.green('Removed: ') + id)
    }),
  )
}
