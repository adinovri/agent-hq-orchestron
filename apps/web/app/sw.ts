import { defaultCache } from '@serwist/next/worker'
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist'
import { Serwist, NetworkFirst, NetworkOnly } from 'serwist'

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined
  }
}

declare const self: ServiceWorkerGlobalScope & typeof globalThis & {
  __SW_MANIFEST: (PrecacheEntry | string)[] | undefined
}

// Precache disabled: with Next.js rolling builds, old hashed chunks are
// purged from the server on the next deploy → old SW's precache manifest
// 404s → `bad-precaching-response` throws → SW enters broken state and
// serves stale responses for everything. Runtime-only caching is safer:
// we always try the network first, cache what succeeds, serve cache as
// fallback. Cost: no offline install, but Adi's on Tailscale (always online).
// Note: Serwist requires the literal `self.__SW_MANIFEST` reference in
// source for its build-time substitution, so we consume the value but
// discard it. Passing [] to precacheEntries opts out of precache install.
const _manifest = self.__SW_MANIFEST
void _manifest
const serwist = new Serwist({
  precacheEntries: [],
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    // App shell — network first, fall back to cache. Explicitly EXCLUDE any
    // API request or event-stream (SW's fetch() cannot handle infinite SSE
    // — buffers indefinitely → ERR_FAILED → retry storm).
    {
      matcher: ({ request, url }) => {
        if (url.pathname.startsWith('/api/')) return false
        if (request.headers.get('Accept') === 'text/event-stream') return false
        return (
          request.mode === 'navigate' ||
          request.destination === 'style' ||
          request.destination === 'script' ||
          request.destination === 'font'
        )
      },
      handler: new NetworkFirst({ cacheName: 'shell-cache' }),
    },
    ...defaultCache,
  ],
})

// Intercept ALL fetch events for /api/* or event-stream and pass through
// without touching them — this is the ONLY way to keep EventSource working
// through a service worker.
self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url)
  const isApi = url.pathname.startsWith('/api/')
  const isEventStream = event.request.headers.get('Accept') === 'text/event-stream'
  if (isApi || isEventStream) {
    // Do NOT call respondWith — browser handles the request natively,
    // bypassing SW entirely for streaming semantics.
    return
  }
})

serwist.addEventListeners()
