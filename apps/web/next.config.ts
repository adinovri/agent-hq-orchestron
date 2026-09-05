import type { NextConfig } from 'next'
import withSerwistInit from '@serwist/next'

const withSerwist = withSerwistInit({
  swSrc: 'app/sw.ts',
  swDest: 'public/sw.js',
  // Don't cache /api/* or SSE/WS paths
  exclude: [
    /\/api\//,
    // exclude sourcemaps from precache
    /\.map$/,
  ],
})

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8090'

// Expose build timestamp so client can display which bundle it's running.
// Rebuild every time invalidates cache implicitly and gives us a debug tag.
const BUILD_STAMP = new Date().toISOString().replace('T', ' ').slice(0, 19)

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_BUILD_STAMP: BUILD_STAMP,
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${API_URL}/api/:path*`,
      },
    ]
  },
  // Force HTML to never be cached — Next.js's default prerender cache
  // (s-maxage=31536000) means stale HTML persists across deploys even when
  // hashed JS chunks change. Hashed static assets stay long-cached (immutable).
  async headers() {
    return [
      {
        // Match all NON-static routes (HTML pages).
        // Excludes /_next/static, /icons/, etc.
        source: '/:path((?!_next/static|_next/image|icons|.*\\..*).*)*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ]
  },
}

export default withSerwist(nextConfig)
