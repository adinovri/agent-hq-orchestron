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
  /** Global headless kill switch. Absent on servers older than the flag. */
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
 * that does not report the field. The API is the enforcement layer — it
 * 400s an explicit `useTmux:false` regardless of what the UI believes —
 * so guessing "enabled" only risks a rejected submit, whereas guessing
 * "disabled" would lock the checkbox for everyone whose health fetch
 * happens to be slow or blocked.
 */
export function useHeadlessEnabled(): boolean {
  const { data } = useHealthDetail()
  return data?.enableHeadlessMode ?? true
}

export const HEADLESS_DISABLED_TOOLTIP =
  'Headless disabled globally. Enable via ~/.orchestron/config.json'
