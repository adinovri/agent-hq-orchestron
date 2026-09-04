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

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
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
