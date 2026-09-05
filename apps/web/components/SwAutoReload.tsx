'use client'

import { useEffect } from 'react'

/**
 * Reload the page when a new service worker takes control. Serwist installs
 * new SW with skipWaiting+clientsClaim, so `controllerchange` fires when the
 * fresh SW activates — at that point the currently-loaded JS bundle is stale
 * and we need to reload to fetch the new one.
 */
export function SwAutoReload() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

    // Skip reload on the very first controller assignment (initial page load
    // when no SW existed before). Only reload when the controller CHANGES
    // (a NEW SW replaces the old one).
    let hadController = !!navigator.serviceWorker.controller

    const onChange = () => {
      if (!hadController) {
        // First controller — that's the initial install, not a swap. Mark and skip.
        hadController = true
        return
      }
      // eslint-disable-next-line no-console
      console.info('[sw-auto-reload] new service worker took control — reloading')
      // Small delay lets any in-flight SSE close cleanly
      setTimeout(() => window.location.reload(), 100)
    }

    navigator.serviceWorker.addEventListener('controllerchange', onChange)
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onChange)
  }, [])

  return null
}
