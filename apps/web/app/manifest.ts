import type { MetadataRoute } from 'next'

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Agent HQ Orchestron',
    short_name: 'Orchestron',
    description: 'Multi-agent orchestration hub',
    start_url: '/',
    display: 'standalone',
    theme_color: '#1a1a1a',
    background_color: '#ffffff',
    icons: [
      {
        src: '/icons/192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  }
}
