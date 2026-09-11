import Fastify from 'fastify'
import cors from '@fastify/cors'
import sensible from '@fastify/sensible'
import rateLimit from '@fastify/rate-limit'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import {
  loadConfig,
  migrateLegacyTokenKey,
  assertSafeBind,
  BootGuardError,
  type Config,
} from '@agent-hq-orchestron/shared'
import authPlugin from './plugins/auth.js'
import { SessionManager } from './domain/session-manager.js'
import { ProjectRegistry } from './domain/project-registry.js'
import { DelegationTracker } from './domain/delegation-tracker.js'
import { HookRunner } from './domain/hook-runner.js'
import { TemplateResolver } from './domain/template-resolver.js'
import { ClaudeAdapter } from './adapters/claude.js'
import { CodexAdapter } from './adapters/codex.js'
import { OpenCodeAdapter } from './adapters/opencode.js'
import { AdapterRegistry } from './adapters/registry.js'
import { projectsPlugin } from './routes/projects.js'
import { sessionsPlugin } from './routes/sessions.js'
import { delegationPlugin } from './routes/delegation.js'
import { streamPlugin } from './routes/stream.js'
import { SnapshotService } from './domain/snapshot-service.js'
import { scanOrphans } from './startup/orphan-scanner.js'
import { MetricsCollector } from './domain/metrics-collector.js'
import { metricsPlugin } from './routes/metrics.js'
import { Scheduler } from './domain/scheduler.js'
import { schedulesPlugin } from './routes/schedules.js'
import { NotesStore } from './domain/notes-store.js'
import { notesPlugin } from './routes/notes.js'
import { readinessPlugin } from './routes/readiness.js'

const execFileAsync = promisify(execFile)

let config: Config
try {
  // One-shot cleanup of the pre-B6-F1 config key. A `config.json` written
  // by the old `orchestron token rotate` has `token` where the schema
  // reads `remoteToken`; rewrite it before the load so the file on disk
  // and the key the API authenticates against stop disagreeing. Failure
  // is non-fatal — loadConfig folds the legacy key in memory regardless.
  migrateLegacyTokenKey()
  config = loadConfig()
  assertSafeBind(config)
} catch (err) {
  if (err instanceof BootGuardError) {
    console.error(`boot guard: ${err.message}`)
  } else {
    console.error('config load failed:', (err as Error).message)
  }
  process.exit(1)
}

const registry = new AdapterRegistry()
if (config.adapters.claude) registry.register('claude', new ClaudeAdapter())
if (config.adapters.codex) registry.register('codex', new CodexAdapter())
if (config.adapters.opencode) registry.register('opencode', new OpenCodeAdapter())

// Resolve MCP server path once at boot. dist/mcp-server.js sits next to
// dist/server.js when built; dev (tsx) reads src/mcp-server.ts — either way
// import.meta.url points into the running module tree.
const { fileURLToPath } = await import('node:url')
const { dirname, resolve } = await import('node:path')
const __serverDir = dirname(fileURLToPath(import.meta.url))
const mcpServerPath = resolve(__serverDir, 'mcp-server.js')

