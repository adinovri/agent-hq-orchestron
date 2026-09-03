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

// Stub routes — will be replaced by TASK-016..018
fastify.get('/api/sessions', async () => ({ sessions: [] }))
fastify.get('/api/projects', async () => ({ projects: [] }))
fastify.get('/api/graph', async () => ({ nodes: [], edges: [] }))

try {
  await fastify.listen({ port: config.port, host: config.bindHost })
  fastify.log.info(
    `agent-hq-orchestron API listening on ${config.bindHost}:${config.port}`,
  )
  fastify.log.info(`Data dir: ${config.dataDir}`)
  fastify.log.info(`Remote auth: ${config.remoteToken ? 'enabled' : 'disabled'}`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
