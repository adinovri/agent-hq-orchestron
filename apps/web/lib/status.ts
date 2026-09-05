import type { SessionStatus } from '@agent-hq-orchestron/shared'

export const STATUS_LABEL: Record<SessionStatus, string> = {
  spawning: 'Spawning',
  waiting: 'Waiting',
  running: 'Running',
  needs_input: 'Needs input',
  idle: 'Idle',
  sleeping: 'Sleeping',
  completing: 'Completing',
  completed: 'Completed',
  succeeded: 'Succeeded',
  failed: 'Failed',
  killed: 'Killed',
}

// pill background + text color
export const STATUS_PILL: Record<SessionStatus, string> = {
  spawning: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  waiting: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300',
  running: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  needs_input: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  idle: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  sleeping: 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/50 dark:text-indigo-300',
  completing: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300',
  completed: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  succeeded: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  killed: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
}

// dot color for status indicator
export const STATUS_DOT: Record<SessionStatus, string> = {
  spawning: 'bg-sky-500',
  waiting: 'bg-yellow-500',
  running: 'bg-emerald-500 animate-pulse',
  needs_input: 'bg-amber-500 animate-pulse',
  idle: 'bg-zinc-400',
  sleeping: 'bg-indigo-400',
  completing: 'bg-yellow-500',
  completed: 'bg-zinc-400',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  killed: 'bg-zinc-400',
}

export const TERMINAL_STATUSES: SessionStatus[] = ['completed', 'succeeded', 'failed', 'killed']
// "Active" for the UI's purposes = costs a live resource OR is alive but hidden.
// Sleeping sits between active-and-idle: no tmux, but session is resumable.
export const ACTIVE_STATUSES: SessionStatus[] = ['spawning', 'waiting', 'running', 'needs_input', 'idle', 'completing']
// Sending input to a sleeping session triggers a wake-up (cold-start tmux
// with --resume), so it's a valid input target.
export const INPUT_ALLOWED_STATUSES: SessionStatus[] = ['needs_input', 'idle', 'waiting', 'sleeping']

export function isActive(s: SessionStatus): boolean {
  return ACTIVE_STATUSES.includes(s)
}

export function isTerminal(s: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(s)
}
