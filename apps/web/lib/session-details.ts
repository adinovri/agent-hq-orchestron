import type { SessionMetadata } from '@agent-hq-orchestron/shared'

/**
 * Whether this record runs in tmux — the web-side twin of `resolveUseTmux`
 * in `packages/shared/src/config.ts`.
 *
 * Not imported from there, and it cannot be: shared ships as one bundled
 * barrel whose `config.ts` opens with `import fs from 'node:fs'`, so a
 * runtime import pulls `fs` into the browser bundle and the webpack build
 * fails outright. Every `@agent-hq-orchestron/shared` import in apps/web is
 * an `import type` for exactly this reason. (Giving shared a browser-safe
 * subpath entry would let the real helper cross over, but that is a change
 * to the package's build and exports map, not to this panel.)
 *
 * `undefined` MUST read as tmux: records written before the flag existed
 * carry no field at all, and a bare `!useTmux` would relabel every one of
 * them headless.
 */
export function usesTmux(session: SessionMetadata): boolean {
  return session.useTmux ?? true
}

/** One label/value pair in the collapsed session details panel. */
export interface DetailRow {
  /** Left column of the grid. Rendered sans-serif, right-aligned. */
  label: string
  /** Right column. Always pre-formatted to a string so the builder stays
   *  pure and unit-testable without a DOM. */
  value: string
  /** Identifiers, paths and shell commands read better in mono; prose
   *  (a date, a status word, a project name) reads better in the body
   *  font. Mixing the two is what stops the panel looking like a terminal
   *  dump. */
  mono?: boolean
  /** Text the copy button writes to the clipboard. Absent = no button. */
  copy?: string
  /** Copy button tooltip reads `Copy <copyLabel>`. */
  copyLabel?: string
  /** Row tooltip. */
  title?: string
  /** Muted note after the value — e.g. where an inherited default came
   *  from, or the currency a number is denominated in. */
  hint?: string
}

/** A titled group of rows. Sections with no rows are dropped by the
 *  builder, so a headless session never shows an empty COMMANDS header. */
export interface DetailSection {
  title: string
  rows: DetailRow[]
}

export interface SessionDetailInput {
  session: SessionMetadata
  /** Human project name; falls back to the raw project id. */
  projectName?: string
  /** Workspace directory the harness was spawned in. */
  projectPath?: string
  /** Model actually in force — session value, else project default, else
   *  harness default. Resolved by the caller, which owns those sources. */
  effectiveModel?: string
  effectiveEffort?: string
  /** Provenance note when the effective value is inherited rather than
   *  set on the session itself. */
  modelHint?: string
  effortHint?: string
}

/** The shell command that resumes this session's conversation. */
export function resumeCommandFor(session: SessionMetadata): string | null {
  if (!session.claudeSessionUuid) return null
  return session.agentType === 'codex'
    ? `codex resume ${session.claudeSessionUuid}`
    : `claude --resume ${session.claudeSessionUuid}`
}

/**
 * Read-only tmux attach command, or null for a headless session.
 *
 * The gate is the mode, not `tmuxName`. A headless record carries a name
 * too — the API mints `headless-<uuid8>` as the ownership token
 * `stillOwns()` compares against and as the key of the child-process
 * registry — so a truthiness test on the name reads as "has a window"
 * when it only means "has a handle", and offers an attach that cannot
 * connect to anything.
 */
export function attachCommandFor(session: SessionMetadata): string | null {
  if (!usesTmux(session)) return null
  if (!session.tmuxName) return null
  return `tmux attach -rt ${session.tmuxName}`
}

/**
 * Group the session record into the four sections the details panel
 * renders: who it is, where it lives, how to get back into it, and when
 * it ran. Pure — no React, no DOM — so the grouping and skip rules can be
 * asserted directly.
 */
export function buildSessionDetailSections(input: SessionDetailInput): DetailSection[] {
  const { session, projectName, projectPath, effectiveModel, effectiveEffort, modelHint, effortHint } = input

  const identity: DetailRow[] = [
    {
      label: 'session id',
      value: session.id,
      mono: true,
      copy: session.id,
      copyLabel: 'session id',
    },
  ]

  if (session.claudeSessionUuid) {
    identity.push({
      label: `${session.agentType} session`,
      value: session.claudeSessionUuid,
      mono: true,
      copy: session.claudeSessionUuid,
      copyLabel: 'harness session id',
      title: 'Harness-native conversation id — the one the resume command takes',
    })
  }

  identity.push({ label: 'agent', value: session.agentType })

  if (effectiveModel) {
    identity.push({ label: 'model', value: effectiveModel, mono: true, hint: modelHint })
  }
  if (effectiveEffort) {
    identity.push({ label: 'effort', value: effectiveEffort, hint: effortHint })
  }

  identity.push({ label: 'status', value: session.status })
  // One resolved read, shared by the mode row and the tmux gate below.
  const isTmux = usesTmux(session)
  identity.push({
    label: 'mode',
    value: isTmux ? 'tmux' : 'headless',
    title: isTmux
      ? 'Runs in a long-lived tmux window with a live TUI'
      : 'Each turn runs as its own one-shot process — no tmux, nothing to attach to',
  })

  const location: DetailRow[] = [
    { label: 'project', value: projectName ?? session.projectId },
  ]

  if (projectPath) {
    location.push({
      label: 'workspace',
      value: projectPath,
      mono: true,
      copy: projectPath,
      copyLabel: 'workspace path',
      title: 'Workspace directory — cd here before running the resume command',
    })
  }
  if (session.configDir) {
    location.push({
      label: 'config dir',
      value: session.configDir,
      mono: true,
      copy: session.configDir,
      copyLabel: 'config dir',
      title: 'CLAUDE_CONFIG_DIR captured at spawn — resume must use the same one or the transcript will not be found',
    })
  }
  // Mode-gated for the same reason as `attachCommandFor`: the synthetic
  // headless handle is an internal token, and showing it invites an
  // attach against a window that was never created.
  if (isTmux && session.tmuxName) {
    location.push({
      label: 'tmux',
      value: session.tmuxName,
      mono: true,
      copy: session.tmuxName,
      copyLabel: 'tmux name',
    })
  }

  const commands: DetailRow[] = []
  const resumeCmd = resumeCommandFor(session)
  if (resumeCmd) {
    commands.push({
      label: 'resume',
      value: resumeCmd,
      mono: true,
      copy: resumeCmd,
      copyLabel: 'resume command',
      title: 'Continue this conversation in your own terminal',
    })
  }
  const attachCmd = attachCommandFor(session)
  if (attachCmd) {
    commands.push({
      label: 'attach',
      value: attachCmd,
      mono: true,
      copy: attachCmd,
      copyLabel: 'attach command',
      title: 'Attach to the live tmux window read-only',
    })
  }

  const timing: DetailRow[] = [
    { label: 'started', value: new Date(session.startedAt).toLocaleString() },
  ]
  if (session.endedAt) {
    timing.push({ label: 'ended', value: new Date(session.endedAt).toLocaleString() })
  }
  if (session.failureReason) {
    timing.push({ label: 'failure', value: session.failureReason })
  }
  if (session.costUsd != null) {
    timing.push({ label: 'cost', value: `$${session.costUsd.toFixed(4)}`, mono: true, hint: 'USD' })
  }

  return [
    { title: 'Identity', rows: identity },
    { title: 'Location', rows: location },
    { title: 'Commands', rows: commands },
    { title: 'Timing', rows: timing },
  ].filter((s) => s.rows.length > 0)
}