const sessionManager = new SessionManager({
  dataDir: config.dataDir,
  maxConcurrent: config.maxConcurrent,
  idleTimeoutMs: config.idleTimeoutMs,
  // Hand headless runs the `inquiry` schema so an agent with no TUI can
  // still ask the user something. Off means headless keeps its Phase 1
  // behaviour: prose in finalResponse, and no way to raise a question.
  headlessStructuredOutput: config.headlessStructuredOutput,
  // Global headless kill switch. The routes coerce request bodies; this
  // makes the manager itself coerce at the spawn boundary, which is what
  // catches respawn and any other path that never sees a body.
  enableHeadlessMode: config.enableHeadlessMode,
  // Every claude spawn/reopen/clone/respawn ensures the per-workspace
  // memory dir is a symlink to this shared pool. Matches the manual layout
  // Adi already uses for CLI sessions. Set env ORCHESTRON_SHARED_MEMORY_DIR=''
  // to disable.
  sharedMemoryDir: process.env['ORCHESTRON_SHARED_MEMORY_DIR']
    ?? path.join(os.homedir(), '.claude', 'shared-memory'),
  // Codex equivalent: every codex spawn/reopen/clone/respawn symlinks
  // <CODEX_HOME>/memories_1.sqlite to this shared file. Only the memories
  // DB is shared — thread_history / goals / queue remain per-CODEX_HOME so
  // conversation state stays isolated per identity. Set env
  // ORCHESTRON_SHARED_CODEX_MEMORY_DIR='' to disable.
  sharedCodexMemoryDir: process.env['ORCHESTRON_SHARED_CODEX_MEMORY_DIR']
    ?? path.join(os.homedir(), '.codex-shared-memory'),
  mcpAutoInject: config.remoteToken
    ? {
        apiUrl: `http://${config.bindHost === '0.0.0.0' ? '127.0.0.1' : config.bindHost}:${config.port}`,
        token: config.remoteToken,
        mcpServerPath,
      }
    : undefined,
}, registry)
const snapshotService = new SnapshotService(config.dataDir)
const metricsCollector = new MetricsCollector(config.dataDir, sessionManager)
const projectRegistry = new ProjectRegistry(config.dataDir)
const delegationTracker = new DelegationTracker(config.dataDir)
const hookRunner = new HookRunner({ dataDir: config.dataDir })
const templateResolver = new TemplateResolver(config.dataDir)
const scheduler = new Scheduler(
  config.dataDir,
  `http://${config.bindHost === '0.0.0.0' ? '127.0.0.1' : config.bindHost}:${config.port}`,
  config.remoteToken,
)

