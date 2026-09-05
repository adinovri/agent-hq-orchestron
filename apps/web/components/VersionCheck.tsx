'use client'

import { useEffect, useState } from 'react'
import { fetchJson } from '@/lib/fetcher'
import { RefreshCw, AlertCircle } from 'lucide-react'

const CHECK_INTERVAL_MS = 30_000
const CLIENT_STAMP = process.env.NEXT_PUBLIC_BUILD_STAMP ?? 'dev'

interface VersionResponse {
  buildId: string
}

/**
 * Compare the running client's build stamp with the API's live view of the
 * web bundle's BUILD_ID. When they diverge (a rolling deploy happened), show
 * a persistent banner offering a hard reload. Handles the case where a stuck
 * SW cache prevents the normal update flow.
 */
export function VersionCheck() {
  const [stale, setStale] = useState(false)
  const [serverBuild, setServerBuild] = useState<string | null>(null)

  useEffect(() => {
    let stopped = false

    // Initial ref: whatever the API reports on first check becomes the baseline.
    // If subsequent checks return a DIFFERENT id, we're on an old client.
    let baseline: string | null = null

    const check = async () => {
      try {
        const v = await fetchJson<VersionResponse>('/api/version')
        if (stopped) return
        setServerBuild(v.buildId)
        if (baseline === null) {
          baseline = v.buildId
          return
        }
        if (v.buildId !== baseline) {
          setStale(true)
        }
      } catch { /* offline — skip */ }
    }

    check()
    const timer = setInterval(check, CHECK_INTERVAL_MS)
    return () => { stopped = true; clearInterval(timer) }
  }, [])

  if (!stale) return null

  const hardReload = async () => {
    // Try to unregister SW so next load is clean
    if ('serviceWorker' in navigator) {
      try {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((r) => r.unregister()))
      } catch { /* ignore */ }
    }
    if ('caches' in window) {
      try {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      } catch { /* ignore */ }
    }
    // Bypass cache
    window.location.href = window.location.pathname + '?_v=' + Date.now()
  }

  return (
    <div className="fixed bottom-3 left-3 right-3 z-50 sm:left-auto sm:w-80 bg-amber-50 dark:bg-amber-950 border border-amber-300 dark:border-amber-800 rounded-lg shadow-lg p-3 flex items-start gap-2">
      <AlertCircle className="w-4 h-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
      <div className="flex-1 min-w-0 text-xs text-amber-900 dark:text-amber-100">
        <p className="font-medium mb-0.5">New version available</p>
        <p className="text-amber-700 dark:text-amber-300 text-[11px] mb-2">
          Client: {CLIENT_STAMP.slice(-8)} · Server: {serverBuild?.slice(-8) ?? '?'}
        </p>
        <button
          onClick={hardReload}
          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium transition"
        >
          <RefreshCw className="w-3 h-3" /> Reload now
        </button>
      </div>
    </div>
  )
}
