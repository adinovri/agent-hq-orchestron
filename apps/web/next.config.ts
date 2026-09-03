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

const nextConfig: NextConfig = {
  /* config options here */
}

export default withSerwist(nextConfig)