const fastify = Fastify({
  logger: {
    level: config.logLevel,
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
})

// Same-origin only. The Next.js web workspace proxies /api/* server-side
// (see apps/web/next.config.ts rewrites), so the browser never talks to
// the API cross-origin in the supported flow; CLI/curl callers don't send
// Origin so they aren't affected. Reflecting arbitrary origins was CSRF-
// enabling: on a default install with no remoteToken, any page the
// operator visited could drive-by-fetch the API and spawn shell-executing
// agent sessions. Set to false to refuse cross-origin browser requests.
await fastify.register(cors, { origin: false })
await fastify.register(sensible)

// Global rate limit — an authenticated caller (or a compromised MCP
// agent that reached the real remoteToken via ORCHESTRON_TOKEN) can
// otherwise flood /input, /notes, or /import until the event loop
// stalls. Key on bearer token when present, IP otherwise. 600 req/min
// is generous — the dashboard poll cadence is ~1 req/2s per open
// session and even 20 idle sessions stay well under.
await fastify.register(rateLimit, {
  max: 600,
  timeWindow: '1 minute',
  allowList: ['127.0.0.1', '::1'],   // loopback (dev/proxy) exempt
  keyGenerator: (req) => {
    const auth = req.headers.authorization ?? ''
    return auth.startsWith('Bearer ') ? `bearer:${auth.slice(7, 15)}` : req.ip
  },
})

await fastify.register(authPlugin, { config })

// Accept YAML/plain-text bodies (used by /api/schedules/import).
fastify.addContentTypeParser(
  ['application/x-yaml', 'application/yaml', 'text/yaml', 'text/plain'],
  { parseAs: 'string' },
  (_req, body, done) => done(null, body),
)

// Reset endpoint: served by API (bypass Web service worker) — clears client-side state.
// Also whitelisted from auth in plugins/auth.ts because Bearer token isn't required to nuke SW.
//
// It deliberately does NOT redirect when it finishes. `/pair` on this
// origin is the API, not the web app, so the old `window.location.href =
// '/pair'` dropped the browser on an Unauthorized JSON body immediately
// after wiping the token that would have satisfied it (B6-F5). The API
// cannot know the web UI's origin — nothing in the config records it —
// so it names the destination instead of guessing a port.
fastify.get('/api/reset', async (_req, reply) => {
  reply.type('text/html')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Orchestron Reset</title>
<style>body{font-family:monospace;background:#000;color:#fff;padding:20px;white-space:pre-wrap;font-size:14px;line-height:1.5}h1{font-size:20px;margin-bottom:16px}</style>
</head>
<body>
<h1>Orchestron Reset</h1>
<div id="log">Resetting...</div>
<script>
(async () => {
  const log = document.getElementById('log');
  const steps = [];
  const push = (s) => { steps.push(s); log.textContent = steps.join('\\n'); };
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) { await r.unregister(); push('✓ Unregistered SW: ' + r.scope); }
      if (!regs.length) push('- No SW registered');
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      for (const k of keys) { await caches.delete(k); push('✓ Deleted cache: ' + k); }
      if (!keys.length) push('- No caches');
    }
    try { sessionStorage.clear(); localStorage.clear(); push('✓ Cleared storage'); } catch(e) { push('⚠ storage: ' + e.message); }
    if ('indexedDB' in window && indexedDB.databases) {
      try {
        const dbs = await indexedDB.databases();
        for (const db of dbs) { if (db.name) { indexedDB.deleteDatabase(db.name); push('✓ Deleted IDB: ' + db.name); } }
      } catch(e) { /* ignore */ }
    }
    push('');
    push('Done. Client state cleared.');
    push('');
    push('This page is served by the API, which has no UI. Open the Orchestron');
    push('web UI and visit /pair to re-pair, or run: orchestron qr');
  } catch (err) {
    push('ERROR: ' + err.message);
  }
})();
</script>
</body>
</html>`
})

// `/pair` belongs to the web app. It is registered here — auth-whitelisted,
// answering 404 — purely so the answer is an explanation rather than
// `{"error":"Unauthorized"}` for anyone who reaches it on the API origin:
// a bookmark, a cached copy of the pre-batch-7 reset page, or a hand-typed
// URL. 404 is the honest code; this server really does not have the page.
fastify.get('/pair', async (_req, reply) => {
  reply.code(404).type('text/html')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not the pairing page</title>
<style>body{font-family:monospace;background:#000;color:#fff;padding:20px;white-space:pre-wrap;font-size:14px;line-height:1.6}h1{font-size:20px;margin-bottom:16px}code{color:#7dd3fc}</style>
</head>
<body>
<h1>404 — pairing lives on the web UI</h1>
This is the Orchestron API. It serves no pages except <code>/api/reset</code>.

To pair a device, open the Orchestron <b>web UI</b> and visit <code>/pair</code>,
or run <code>orchestron qr</code> on the host to print a pairing QR code.
</body>
</html>`
})

// Stub: templates listing. Real template CRUD not yet implemented — return empty array
// so dashboard React Query doesn't 404-throw.
fastify.get('/api/templates', async () => ({ templates: [] }))

// Anonymous liveness — no auth required (in AUTH_WHITELIST). Keeps the
// body minimal so unauth callers on the tailnet can't fingerprint the
// host (absolute dataDir path, bindHost, remoteAuth state, tmux version).
// The verbose diagnostics moved to /api/health/detail below, which
// requires the Bearer token like the rest of the API.
fastify.get('/api/health', async () => {
  return { ok: true }
})

fastify.get('/api/health/detail', async () => {
  let tmuxVersion = 'unavailable'
  try {
    const { stdout } = await execFileAsync('tmux', ['-V'])
    tmuxVersion = stdout.trim()
  } catch {
    // tmux not installed
  }

  return {
    ok: true,
    tmux: tmuxVersion,
    storage: config.dataDir,
    bindHost: config.bindHost,
    remoteAuth: config.remoteToken ? 'enabled' : 'disabled',
    maxConcurrent: config.maxConcurrent,
    // Surface the host OS so the Settings page can render the right
    // restart command (systemctl on Linux, launchctl on macOS). Also
    // include uid so the launchctl gui/<uid> selector is exact per host.
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    // Global headless kill switch. The web dialogs read this to hide the
    // "Use tmux" checkbox entirely — with the switch off there is no choice
    // left to present, so showing a disabled control would just be noise.
    enableHeadlessMode: config.enableHeadlessMode,
    headlessStructuredOutput: config.headlessStructuredOutput,
    // Auto-sleep threshold, so the idle chip can state the threshold actually
    // in force instead of the 15-minute default it used to hardcode (NF14).
    // An instance that tuned this — the E2E one runs 60s — was telling every
    // viewer the wrong number, and the amber "about to sleep" warning never
    // fired at all below a 10-minute timeout.
    idleTimeoutMs: config.idleTimeoutMs,
  }
})

