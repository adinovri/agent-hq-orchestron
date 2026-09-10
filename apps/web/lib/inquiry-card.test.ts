import { describe, it, expect } from 'vitest'
import type { Inquiry } from '@agent-hq-orchestron/shared'
import {
  resolveInquiryCard,
  inquiryKey,
  INQUIRY_ANSWER_GRACE_MS,
} from './inquiry-card'

/**
 * F6, from the 2026-09-10 E2E sweep: on submit the inquiry card **unmounted**
 * rather than switching to "Answer sent" and disabling. The server clears
 * `pendingInquiry`, the 3s session poll refreshes, the page's mount condition
 * goes false, and the card's own `submitted` flag never gets to render.
 *
 * The decision moved here so it can be tested — `apps/web` runs vitest on
 * `node`, so anything that needs asserting has to be a pure function in `lib/`
 * rather than a component behaviour.
 */

const INQUIRY: Inquiry = {
  message: 'Which environment should I deploy to?',
  fields: [{ name: 'env', label: 'Environment', type: 'choice', options: ['dev', 'stg'] }],
}

/** Same question, different object — what every poll hands back. */
const REPARSED: Inquiry = JSON.parse(JSON.stringify(INQUIRY))

const OTHER: Inquiry = {
  message: 'Should I also run the migrations?',
  fields: [{ name: 'migrate', label: 'Run migrations', type: 'boolean', options: null }],
}

const T0 = 1_757_500_000_000

describe('resolveInquiryCard', () => {
  it('renders an open form for an unanswered inquiry', () => {
    const state = resolveInquiryCard({ pending: INQUIRY, answered: null, readOnly: false, now: T0 })
    expect(state).toEqual({ inquiry: INQUIRY, answered: false })
  })

  it('renders nothing when there is no inquiry at all', () => {
    expect(resolveInquiryCard({ pending: null, answered: null, readOnly: false, now: T0 })).toBeNull()
    expect(resolveInquiryCard({ pending: undefined, answered: null, readOnly: false, now: T0 })).toBeNull()
  })

  it('renders nothing on a read-only session, answered or not', () => {
    expect(resolveInquiryCard({ pending: INQUIRY, answered: null, readOnly: true, now: T0 })).toBeNull()
    expect(
      resolveInquiryCard({
        pending: INQUIRY,
        answered: { inquiry: INQUIRY, at: T0 },
        readOnly: true,
        now: T0,
      }),
    ).toBeNull()
  })

  // ── The race itself ──────────────────────────────────────────────

  it('keeps the card up as "Answer sent" once the server clears the inquiry', () => {
    // This is the exact frame that used to unmount: submit landed, poll
    // refreshed, `pendingInquiry` is gone.
    const state = resolveInquiryCard({
      pending: null,
      answered: { inquiry: INQUIRY, at: T0 },
      readOnly: false,
      now: T0 + 1_000,
    })
    expect(state).toEqual({ inquiry: INQUIRY, answered: true })
  })

  it('holds that state for at least a second, and through the whole window', () => {
    for (const elapsed of [0, 1, 500, 1_000, INQUIRY_ANSWER_GRACE_MS - 1]) {
      const state = resolveInquiryCard({
        pending: null,
        answered: { inquiry: INQUIRY, at: T0 },
        readOnly: false,
        now: T0 + elapsed,
      })
      expect(state, `at +${elapsed}ms`).toEqual({ inquiry: INQUIRY, answered: true })
    }
  })

  it('lets the card go once the window has passed', () => {
    expect(
      resolveInquiryCard({
        pending: null,
        answered: { inquiry: INQUIRY, at: T0 },
        readOnly: false,
        now: T0 + INQUIRY_ANSWER_GRACE_MS,
      }),
    ).toBeNull()
  })

  it('shows "Answer sent" while the server has not caught up yet', () => {
    // Submit landed but the record still carries the inquiry. Matching on a
    // re-parsed object, not on reference, is what makes this work.
    const state = resolveInquiryCard({
      pending: REPARSED,
      answered: { inquiry: INQUIRY, at: T0 },
      readOnly: false,
      now: T0 + 100,
    })
    expect(state).toEqual({ inquiry: REPARSED, answered: true })
  })

  it('does not stay stuck on "Answer sent" if the server is slow past the window', () => {
    // Grace governs how long the card outlives the inquiry, not how long the
    // confirmation shows. While the record still holds it, the card stays
    // answered however long that takes.
    const state = resolveInquiryCard({
      pending: REPARSED,
      answered: { inquiry: INQUIRY, at: T0 },
      readOnly: false,
      now: T0 + 30_000,
    })
    expect(state).toEqual({ inquiry: REPARSED, answered: true })
  })

  it('reopens the form when the agent asks something different next turn', () => {
    const state = resolveInquiryCard({
      pending: OTHER,
      answered: { inquiry: INQUIRY, at: T0 },
      readOnly: false,
      now: T0 + 100,
    })
    expect(state).toEqual({ inquiry: OTHER, answered: false })
  })

  it('renders the answered snapshot, not a stale pending one', () => {
    // The snapshot is what the operator was looking at when they submitted.
    const state = resolveInquiryCard({
      pending: null,
      answered: { inquiry: OTHER, at: T0 },
      readOnly: false,
      now: T0 + 100,
    })
    expect(state?.inquiry.message).toBe(OTHER.message)
  })
})

describe('inquiryKey', () => {
  it('matches a re-parsed copy of the same question', () => {
    expect(inquiryKey(REPARSED)).toBe(inquiryKey(INQUIRY))
  })

  it('separates a different question', () => {
    expect(inquiryKey(OTHER)).not.toBe(inquiryKey(INQUIRY))
  })

  it('separates the same message asking for different fields', () => {
    const renamed: Inquiry = {
      message: INQUIRY.message,
      fields: [{ ...INQUIRY.fields[0]!, name: 'environment' }],
    }
    expect(inquiryKey(renamed)).not.toBe(inquiryKey(INQUIRY))
  })
})
