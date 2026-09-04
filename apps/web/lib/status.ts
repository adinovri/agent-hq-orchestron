import type { SessionStatus } from '@agent-hq-orchestron/shared'

export const STATUS_LABEL: Record<SessionStatus, string> = {
  spawning: 'Spawning',
  waiting: 'Waiting',
  running: 'Running',
  awaiting_input: 'Needs input',
  completing: 'Completing',
  completed: 'Completed',
  failed: 'Failed',
  killed: 'Killed',
}

// pill background + text color
export const STATUS_PILL: Record<SessionStatus, string> = {
  spawning: 'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
  waiting: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300',
  running: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  awaiting_input: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  completing: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-300',
  completed: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300',
  killed: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400',
}

// dot color for status indicator
export const STATUS_DOT: Record<SessionStatus, string> = {
  spawning: 'bg-sky-500',
  waiting: 'bg-yellow-500',
  running: 'bg-emerald-500 animate-pulse',
  awaiting_input: 'bg-amber-500 animate-pulse',
  completing: 'bg-yellow-500',
  completed: 'bg-zinc-400',
  failed: 'bg-red-500',
  killed: 'bg-zinc-400',
}

export const TERMINAL_STATUSES: SessionStatus[] = ['completed', 'failed', 'killed']
export const ACTIVE_STATUSES: SessionStatus[] = ['spawning', 'waiting', 'running', 'awaiting_input', 'completing']

export function isActive(s: SessionStatus): boolean {
  return ACTIVE_STATUSES.includes(s)
}

export function isTerminal(s: SessionStatus): boolean {
  return TERMINAL_STATUSES.includes(s)
}
