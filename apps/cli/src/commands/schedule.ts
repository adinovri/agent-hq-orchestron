import { readFile, writeFile } from 'node:fs/promises'
import type { Command } from 'commander'
import pc from 'picocolors'
import Table from 'cli-table3'
import { apiRaw, apiRequest, type CommonOpts } from '../helpers/api.js'
import { action, emit, withCommonOptions } from '../helpers/output.js'
import { assertEffort, effortHelp } from '../helpers/effort.js'
import { compact, resolveUseTmux } from '../helpers/mode.js'
import { readPromptOrStdin } from '../helpers/stdin.js'
import { collectRepeatable, parseVarAssignments } from '../helpers/files.js'

interface ScheduleEntry {
  id: string
  cron: string
  projectId: string
  enabled: boolean
  template?: string
  prompt?: string
  model?: string
  effort?: string
  useTmux?: boolean
  createdAt: string
  lastRunAt?: string
  nextRunAt?: string
}

interface ModeOpts extends CommonOpts {
  model?: string
  effort?: string
  headless?: boolean
  tmux?: boolean
}

function trigger(s: ScheduleEntry): string {
  if (s.template) return `template:${s.template}`
  return s.prompt ? s.prompt.replace(/\s+/g, ' ').slice(0, 30) : '—'
}

function mode(s: ScheduleEntry): string {
  if (s.useTmux === undefined) return 'project'
  return s.useTmux ? 'tmux' : 'headless'
}

function coercionNote(result: { coerced?: { reason?: string } }): string {
  return result.coerced ? pc.yellow(`  (coerced to tmux: ${result.coerced.reason ?? 'headless disabled'})`) : ''
}

/**
 * The three per-schedule overrides are three-valued on the wire: present pins
 * it, absent leaves the stored value alone, and an explicit clear form (`''`
 * for the strings, `null` for the boolean) drops the override so the schedule
 * follows its project again.
 *
 * `--clear-model` / `--clear-effort` / `--follow-project-mode` are how the CLI
 * spells that third state. Without them an edit could set an override but
 * never take one back off — the same gap the web dialog had before B6-F2.
 */
function overrideBody(opts: ModeOpts & { clearModel?: boolean; clearEffort?: boolean; followProjectMode?: boolean }): Record<string, unknown> {
  // The schedule routes take all six levels plus `''` for "clear"; checking
  // here means a typo costs no request.
  assertEffort(opts.effort, 'schedule', { allowClear: true })
  const body: Record<string, unknown> = {}
  if (opts.clearModel && opts.model) throw new Error('--model and --clear-model are mutually exclusive')
  if (opts.clearEffort && opts.effort) throw new Error('--effort and --clear-effort are mutually exclusive')
  if (opts.followProjectMode && (opts.headless || opts.tmux)) {
    throw new Error('--follow-project-mode cannot be combined with --headless or --tmux')
  }
  if (opts.clearModel) body['model'] = ''
  else if (opts.model !== undefined) body['model'] = opts.model
  if (opts.clearEffort) body['effort'] = ''
  else if (opts.effort !== undefined) body['effort'] = opts.effort
  if (opts.followProjectMode) body['useTmux'] = null
  else {
    const useTmux = resolveUseTmux(opts)
    if (useTmux !== undefined) body['useTmux'] = useTmux
  }
  return body
}

function withOverrideOptions(cmd: Command): Command {
  return cmd
    .option('--model <model>', 'Pin the model for spawns from this schedule')
    .option('--effort <level>', effortHelp('schedule'))
    .option('--headless', 'Spawn without tmux')
    .option('--tmux', 'Spawn in tmux')
}

