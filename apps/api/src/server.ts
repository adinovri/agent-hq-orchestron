import Fastify from 'fastify'
import cors from '@fastify/cors'
import sensible from '@fastify/sensible'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

const DATA_DIR = process.env.AHQ_DATA_DIR ?? path.join(os.homedir(), '.config', 'agent-hq-orchestron')
const PORT = Number(process.env.AHQ_API_PORT ?? 8080)

const fastify = Fastify({
  logger: {
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
})

await fastify.register(cors, { origin: true })
await fastify.register(sensible)

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
    storage: DATA_DIR,
  }
})

// Stub routes — Phase 1 will implement these
fastify.get('/api/sessions', async () => ({ sessions: [] }))
fastify.get('/api/projects', async () => ({ projects: [] }))
fastify.get('/api/graph', async () => ({ nodes: [], edges: [] }))

try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' })
  fastify.log.info(`agent-hq-orchestron API running on port ${PORT}`)
  fastify.log.info(`Data dir: ${DATA_DIR}`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
