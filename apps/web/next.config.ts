import type { NextConfig } from 'next'
import withSerwistInit from '@serwist/next'

// Where this build's output goes. `.next` unless NEXT_DIST_DIR moves it.
//
// The E2E environment (scripts/e2e-env.sh) builds the same working tree a
// second time against a different API port, and two builds sharing `.next`
// means whichever ran last decides what the *other* server serves. A
// separate dist dir is what lets a second `next start` coexist with the
// deployed one. Both `next build` and `next start` read this file, so the
// env var has to be set for both — the E2E systemd unit sets it.
const DIST_DIR = process.env.NEXT_DIST_DIR || '.next'

const withSerwist = withSerwistInit({
  swSrc: 'app/sw.ts',
  swDest: 'public/sw.js',
  // The service worker is the one build artifact that is NOT under distDir:
  // it lands in `public/`, which is source-tracked and shared by every
  // build of this tree. An E2E build would therefore overwrite the deployed
  // SW with a precache manifest naming E2E's chunk hashes, and the deployed
  // PWA would start fetching assets that do not exist. So the E2E build
  // turns Serwist off rather than pointing it elsewhere — a second swDest
  // would still not be reachable, since the registration URL is /sw.js.
  //
  // Cost, stated plainly: no service worker and no offline/PWA behaviour in
  // the E2E environment. PWA scenarios have to run against a real deploy.
  disable: process.env.NEXT_DISABLE_SW === '1',
  // Don't cache /api/* or SSE/WS paths
  exclude: [
    /\/api\//,
    // exclude sourcemaps from precache
    /\.map$/,
  ],
})

// Resolve the API base URL for server-side rewrites. Precedence:
//   1. NEXT_PUBLIC_API_URL from env (systemd unit or manual override)
//   2. the API's own config.json { bindHost, port } — so a bare
//      `npm run build` still gets the right target when the API is bound to
//      a non-loopback interface (e.g. tailscale). Which file that is follows
//      the same ORCHESTRON_CONFIG / ORCHESTRON_DATA_DIR precedence the API
//      uses (packages/shared `resolveConfigPath`), inlined rather than
//      imported: pulling the shared barrel into next.config drags `node:fs`
//      into the client bundle graph.
//   3. Loopback fallback (only correct when API also binds to 127.0.0.1).
function resolveApiUrl(): string {
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL
  try {
    // Lazy require so this stays edge-safe when NEXT_PUBLIC_API_URL is set.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('node:os') as typeof import('node:os')
    const dataDir = process.env.ORCHESTRON_DATA_DIR || process.env.AHQ_DATA_DIR
    const cfgPath = process.env.ORCHESTRON_CONFIG
      || path.join(dataDir || path.join(os.homedir(), '.orchestron'), 'config.json')
    const raw = fs.readFileSync(cfgPath, 'utf8')
    const cfg = JSON.parse(raw) as { bindHost?: string; port?: number }
    const host = cfg.bindHost === '0.0.0.0' ? '127.0.0.1' : (cfg.bindHost ?? '127.0.0.1')
    const port = cfg.port ?? 8090
    return `http://${host}:${port}`
  } catch { /* fall through */ }
  return 'http://127.0.0.1:8090'
}

const API_URL = resolveApiUrl()
console.log(`[next.config] Rewriting /api/* → ${API_URL}`)

// Expose build stamp so client can display which bundle it's running. Prefer
// the git commit SHA (short) so identical commits built on different hosts /
// at different times get the SAME chip — makes cross-host "are these in
// sync?" checks meaningful. Falls back to a build timestamp when git isn't
// available (release tarball, no repo, etc). Explicit BUILD_STAMP env
// override always wins for CI use.
function computeBuildStamp(): string {
  const explicit = process.env.BUILD_STAMP
  if (explicit) return explicit
  try {
    // execSync is synchronous — fine at build config load
    const sha = require('node:child_process')
      .execSync('git rev-parse --short=8 HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
    if (sha && /^[0-9a-f]{6,}$/.test(sha)) return sha
  } catch { /* not a git repo or git not on PATH — fall through */ }
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}
const BUILD_STAMP = computeBuildStamp()

const nextConfig: NextConfig = {
  distDir: DIST_DIR,
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
