import { describe, it, expect } from 'vitest'
import { sessionHref, spawnedSessionHref } from './session-href'

/**
 * The navigation decision for Spawn (NF6) lives here rather than in the
 * dialog's callback for exactly this reason: it is testable without a DOM.
 * `null` always means "stay put" — the spawn itself already succeeded.
 */

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

describe('sessionHref', () => {
  it('builds the session route from a plain id', () => {
    expect(sessionHref(UUID)).toBe(`/session/${UUID}`)
  })

  it('trims surrounding whitespace', () => {
    expect(sessionHref(`  ${UUID}\n`)).toBe(`/session/${UUID}`)
  })

  it('refuses anything that is not a string', () => {
    expect(sessionHref(undefined)).toBeNull()
    expect(sessionHref(null)).toBeNull()
    expect(sessionHref(42)).toBeNull()
    expect(sessionHref({ id: UUID })).toBeNull()
  })

  it('refuses an empty or whitespace-only id', () => {
    expect(sessionHref('')).toBeNull()
    expect(sessionHref('   ')).toBeNull()
  })

  it('refuses a value that would smuggle a different route', () => {
    expect(sessionHref('../projects')).toBeNull()
    expect(sessionHref(`${UUID}?next=/admin`)).toBeNull()
    expect(sessionHref(`${UUID}/edit`)).toBeNull()
    expect(sessionHref('https://evil.example/x')).toBeNull()
  })
})

describe('spawnedSessionHref', () => {
  it('navigates to the session in a 201 body', () => {
    // The shape POST /api/sessions actually returns: the whole record.
    const body = { id: UUID, status: 'spawning', projectId: 'p1', agentType: 'claude' }
    expect(spawnedSessionHref(body)).toBe(`/session/${UUID}`)
  })

  it('stays put when the body could not be parsed', () => {
    // SpawnDialog hands on `null` rather than throwing — the session exists.
    expect(spawnedSessionHref(null)).toBeNull()
    expect(spawnedSessionHref(undefined)).toBeNull()
    expect(spawnedSessionHref('created')).toBeNull()
  })

  it('stays put when an older API answers without an id', () => {
    expect(spawnedSessionHref({ ok: true })).toBeNull()
    expect(spawnedSessionHref({ id: null })).toBeNull()
  })

  it('does not confuse the schedule shape for a session record', () => {
    // `sessionUuid` is the "Run now" field; a spawn body uses `id`.
    expect(spawnedSessionHref({ sessionUuid: UUID })).toBeNull()
  })
})
