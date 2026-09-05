import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import websocketPlugin from '@fastify/websocket'
import type { WebSocket } from 'ws'
import { SessionManager } from '../domain/session-manager.js'
import { TranscriptTailer } from '../streaming/transcript-tailer.js'

// Short ping keeps mobile-cellular connections alive — many carriers drop
// idle TCP after 20-30s without traffic.
const SSE_PING_MS = 10_000

export function streamPlugin(manager: SessionManager, dataDir: string) {
  return fp(async (app: FastifyInstance) => {
    await app.register(websocketPlugin)

    // SSE: GET /api/sessions/:uuid/stream
    app.get('/api/sessions/:uuid/stream', async (req, reply) => {
      const { uuid } = req.params as { uuid: string }

      const sessions = await manager.list()
      const session = sessions.find(s => s.id === uuid)
      if (!session) {
        return reply.code(404).send({ error: `Session not found: ${uuid}` })
      }

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      reply.raw.flushHeaders?.()

      const send = (event: string, data: unknown) => {
        if (reply.raw.destroyed) return
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      // Replay full transcript from beginning on each new SSE connection.
      // The persisted offset mechanism is for tailer restart resilience,
      // not for consumer view — UI first-load needs the whole history.
      const tailer = new TranscriptTailer(uuid, session.jsonlPath, dataDir, {
        startOffset: 0,
        persistOffset: false,
      })
      tailer.on('event', (ev: { type: string; event: unknown }) => send(ev.type, ev.event))

      const pingTimer = setInterval(() => {
        if (reply.raw.destroyed) { tailer.close(); clearInterval(pingTimer); return }
        reply.raw.write(': ping\n\n')
      }, SSE_PING_MS)

      const cleanup = () => { tailer.close(); clearInterval(pingTimer) }
      req.socket?.on('close', cleanup)
      req.raw.on('close', cleanup)

      await tailer.start()

      await new Promise<void>(resolve => {
        req.raw.on('close', resolve)
        req.socket?.on('close', resolve)
      })
    })

    // WebSocket: WS /api/sessions/:uuid/socket
    app.get('/api/sessions/:uuid/socket', { websocket: true }, async (socket: WebSocket, req) => {
      const { uuid } = (req as unknown as { params: { uuid: string } }).params

      const sessions = await manager.list()
      const session = sessions.find(s => s.id === uuid)
      if (!session) {
        socket.close(1008, `Session not found: ${uuid}`)
        return
      }

      const tailer = new TranscriptTailer(uuid, session.jsonlPath, dataDir)

      tailer.on('event', (ev: { type: string; event: unknown }) => {
        if (socket.readyState === 1 /* OPEN */) {
          socket.send(JSON.stringify(ev))
        }
      })

      socket.on('message', (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString()) as { type?: string; prompt?: string }
          if (msg.type === 'prompt' && msg.prompt) {
            socket.send(JSON.stringify({ type: 'ack', sessionUuid: uuid }))
          }
        } catch {
          // ignore malformed messages
        }
      })

      const cleanup = () => tailer.close()
      socket.on('close', cleanup)
      socket.on('error', cleanup)

      await tailer.start()
    })
  })
}
