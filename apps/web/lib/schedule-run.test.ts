import { describe, it, expect } from 'vitest'
import { scheduleRunHref } from './schedule-run'

/**
 * The whole point of pulling this out of the mutation callback: the "where do
 * we send the user" decision is testable without a DOM. `null` means the page
 * keeps its pre-redirect behaviour — stay on the list, refresh it.
 */

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

describe('scheduleRunHref', () => {
  it('points at the session the run spawned', () => {
    expect(scheduleRunHref({ ok: true, sessionUuid: UUID })).toBe(`/session/${UUID}`)
  })

  it('trims incidental whitespace off the id', () => {
    expect(scheduleRunHref({ ok: true, sessionUuid: `  ${UUID}\n` })).toBe(`/session/${UUID}`)
  })

  it('stays put for an older API that only says ok', () => {
    expect(scheduleRunHref({ ok: true })).toBeNull()
  })

  it('stays put when the body could not be parsed at all', () => {
    expect(scheduleRunHref(null)).toBeNull()
    expect(scheduleRunHref(undefined)).toBeNull()
  })

  it('stays put for a non-object body', () => {
    expect(scheduleRunHref('ok')).toBeNull()
    expect(scheduleRunHref(201)).toBeNull()
  })

  it('never builds /session/undefined out of a non-string id', () => {
    expect(scheduleRunHref({ sessionUuid: undefined })).toBeNull()
    expect(scheduleRunHref({ sessionUuid: null })).toBeNull()
    expect(scheduleRunHref({ sessionUuid: 42 })).toBeNull()
    expect(scheduleRunHref({ sessionUuid: { id: UUID } })).toBeNull()
    expect(scheduleRunHref({ sessionUuid: '   ' })).toBeNull()
  })

  it('refuses an id that would escape the path segment', () => {
    expect(scheduleRunHref({ sessionUuid: '../settings' })).toBeNull()
    expect(scheduleRunHref({ sessionUuid: `${UUID}/edit` })).toBeNull()
    expect(scheduleRunHref({ sessionUuid: `${UUID}?x=1` })).toBeNull()
    expect(scheduleRunHref({ sessionUuid: '//evil.example.com' })).toBeNull()
  })
})
