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
    // API routes — never cache
    {
      matcher: ({ url }) =>
        url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/api/stream') || url.pathname.includes('/stream'),
      handler: new NetworkOnly(),
    },
    // App shell — network first, fall back to cache
    {
      matcher: ({ request }) =>
        request.mode === 'navigate' ||
        request.destination === 'style' ||
        request.destination === 'script' ||
        request.destination === 'font',
      handler: new NetworkFirst({ cacheName: 'shell-cache' }),
    },
    ...defaultCache,
  ],
})

serwist.addEventListeners()