export function registerSchedule(program: Command): void {
  const schedule = program.command('schedule').description('Manage scheduled agent tasks')

  withCommonOptions(schedule.command('list').description('List scheduled tasks')).action(
    action(async (opts: CommonOpts) => {
      const { schedules } = await apiRequest<{ schedules: ScheduleEntry[] }>(opts, '/api/schedules')
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, count: schedules.length, schedules }, null, 2) + '\n')
        return
      }
      if (schedules.length === 0) {
        process.stdout.write(pc.dim('No schedules found.\n'))
        return
      }
      const table = new Table({ head: ['ID', 'Cron', 'Project', 'Enabled', 'Model', 'Mode', 'Trigger'] })
      for (const s of schedules) {
        table.push([
          s.id.slice(0, 8),
          s.cron,
          s.projectId.slice(0, 8),
          s.enabled ? pc.green('yes') : pc.red('no'),
          s.model ?? '—',
          mode(s),
          trigger(s),
        ])
      }
      process.stdout.write(table.toString() + '\n')
    }),
  )

  withCommonOptions(schedule.command('get <id>').description('Show one schedule')).action(
    action(async (id: string, opts: CommonOpts) => {
      const entry = await apiRequest<ScheduleEntry>(opts, `/api/schedules/${id}`)
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, schedule: entry }, null, 2) + '\n')
        return
      }
      const t = new Table()
      t.push(
        { ID: entry.id },
        { Cron: entry.cron },
        { Project: entry.projectId },
        { Enabled: entry.enabled ? 'yes' : 'no' },
        { Model: entry.model ?? '— (project default)' },
        { Effort: entry.effort ?? '— (project default)' },
        { Mode: mode(entry) },
        { Trigger: trigger(entry) },
        { 'Next run': entry.nextRunAt ?? '—' },
      )
      process.stdout.write(t.toString() + '\n')
    }),
  )

  withOverrideOptions(
    withCommonOptions(
      schedule
        .command('create')
        .description('Create a scheduled task')
        .requiredOption('--cron <expr>', 'Five-field cron expression')
        .requiredOption('--project <projectId>', 'Project to spawn into')
        .option('--prompt <prompt>', 'Prompt to spawn with (else read from stdin)')
        .option('--template <templateId>', 'Template to render instead of a prompt')
        .option('--var <name=value>', 'Template variable (repeatable)', collectRepeatable, [])
        .option('--disabled', 'Create it paused'),
    ),
  ).action(
    action(
      async (
        opts: ModeOpts & {
          cron: string
          project: string
          prompt?: string
          template?: string
          var: string[]
          disabled?: boolean
        },
      ) => {
        const prompt = opts.template ? opts.prompt : await readPromptOrStdin(opts.prompt)
        if (!opts.template && !prompt) {
          throw new Error('schedule create needs --prompt, a piped prompt on stdin, or --template')
        }
        const body = {
          ...compact({
            cron: opts.cron,
            projectId: opts.project,
            prompt,
            template: opts.template,
            vars: opts.var.length > 0 ? parseVarAssignments(opts.var) : undefined,
            enabled: opts.disabled ? false : undefined,
          }),
          ...overrideBody(opts),
        }
        const entry = await apiRequest<ScheduleEntry & { coerced?: { reason?: string } }>(opts, '/api/schedules', {
          method: 'POST',
          body,
        })
        emit(
          opts,
          { id: entry.id, cron: entry.cron, projectId: entry.projectId, enabled: entry.enabled, model: entry.model ?? null, useTmux: entry.useTmux ?? null, coerced: entry.coerced ?? null },
          pc.green('Schedule created: ') + entry.id + pc.dim(` (${entry.cron})`) + coercionNote(entry),
        )
      },
    ),
  )

  withOverrideOptions(
    withCommonOptions(
      schedule
        .command('edit <id>')
        .description('Edit a scheduled task')
        .option('--cron <expr>', 'New cron expression')
        .option('--project <projectId>', 'Move it to another project')
        .option('--prompt <prompt>', 'New prompt')
        .option('--template <templateId>', 'New template')
        .option('--var <name=value>', 'Replace template variables (repeatable)', collectRepeatable, [])
        .option('--clear-model', 'Drop the model override — follow the project again')
        .option('--clear-effort', 'Drop the effort override — follow the project again')
        .option('--follow-project-mode', 'Drop the run-mode override — follow the project again'),
    ),
  ).action(
    action(
      async (
        id: string,
        opts: ModeOpts & {
          cron?: string
          project?: string
          prompt?: string
          template?: string
          var: string[]
          clearModel?: boolean
          clearEffort?: boolean
          followProjectMode?: boolean
        },
      ) => {
        const body = {
          ...compact({
            cron: opts.cron,
            projectId: opts.project,
            prompt: opts.prompt,
            template: opts.template,
            vars: opts.var.length > 0 ? parseVarAssignments(opts.var) : undefined,
          }),
          ...overrideBody(opts),
        }
        if (Object.keys(body).length === 0) {
          throw new Error('nothing to change — pass at least one field to edit')
        }
        const entry = await apiRequest<ScheduleEntry & { coerced?: { reason?: string } }>(opts, `/api/schedules/${id}`, {
          method: 'PATCH',
          body,
        })
        emit(
          opts,
          { id: entry.id, changed: Object.keys(body), cron: entry.cron, model: entry.model ?? null, effort: entry.effort ?? null, useTmux: entry.useTmux ?? null, coerced: entry.coerced ?? null },
          pc.green('Schedule updated: ') + entry.id + pc.dim(` (${Object.keys(body).join(', ')})`) + coercionNote(entry),
        )
      },
    ),
  )

  withCommonOptions(schedule.command('delete <id>').alias('rm').description('Delete a scheduled task')).action(
    action(async (id: string, opts: CommonOpts) => {
      await apiRequest<void>(opts, `/api/schedules/${id}`, { method: 'DELETE' })
      emit(opts, { id, deleted: true }, pc.red('Schedule deleted: ') + id)
    }),
  )

  // Pause / resume are the `enabled` flag under names that say what they do.
  // The scheduler keeps a disabled entry's cron and history — pausing is not
  // deleting, and the distinction is the whole reason both verbs exist.
  for (const [verb, enabled, label] of [
    ['pause', false, 'paused'],
    ['resume', true, 'resumed'],
  ] as const) {
    withCommonOptions(
      schedule.command(`${verb} <id>`).description(`${verb === 'pause' ? 'Stop' : 'Restart'} firing without deleting the entry`),
    ).action(
      action(async (id: string, opts: CommonOpts) => {
        const entry = await apiRequest<ScheduleEntry>(opts, `/api/schedules/${id}`, {
          method: 'PATCH',
          body: { enabled },
        })
        emit(
          opts,
          { id: entry.id, enabled: entry.enabled },
          (enabled ? pc.green : pc.yellow)(`Schedule ${label}: `) + entry.id,
        )
      }),
    )
  }

  withCommonOptions(schedule.command('run <id>').description('Fire a scheduled task immediately')).action(
    action(async (id: string, opts: CommonOpts) => {
      const result = await apiRequest<{ ok: boolean; sessionUuid?: string }>(opts, `/api/schedules/${id}/run`, {
        method: 'POST',
      })
      emit(
        opts,
        { id, sessionUuid: result?.sessionUuid ?? null },
        pc.green(`Schedule ${id} triggered.`) + (result?.sessionUuid ? pc.dim(` session ${result.sessionUuid}`) : ''),
      )
    }),
  )

  withCommonOptions(
    schedule
      .command('export')
      .description('Export all schedules as YAML')
      .option('--out <file>', 'Write to a file instead of stdout'),
  ).action(
    action(async (opts: CommonOpts & { out?: string }) => {
      const res = await apiRaw(opts, '/api/schedules/export')
      const yaml = await res.text()
      if (!opts.out) {
        // No --out: the document IS the output, and --json would corrupt it
        // by wrapping YAML in a JSON string. Say so rather than emit
        // something a pipe cannot use.
        if (opts.json) throw new Error('schedule export --json needs --out — YAML cannot be nested in the envelope')
        process.stdout.write(yaml.endsWith('\n') ? yaml : yaml + '\n')
        return
      }
      await writeFile(opts.out, yaml, 'utf8')
      const count = (yaml.match(/^\s*- id:/gm) ?? []).length
      emit(opts, { path: opts.out, bytes: Buffer.byteLength(yaml), count }, pc.green('Schedules exported: ') + opts.out)
    }),
  )

  withCommonOptions(
    schedule
      .command('import <file>')
      .description('Import schedules from a YAML document')
      .option('--mode <merge|replace>', 'merge (default) adds/updates; replace deletes everything first', 'merge'),
  ).action(
    action(async (file: string, opts: CommonOpts & { mode: string }) => {
      if (opts.mode !== 'merge' && opts.mode !== 'replace') {
        throw new Error(`--mode expects merge or replace, got ${JSON.stringify(opts.mode)}`)
      }
      const yaml = await readFile(file, 'utf8')
      const result = await apiRequest<{
        mode: string
        total: number
        created: number
        updated: number
        skipped: number
        coerced: number
        errors: Array<{ id?: string; error: string }>
      }>(opts, `/api/schedules/import?mode=${opts.mode}`, {
        method: 'POST',
        rawBody: yaml,
        headers: { 'Content-Type': 'application/x-yaml' },
      })
      emit(
        opts,
        { ...result, file },
        pc.green('Schedules imported: ') +
          `${result.created} created, ${result.updated} updated, ${result.skipped} skipped` +
          (result.coerced > 0 ? pc.yellow(` (${result.coerced} coerced to tmux)`) : '') +
          (result.errors.length > 0 ? pc.red(`\n${result.errors.length} error(s): ${result.errors.map((e) => `${e.id ?? '?'}: ${e.error}`).join('; ')}`) : ''),
      )
    }),
  )

  schedule
    .command('daemon')
    .description('Where the scheduler actually runs')
    .action(() => {
      process.stdout.write(
        pc.yellow('The scheduler daemon runs inside the API server (orchestron serve).\n') +
          pc.dim('Inspect it with `orchestron schedule list`.\n'),
      )
    })
}
