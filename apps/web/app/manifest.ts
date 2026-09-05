import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Agent HQ Orchestron',
    short_name: 'Orchestron',
    description: 'Multi-agent orchestration hub',
    start_url: '/',
    display: 'standalone',
    theme_color: '#0e0e10',
    background_color: '#0e0e10',
    icons: [
      { src: '/icons/192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
