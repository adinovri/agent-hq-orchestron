'use client'

import { useQuery } from '@tanstack/react-query'
import { fetchJson } from '@/lib/fetcher'
import { isTerminal } from '@/lib/status'
import type { SessionStatus } from '@agent-hq-orchestron/shared'

/** Authed server diagnostics. `/api/health` is anonymous `{ok:true}` only —
 *  everything below moved behind the Bearer token at `/api/health/detail`
 *  after security pass-1 finding #3. */
export interface HealthDetail {
  ok: boolean
  tmux: string
  storage: string
  bindHost: string
  remoteAuth: 'enabled' | 'disabled'
  maxConcurrent: number
  platform?: NodeJS.Platform
  uid?: number | null
  /** Global headless kill switch. `false` hides every "Use tmux" toggle —
   *  the server coerces headless requests to tmux anyway, so there is no
   *  choice left to present. Absent on servers older than the flag. */
  enableHeadlessMode?: boolean
}

/** Shares the `['health']` query key with the Settings page so the dialogs
 *  ride its cache instead of firing their own request per open. */
export function useHealthDetail() {
  return useQuery<HealthDetail>({
    queryKey: ['health'],
    queryFn: () => fetchJson('/api/health/detail'),
    staleTime: 30_000,
    // Settings renders this as a live server-status panel; the dialogs
    // ride the same cache and unmount long before it matters.
    refetchInterval: 30_000,
  })
}

/**
 * Whether headless mode may be requested at all.
 *
 * Optimistic `true` while loading, on error, and against an older server
 * that does not report the field — so the "Use tmux" toggle stays visible
 * unless the server has actually said the switch is off. The API is the
 * enforcement layer (it coerces a headless request to tmux regardless of
 * what the UI believes), so guessing "enabled" costs at worst a spawn that
 * comes back with a `coerced` notice, whereas guessing "disabled" would
 * hide the toggle from everyone whose health fetch is slow or blocked.
 */
export function useHeadlessEnabled(): boolean {
  const { data } = useHealthDetail()
  return data?.enableHeadlessMode ?? true
}

/**
 * Whether a session's "headless" badge should be shown.
 *
 * With the switch on, it always is — the badge states a fact about the
 * session and nothing is being masked.
 *
 * With the switch off, the badge survives only while the session is still
 * live. A running headless session genuinely *is* headless: the process was
 * launched that way and cannot be intercepted mid-flight, so hiding the
 * badge would misdescribe what is on the machine. Once it reaches a terminal
 * state the badge is describing a mode the user can no longer choose, next
 * to Reopen/Respawn buttons that will not produce it — so it comes off, in
 * keeping with the rest of the masking.
 *
 * `?? true`: a record written before the toggle existed has no field and is
 * a tmux session, which never had a badge anyway.
 */
export function useHeadlessBadgeVisible(
  useTmux: boolean | undefined,
  status: SessionStatus,
): boolean {
  const headlessEnabled = useHeadlessEnabled()
  // `?? true` rather than shared's resolveUseTmux: importing a runtime
  // value from shared pulls its config module — and `node:fs` with it —
  // into the client bundle. Every other component here spells the same
  // nullish default inline for that reason.
  if (useTmux ?? true) return false
  return headlessEnabled || !isTerminal(status)
}
