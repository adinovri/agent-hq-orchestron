import Fastify from 'fastify'
import cors from '@fastify/cors'
import sensible from '@fastify/sensible'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  loadConfig,
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

const execFileAsync = promisify(execFile)

let config: Config
try {
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

const sessionManager = new SessionManager({ dataDir: config.dataDir, maxConcurrent: config.maxConcurrent }, registry)
const snapshotService = new SnapshotService(config.dataDir)
const metricsCollector = new MetricsCollector(config.dataDir)
const projectRegistry = new ProjectRegistry(config.dataDir)
const delegationTracker = new DelegationTracker(config.dataDir)
const hookRunner = new HookRunner({ dataDir: config.dataDir })
const templateResolver = new TemplateResolver(config.dataDir)
const scheduler = new Scheduler(config.dataDir, `http://${config.bindHost === '0.0.0.0' ? '127.0.0.1' : config.bindHost}:${config.port}`)

const fastify = Fastify({
  logger: {
    level: config.logLevel,
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
})

await fastify.register(cors, { origin: true })
await fastify.register(sensible)
await fastify.register(authPlugin, { config })

fastify.get('/api/health', async () => {
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
  }
})

await fastify.register(projectsPlugin(projectRegistry))
await fastify.register(sessionsPlugin(sessionManager, hookRunner, templateResolver, delegationTracker, projectRegistry))
await fastify.register(delegationPlugin(delegationTracker, sessionManager))
await fastify.register(streamPlugin(sessionManager, config.dataDir))
await fastify.register(metricsPlugin(metricsCollector))
await fastify.register(schedulesPlugin(scheduler))

// Scan for orphaned worktrees before accepting connections
await scanOrphans(snapshotService, sessionManager).catch((err) => {
  fastify.log.warn({ err }, 'orphan-scanner failed at startup')
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