// Live web build id — the api reads the web bundle's BUILD_ID file at request
// time. Clients baked with a stale NEXT_PUBLIC_BUILD_STAMP can poll this to
// detect a rolling deploy and hard-refresh themselves out of a stuck SW cache.
fastify.get('/api/version', async () => {
  const { readFile } = await import('node:fs/promises')
  const { resolve } = await import('node:path')
  let buildId = 'unknown'
  try {
    // The web bundle's dist dir is `.next` unless NEXT_DIST_DIR moved it —
    // which the E2E environment does, so that its `next start` and the
    // deployed one do not share build output. An API told to look at the
    // wrong one would report the other instance's build id, and the client
    // staleness check would compare a bundle against a stranger.
    const distDir = process.env['NEXT_DIST_DIR'] || '.next'
    const buildIdPath = resolve(process.cwd(), '../web', distDir, 'BUILD_ID')
    buildId = (await readFile(buildIdPath, 'utf8')).trim()
  } catch { /* web not built */ }
  return { buildId, serverStartedAt: new Date(process.uptime() * -1000 + Date.now()).toISOString() }
})

// Readiness before the rest: it is in AUTH_WHITELIST and the only route a
// load balancer polls, so it must exist for real and not only in a fixture.
await fastify.register(readinessPlugin(config, registry))
await fastify.register(projectsPlugin(projectRegistry))
await fastify.register(sessionsPlugin(sessionManager, hookRunner, templateResolver, delegationTracker, projectRegistry, { enableHeadlessMode: config.enableHeadlessMode }))
await fastify.register(delegationPlugin(delegationTracker, sessionManager))
await fastify.register(streamPlugin(sessionManager, config.dataDir))
await fastify.register(metricsPlugin(metricsCollector))
await fastify.register(schedulesPlugin(scheduler, { enableHeadlessMode: config.enableHeadlessMode }))
const notesStore = new NotesStore(config.dataDir)
await fastify.register(notesPlugin(notesStore))

// Scan for orphaned worktrees before accepting connections
await scanOrphans(snapshotService, sessionManager).catch((err) => {
  fastify.log.warn({ err }, 'orphan-scanner failed at startup')
})

// Resume turn-end watchers for sessions still in `running` state — otherwise
// a restart leaves them unable to auto-transition to `awaiting_input`.
await sessionManager.resumeWatchers().catch((err) => {
  fastify.log.warn({ err }, 'resume-watchers failed at startup')
})

// Wire the project resolver so wake-up (sleeping → spawning on sendInput)
// can look up the workspace path + defaults for the target session.
sessionManager.setProjectResolver(async (projectId) => {
  const p = await projectRegistry.get(projectId)
  return { path: p.path, defaultModel: p.defaultModel, defaultEffort: p.defaultEffort }
})

// Arm per-session idle timers + safety-net sweep — recovers from any state
// where a session sat idle beyond the threshold across a restart.
await sessionManager.resumeIdleSweepers().catch((err) => {
  fastify.log.warn({ err }, 'resume-idle-sweepers failed at startup')
})

try {
  await fastify.listen({ port: config.port, host: config.bindHost })
  fastify.log.info(
    `agent-hq-orchestron API listening on ${config.bindHost}:${config.port}`,
  )
  fastify.log.info(`Data dir: ${config.dataDir}`)
  fastify.log.info(`Remote auth: ${config.remoteToken ? 'enabled' : 'disabled'}`)
  await scheduler.start()
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
