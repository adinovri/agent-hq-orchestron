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
}

export default withSerwist(nextConfig)
