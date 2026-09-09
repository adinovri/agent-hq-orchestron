'use client'

import { useQuery } from '@tanstack/react-query'
import { fetchJson } from '@/lib/fetcher'

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
