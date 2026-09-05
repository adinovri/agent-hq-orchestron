import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import { z } from 'zod'
import { NotesStore } from '../domain/notes-store.js'

const SetNoteSchema = z.object({
  value: z.unknown(),
  updatedBy: z.string().optional(),
  tags: z.array(z.string()).optional(),
})

export function notesPlugin(store: NotesStore) {
  return fp(async (app: FastifyInstance) => {
    // List all notes (or by prefix)
    app.get('/api/notes', async (req) => {
      const q = req.query as Record<string, string>
      const prefix = q['prefix']
      const notes = await store.list(prefix)
      return { notes }
    })

    // Get single note
    app.get('/api/notes/:key', async (req, reply) => {
      const { key } = req.params as { key: string }
      try {
        const note = await store.get(key)
        if (!note) return reply.code(404).send({ error: `Note not found: ${key}` })
        return note
      } catch (err: unknown) {
        return reply.code(400).send({ error: (err as Error).message })
      }
    })

    // Set/upsert note
    app.put('/api/notes/:key', async (req, reply) => {
      const { key } = req.params as { key: string }
      const body = SetNoteSchema.safeParse(req.body)
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })
      try {
        const note = await store.set({
          key,
          value: body.data.value,
          updatedBy: body.data.updatedBy,
          tags: body.data.tags,
        })
        return note
      } catch (err: unknown) {
        return reply.code(400).send({ error: (err as Error).message })
      }
    })

    // Delete note
    app.delete('/api/notes/:key', async (req, reply) => {
      const { key } = req.params as { key: string }
      await store.delete(key)
      return reply.code(204).send()
    })
  })
}
