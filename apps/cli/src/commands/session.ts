import type { Command } from 'commander'
import { basename } from 'node:path'
import pc from 'picocolors'
import Table from 'cli-table3'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'
import { apiRaw, apiRequest, type CommonOpts } from '../helpers/api.js'
import { action, emit, withCommonOptions } from '../helpers/output.js'
import { compact, parseBoolFlag, resolveUseTmux } from '../helpers/mode.js'
import { readPromptOrStdin, requirePrompt } from '../helpers/stdin.js'
import { planAnswer } from '../helpers/answer.js'
import { collectRepeatable, parseVarAssignments, readAttachments, writeExport } from '../helpers/files.js'
import { assertEffort, effortHelp, type EffortEndpoint } from '../helpers/effort.js'

const STATUS_COLOR: Record<string, (s: string) => string> = {
  running: pc.green,
  idle: pc.cyan,
  needs_input: pc.yellow,
  sleeping: pc.gray,
  succeeded: pc.blue,
  failed: pc.red,
  killed: pc.gray,
  spawning: pc.yellow,
  waiting: pc.yellow,
}

function colorStatus(s: string): string {
  return (STATUS_COLOR[s] ?? ((x: string) => x))(s)
}

/** The fields every mutation echoes back, in one shape, so a caller scripting
 *  against `--json` gets the same keys from reopen, fork, respawn and adopt
 *  without branching on the verb. */
function sessionEnvelope(s: SessionMetadata): Record<string, unknown> {
  return {
    id: s.id,
    sessionUuid: s.claudeSessionUuid,
    projectId: s.projectId,
    status: s.status,
    model: s.model ?? null,
    effort: s.effort ?? null,
    useTmux: s.useTmux ?? true,
    tmuxName: s.tmuxName,
  }
}

/** `coerced` rides along on any response the headless kill-switch rewrote.
 *  Silently dropping it would let a caller believe it got the headless session
 *  it asked for. */
function coercionNote(result: { coerced?: { reason?: string } }): string {
  return result.coerced ? pc.yellow(`  (coerced to tmux: ${result.coerced.reason ?? 'headless disabled'})`) : ''
}

/** Flags shared by spawn and the three revival verbs.
 *
 *  `endpoint` picks the effort enum: spawn takes all six levels, the revival
 *  routes reject `ultra`. Same list drives the help text and the local check,
 *  so `--help` cannot advertise a level the route will 400. */
function withModeOptions(cmd: Command, endpoint: EffortEndpoint): Command {
  return cmd
    .option('--model <model>', 'Pin the harness model for this session')
    .option('--effort <level>', effortHelp(endpoint))
    .option('--headless', 'Run without tmux (one-shot `-p` turns)')
    .option('--tmux', 'Run in tmux (explicit override of the project default)')
}

interface ModeOpts extends CommonOpts {
  model?: string
  effort?: string
  headless?: boolean
  tmux?: boolean
}

/** Body for reopen / fork / respawn — all three take the same three keys, and
 *  all three treat an absent `useTmux` as "keep the session's own mode". */
function revivalBody(opts: ModeOpts): Record<string, unknown> {
  return compact({ model: opts.model, effort: opts.effort, useTmux: resolveUseTmux(opts) })
}

export function registerSession(program: Command): void {
  const session = program.command('session').description('Manage sessions')

  // ── read ────────────────────────────────────────────────────────────────

  withCommonOptions(
    session
      .command('list')
      .description('List sessions')
      .option('--project <projectId>', 'Filter by project ID')
      .option('--status <status>', 'Filter by status')
      .option('--tag <tags>', 'Filter by project tag (comma-separated)')
      .option('--from <date>', 'Only sessions started on or after this date')
      .option('--to <date>', 'Only sessions started on or before this date'),
  ).action(
    action(async (opts: CommonOpts & { project?: string; status?: string; tag?: string; from?: string; to?: string }) => {
      // Every filter is applied server-side — the route already supports all
      // five, and filtering here would page the whole list over the wire to
      // throw most of it away.
      const params = new URLSearchParams()
      if (opts.project) params.set('projectId', opts.project)
      if (opts.status) params.set('status', opts.status)
      if (opts.tag) params.set('tag', opts.tag)
      if (opts.from) params.set('from', opts.from)
      if (opts.to) params.set('to', opts.to)
      const qs = params.toString()
      // `GET /api/sessions` answers `{ sessions: [...] }`, not a bare array.
      // The previous version destructured it as an array and every real
      // invocation died on "sessions is not iterable" — which no test caught,
      // because none of them ran against a response shaped like the API's.
      const { sessions } = await apiRequest<{ sessions: SessionMetadata[] }>(
        opts,
        `/api/sessions${qs ? `?${qs}` : ''}`,
      )
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, count: sessions.length, sessions }, null, 2) + '\n')
        return
      }
      if (sessions.length === 0) {
        process.stdout.write(pc.dim('No sessions.\n'))
        return
      }
      const t = new Table({ head: ['ID', 'Name', 'Status', 'Mode', 'Model', 'Cost', 'Started'] })
      for (const s of sessions) {
        t.push([
          pc.gray(s.id.slice(0, 8)),
          s.tmuxName.slice(0, 20),
          colorStatus(s.status),
          (s.useTmux ?? true) ? 'tmux' : 'headless',
          s.model ?? '—',
          s.costUsd != null ? `$${s.costUsd.toFixed(4)}` : '—',
          s.startedAt.slice(0, 16),
        ])
      }
      process.stdout.write(t.toString() + '\n')
    }),
  )

  withCommonOptions(session.command('get <id>').description('Show one session record')).action(
    action(async (id: string, opts: CommonOpts) => {
      const s = await apiRequest<SessionMetadata>(opts, `/api/sessions/${id}`)
      if (opts.json) {
        process.stdout.write(JSON.stringify({ ok: true, session: s }, null, 2) + '\n')
        return
      }
      const t = new Table()
      t.push(
        { ID: s.id },
        { Project: s.projectId },
        { Status: colorStatus(s.status) },
        { Mode: (s.useTmux ?? true) ? 'tmux' : 'headless' },
        { Model: s.model ?? '—' },
        { Effort: s.effort ?? '—' },
        { Harness: s.claudeSessionUuid },
        { Cost: s.costUsd != null ? `$${s.costUsd.toFixed(4)}` : '—' },
        { Pending: s.pendingPrompt ? 'selector' : s.pendingInquiry ? 'inquiry' : '—' },
      )
      process.stdout.write(t.toString() + '\n')
    }),
  )

  // ── spawn ───────────────────────────────────────────────────────────────

  withModeOptions(
    withCommonOptions(
      session
        .command('spawn')
        .description('Spawn a new session')
        .requiredOption('--project <projectId>', 'Project ID')
        .option('--prompt <prompt>', 'Initial prompt (else read from stdin)')
        .option('--template <templateId>', 'Prompt template to render instead of --prompt')
        .option('--var <name=value>', 'Template variable (repeatable)', collectRepeatable, [])
        .option('--attachment <file>', 'File to attach to the first turn (repeatable)', collectRepeatable, [])
        .option('--agent <agent>', 'Agent type override')
        .option('--parent <sessionId>', 'Record this spawn as a child of another session')
        .option('--detached', 'Spawn detached (no parent tracking)'),
    ),
    'spawn',
  ).action(
    action(
      async (
        opts: ModeOpts & {
          project: string
          prompt?: string
          template?: string
          var: string[]
          attachment: string[]
          agent?: string
          parent?: string
          detached?: boolean
        },
      ) => {
        assertEffort(opts.effort, 'spawn')
        // A template renders its own prompt server-side, so stdin is only
        // consulted when neither was named — otherwise piping into a
        // templated spawn would silently add a second, conflicting body.
        const prompt = opts.template ? opts.prompt : await readPromptOrStdin(opts.prompt)
        if (!opts.template && !prompt) {
          throw new Error('spawn needs --prompt, a piped prompt on stdin, or --template')
        }

        const body = compact({
          projectId: opts.project,
          prompt,
          template: opts.template,
          vars: opts.var.length > 0 ? parseVarAssignments(opts.var) : undefined,
          agentType: opts.agent,
          parentSessionId: opts.parent,
          detached: opts.detached,
          model: opts.model,
          effort: opts.effort,
          useTmux: resolveUseTmux(opts),
        })

        let result: SessionMetadata & { coerced?: { reason?: string } }
        if (opts.attachment.length > 0) {
          // Multipart carries the whole payload in a `body` field so the
          // server parses one JSON document rather than re-deriving types
          // from stringified form fields (which is how `useTmux` used to
          // arrive as the string "false").
          const form = new FormData()
          form.append('body', JSON.stringify(body))
          for (const { name, blob } of await readAttachments(opts.attachment)) {
            form.append('file', blob, name)
          }
          result = await apiRequest(opts, '/api/sessions', { method: 'POST', rawBody: form })
        } else {
          result = await apiRequest(opts, '/api/sessions', { method: 'POST', body })
        }

        emit(
          opts,
          { ...sessionEnvelope(result), coerced: result.coerced ?? null, attachments: opts.attachment.length },
          pc.green('Session spawned: ') + result.id + coercionNote(result),
        )
      },
    ),
  )

  // ── revival ─────────────────────────────────────────────────────────────

  for (const [verb, path, label] of [
    ['reopen', 'reopen', 'Reopened'],
    ['respawn', 'respawn', 'Respawned'],
  ] as const) {
    withModeOptions(
      withCommonOptions(
        session
          .command(`${verb} <id>`)
          .description(
            verb === 'reopen'
              ? 'Wake a terminal session back into its own harness conversation'
              : 'Start the session over from its initial prompt (fresh harness conversation)',
          ),
      ),
      'revival',
    ).action(
      action(async (id: string, opts: ModeOpts) => {
        assertEffort(opts.effort, 'revival')
        const result = await apiRequest<SessionMetadata & { coerced?: { reason?: string } }>(
          opts,
          `/api/sessions/${id}/${path}`,
          { method: 'POST', body: revivalBody(opts) },
        )
        emit(
          opts,
          { ...sessionEnvelope(result), coerced: result.coerced ?? null },
          pc.green(`${label}: `) + result.id + ` (${colorStatus(result.status)})` + coercionNote(result),
        )
      }),
    )
  }

  // `fork` in the UI, `clone` on the wire. The CLI takes the UI's word — it
  // is what the docs and the dialog say — and keeps `clone` as a hidden alias
  // so anything written against the endpoint name still runs.
  withModeOptions(
    withCommonOptions(
      session
        .command('fork <id>')
        .alias('clone')
        .description('Branch a new session off this one, sharing its harness conversation')
        .option('--prompt <prompt>', 'Seed the fork with a new user turn (else read from stdin)'),
    ),
    'revival',
  ).action(
    action(async (id: string, opts: ModeOpts & { prompt?: string }) => {
      assertEffort(opts.effort, 'revival')
      const prompt = await readPromptOrStdin(opts.prompt)
      const result = await apiRequest<SessionMetadata & { coerced?: { reason?: string } }>(
        opts,
        `/api/sessions/${id}/clone`,
        { method: 'POST', body: { ...revivalBody(opts), ...compact({ prompt }) } },
      )
      emit(
        opts,
        { ...sessionEnvelope(result), forkedFrom: id, coerced: result.coerced ?? null },
        pc.green('Forked: ') + result.id + pc.dim(` (from ${id.slice(0, 8)})`) + coercionNote(result),
      )
    }),
  )

  // ── lifecycle ───────────────────────────────────────────────────────────

  // Archive IS the "mark done" action — the API transitions the record
  // through completing to `succeeded`, which is the terminal state the web
  // UI's "Mark success" button produces. There is no second endpoint; the
  // alias exists so both names a caller might reach for resolve here rather
  // than one of them silently not existing.
  withCommonOptions(
    session
      .command('archive <id>')
      .alias('mark-success')
      .description('Soft-close a session: kill its tmux and mark it succeeded'),
  ).action(
    action(async (id: string, opts: CommonOpts) => {
      const result = await apiRequest<SessionMetadata>(opts, `/api/sessions/${id}/archive`, { method: 'POST' })
      emit(opts, sessionEnvelope(result), pc.blue('Archived: ') + result.id + ` (${colorStatus(result.status)})`)
    }),
  )

  withCommonOptions(session.command('kill <id>').description('Kill a session and its descendants')).action(
    action(async (id: string, opts: CommonOpts) => {
      const result = await apiRequest<SessionMetadata>(opts, `/api/sessions/${id}`, { method: 'DELETE' })
      emit(
        opts,
        result ? sessionEnvelope(result) : { id },
        pc.red('Session killed: ') + id,
      )
    }),
  )

  withCommonOptions(
    session
      .command('rm <id>')
      .alias('delete-record')
      .description('Permanently delete the orchestron record (terminal/sleeping only; transcript stays on disk)'),
  ).action(
    action(async (id: string, opts: CommonOpts) => {
      const result = await apiRequest<Record<string, unknown>>(opts, `/api/sessions/${id}/record`, { method: 'DELETE' })
      emit(opts, { id, ...(result ?? {}) }, pc.red('Record deleted: ') + id)
    }),
  )

  withCommonOptions(
    session.command('interrupt <id>').description('Abort the in-flight turn; the session stays alive'),
  ).action(
    action(async (id: string, opts: CommonOpts) => {
      const result = await apiRequest<SessionMetadata>(opts, `/api/sessions/${id}/interrupt`, { method: 'POST' })
      emit(opts, sessionEnvelope(result), pc.yellow('Interrupted: ') + result.id + ` (${colorStatus(result.status)})`)
    }),
  )

  // ── metadata ────────────────────────────────────────────────────────────

  withCommonOptions(
    session
      .command('metadata <id>')
      .description('Edit model / effort / run mode on a resting session')
      .option('--model <model>', 'New model')
      .option('--effort <level>', effortHelp('metadata', { allowClear: true }))
      .option('--use-tmux <bool>', 'true to run in tmux, false for headless'),
  ).action(
    action(async (id: string, opts: CommonOpts & { model?: string; effort?: string; useTmux?: string }) => {
      assertEffort(opts.effort, 'metadata', { allowClear: true })
      const useTmux = parseBoolFlag(opts.useTmux, '--use-tmux')
      const body = compact({ model: opts.model, effort: opts.effort, useTmux })
      if (Object.keys(body).length === 0) {
        throw new Error('nothing to change — pass at least one of --model, --effort, --use-tmux')
      }
      const result = await apiRequest<SessionMetadata & { coerced?: { reason?: string } }>(
        opts,
        `/api/sessions/${id}`,
        { method: 'PATCH', body },
      )
      emit(
        opts,
        { ...sessionEnvelope(result), changed: Object.keys(body), coerced: result.coerced ?? null },
        pc.green('Metadata updated: ') +
          result.id +
          pc.dim(` model=${result.model ?? '—'} effort=${result.effort ?? '—'} mode=${(result.useTmux ?? true) ? 'tmux' : 'headless'}`) +
          coercionNote(result),
      )
    }),
  )

  // ── turns ───────────────────────────────────────────────────────────────

  withCommonOptions(
    session
      .command('send <id>')
      .description('Send a user turn to a session (wakes it if sleeping)')
      .option('--prompt <prompt>', 'Prompt text (else read from stdin)'),
  ).action(
    action(async (id: string, opts: CommonOpts & { prompt?: string }) => {
      const prompt = requirePrompt(await readPromptOrStdin(opts.prompt), 'session send')
      const result = await apiRequest<SessionMetadata>(opts, `/api/sessions/${id}/input`, {
        method: 'POST',
        body: { prompt },
      })
      emit(
        opts,
        { ...sessionEnvelope(result), promptChars: prompt.length },
        pc.green('Sent: ') + result.id + ` (${colorStatus(result.status)})`,
      )
    }),
  )

  withCommonOptions(
    session
      .command('answer <id>')
      .description('Answer whatever the session is waiting on — selector modal or structured inquiry')
      .option('--choice <selector-or-text>', 'Option number, or text matching an option')
      .option('--text <answer>', 'Free-text answer (skips option matching)')
      .option('--field <name=value>', 'Answer one inquiry field (repeatable)', collectRepeatable, []),
  ).action(
    action(async (id: string, opts: CommonOpts & { choice?: string; text?: string; field: string[] }) => {
      const current = await apiRequest<SessionMetadata>(opts, `/api/sessions/${id}`)
      const plan = planAnswer(current, { choice: opts.choice, text: opts.text, fields: opts.field })

      if (plan.kind === 'prompt') {
        const result = await apiRequest<SessionMetadata>(opts, `/api/sessions/${id}/answer-prompt`, {
          method: 'POST',
          body: { index: plan.index },
        })
        emit(
          opts,
          { ...sessionEnvelope(result), answered: 'prompt', index: plan.index, option: plan.label },
          pc.green('Answered selector: ') + `${plan.index}) ${plan.label}`,
        )
        return
      }

      const result = await apiRequest<SessionMetadata>(opts, `/api/sessions/${id}/input`, {
        method: 'POST',
        body: { prompt: plan.prompt },
      })
      emit(
        opts,
        { ...sessionEnvelope(result), answered: 'inquiry', prompt: plan.prompt },
        pc.green('Answered inquiry: ') + plan.prompt.replace(/\n/g, ' | ').slice(0, 80),
      )
    }),
  )

  // ── adopt / import / export ─────────────────────────────────────────────

  withCommonOptions(
    session
      .command('adopt <harnessUuid>')
      .description('Take an existing harness session (started outside orchestron) under management')
      .requiredOption('--project <projectId>', 'Project to adopt it into')
      .option('--model <model>', 'Pin the model on the new record')
      .option('--effort <level>', effortHelp('adopt'))
      .option('--headless', 'Manage it headless')
      .option('--tmux', 'Manage it in tmux')
      .option('--dry-run', 'Validate only — do not create the record'),
  ).action(
    action(async (harnessUuid: string, opts: ModeOpts & { project: string; dryRun?: boolean }) => {
      assertEffort(opts.effort, 'adopt')
      const body = compact({
        projectId: opts.project,
        harnessSessionId: harnessUuid,
        model: opts.model,
        effort: opts.effort,
        useTmux: resolveUseTmux(opts),
      })
      if (opts.dryRun) {
        const check = await apiRequest<Record<string, unknown>>(opts, '/api/sessions/adopt/validate', {
          method: 'POST',
          body,
        })
        emit(opts, { dryRun: true, ...check }, pc.cyan('Adopt validation: ') + JSON.stringify(check))
        return
      }
      const result = await apiRequest<SessionMetadata & { coerced?: { reason?: string } }>(
        opts,
        '/api/sessions/adopt',
        { method: 'POST', body },
      )
      emit(
        opts,
        { ...sessionEnvelope(result), adoptedFrom: harnessUuid, coerced: result.coerced ?? null },
        pc.green('Adopted: ') + result.id + pc.dim(` (harness ${harnessUuid.slice(0, 8)})`) + coercionNote(result),
      )
    }),
  )

  withCommonOptions(
    session
      .command('import <file>')
      .description('Import a session bundle (.jsonl or .tar.gz) exported from another host')
      .requiredOption('--project <projectId>', 'Project to import into')
      .option('--headless', 'Run the imported session headless')
      .option('--tmux', 'Run the imported session in tmux'),
  ).action(
    action(async (file: string, opts: ModeOpts & { project: string }) => {
      const [attachment] = await readAttachments([file])
      const form = new FormData()
      form.append('file', attachment!.blob, attachment!.name)
      form.append('projectId', opts.project)
      // Multipart has no types: the route accepts only the two literal
      // spellings, and an absent field means "however this project runs".
      const useTmux = resolveUseTmux(opts)
      if (useTmux !== undefined) form.append('useTmux', String(useTmux))

      const result = await apiRequest<SessionMetadata & { coerced?: { reason?: string }; uuidRegenerated?: boolean }>(
        opts,
        '/api/sessions/import',
        { method: 'POST', rawBody: form },
      )
      emit(
        opts,
        {
          ...sessionEnvelope(result),
          importedFrom: basename(file),
          uuidRegenerated: result.uuidRegenerated ?? false,
          coerced: result.coerced ?? null,
        },
        pc.green('Imported: ') +
          result.id +
          pc.dim(` from ${basename(file)}`) +
          (result.uuidRegenerated ? pc.yellow(' (UUID collision — regenerated)') : '') +
          coercionNote(result),
      )
    }),
  )

  withCommonOptions(
    session
      .command('export <id>')
      .description('Download a session bundle for transfer to another host')
      .requiredOption('--out <path>', 'Where to write the bundle')
      .option('--format <jsonl|tar.gz>', 'Assert the expected bundle format'),
  ).action(
    action(async (id: string, opts: CommonOpts & { out: string; format?: string }) => {
      const res = await apiRaw(opts, `/api/sessions/${id}/export`)
      const written = await writeExport(res, opts.out, opts.format)
      emit(
        opts,
        { id, path: written.path, format: written.format, bytes: written.bytes, sourceUuid: written.sourceUuid },
        pc.green('Exported: ') + written.path + pc.dim(` (${written.format}, ${written.bytes} bytes)`),
      )
    }),
  )

  // ── transcript ──────────────────────────────────────────────────────────

  withCommonOptions(session.command('logs <id>').description('Tail the SSE transcript for a session')).action(
    action(async (id: string, opts: CommonOpts) => {
      const { EventSource } = await import('eventsource')
      const { resolveApiBase, resolveToken } = await import('../helpers/api.js')
      const url = `${resolveApiBase(opts)}/api/sessions/${id}/transcript`
      const headers: Record<string, string> = {}
      const token = resolveToken(opts)
      if (token) headers['Authorization'] = `Bearer ${token}`
      const es = new EventSource(url, { headers } as ConstructorParameters<typeof EventSource>[1])
      if (!opts.json) process.stdout.write(pc.cyan(`Tailing transcript for ${id}...\n`))
      es.addEventListener('message', (e: MessageEvent) => {
        process.stdout.write(String(e.data) + '\n')
      })
      es.addEventListener('error', () => {
        if (!opts.json) process.stdout.write(pc.gray('\n[Stream ended]\n'))
        // Closing the source is what lets the process end; `process.exit`
        // here would drop whatever transcript lines are still in the pipe.
        es.close()
      })
    }),
  )
}
