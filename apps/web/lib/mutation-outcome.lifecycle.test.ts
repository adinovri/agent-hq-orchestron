import { describe, it, expect } from 'vitest'
import { closeButtonGuard, CLOSE_BLOCKED_TITLE, createDialogDismiss } from './dialog-dismiss'
import { throwIfNotOk, mutationErrorMessage } from './api-error'

/**
 * NF26 and NF27, over the sequence the components actually run.
 *
 * The two findings are the two halves of one confusion — a dialog that does
 * not say what it is doing:
 *
 *   • NF26: the × mid-mutation is refused silently. Nothing dims, nothing
 *     says why, so a refused click is indistinguishable from a missed one.
 *   • NF27: the Kill mutation had no `res.ok` check and closed its dialog from
 *     `onSettled`, which runs on both outcomes. A 500 therefore closed the
 *     dialog exactly like a 200 and left the session running.
 *
 * The unit tests below each hand a hard-coded value to one function. What they
 * cannot catch is the wiring: a dialog that computes `closeButton` from a
 * different expression than its dismissal handlers, or a mutation whose close
 * lives in the branch that runs either way. So this drives a whole attempt —
 * submit, in-flight dismissal, HTTP outcome, settle — and asserts on what the
 * operator can see at each step.
 */

/** The `Response` slice the check needs. No DOM, no fetch. */
function response(status: number, body = ''): Response {
  return { ok: status < 400, status, text: async () => body } as unknown as Response
}

/**
 * A dialog over one mutation, with the DOM taken out.
 *
 * Mirrors the real component: `enabled` is recomputed on every interaction
 * rather than captured once, `closeButton` comes off the same handlers object
 * as `onCloseButtonClick` (so the look cannot disagree with the behaviour),
 * and closing happens in the success branch only.
 */
function Dialog(opts: { send: () => Promise<Response> }) {
  let open = true
  let pending = false
  let error: string | null = null

  const close = () => { open = false }
  const handlers = () => createDialogDismiss(open && !pending, close)

  return {
    get open() { return open },
    get error() { return error },
    /** What the × renders as right now. */
    get closeButton() { return handlers().closeButton },
    async submit() {
      pending = true
      error = null           // onMutate: a retry starts clean
      try {
        await throwIfNotOk(await opts.send())
        close()              // onSuccess — and nowhere else
      } catch (err) {
        error = mutationErrorMessage(err)   // onError
      } finally {
        pending = false      // onSettled: true either way, so only this lives here
      }
    },
    clickCloseButton() { handlers().onCloseButtonClick() },
  }
}

describe('a Kill that fails (NF27)', () => {
  it('keeps the dialog open and says why', async () => {
    // The exact scenario: the API answers 500, and before this the dialog
    // closed anyway — indistinguishable from a session that was killed.
    const d = Dialog({
      send: async () => response(500, '{"statusCode":500,"error":"Internal Server Error","message":"tmux: no server running"}'),
    })
    await d.submit()

    expect(d.open).toBe(true)
    expect(d.error).toBe('HTTP 500: tmux: no server running')
  })

  it('shows a refusal in the API\'s own words', async () => {
    // 409 from `archive` / `deleteRecord`: `{ error }`, the whole message.
    const d = Dialog({ send: async () => response(409, '{"error":"Cannot delete a running session"}') })
    await d.submit()

    expect(d.open).toBe(true)
    expect(d.error).toBe('HTTP 409: Cannot delete a running session')
  })

  it('survives a network failure with no response at all', async () => {
    const d = Dialog({ send: async () => { throw new TypeError('Failed to fetch') } })
    await d.submit()

    expect(d.open).toBe(true)
    expect(d.error).toBe('Failed to fetch')
  })

  it('clears the previous failure when the retry succeeds', async () => {
    let status = 500
    const d = Dialog({ send: async () => response(status, '{"error":"busy"}') })

    await d.submit()
    expect(d.open).toBe(true)

    status = 200
    await d.submit()
    expect(d.open).toBe(false)
    expect(d.error).toBeNull()
  })
})

describe('a Kill that succeeds', () => {
  it('closes the dialog, leaving nothing on screen', async () => {
    // The negative control. Without it every assertion above is satisfied by
    // a dialog that simply never closes — which is its own bug.
    const d = Dialog({ send: async () => response(200, '{}') })
    await d.submit()

    expect(d.open).toBe(false)
    expect(d.error).toBeNull()
  })

  it('closes on a 204 with no body', async () => {
    const d = Dialog({ send: async () => response(204) })
    await d.submit()
    expect(d.open).toBe(false)
  })
})

describe('the × while the mutation is in flight (NF26)', () => {
  it('renders disabled, with a tooltip saying to wait', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const d = Dialog({ send: async () => { await held; return response(200) } })

    expect(d.closeButton).toEqual({ disabled: false })   // control: lit when idle

    const submitted = d.submit()
    expect(d.closeButton.disabled).toBe(true)
    expect(d.closeButton.title).toBe(CLOSE_BLOCKED_TITLE)

    // And the click it would have taken is still refused — the visual state
    // is an explanation of the guard, not a replacement for it.
    d.clickCloseButton()
    expect(d.open).toBe(true)

    release()
    await submitted
  })

  it('goes back to lit once a failed mutation settles', async () => {
    // The dialog stays open on failure, so the × has to work again — a
    // permanently dead close button would trap the operator in the dialog.
    const d = Dialog({ send: async () => response(500, '{"error":"nope"}') })
    await d.submit()

    expect(d.open).toBe(true)
    expect(d.closeButton).toEqual({ disabled: false })
    d.clickCloseButton()
    expect(d.open).toBe(false)
  })
})

describe('closeButtonGuard', () => {
  it('omits the tooltip when the × is live', () => {
    // An always-on "Close" tooltip on a button already labelled Close is the
    // same word read twice.
    expect(closeButtonGuard(true)).toEqual({ disabled: false })
  })

  it('carries both halves when blocked', () => {
    expect(closeButtonGuard(false)).toEqual({ disabled: true, title: CLOSE_BLOCKED_TITLE })
  })

  it('says what to do, not what broke', () => {
    // Nothing has failed at this point — a request is simply still running.
    expect(CLOSE_BLOCKED_TITLE).toMatch(/wait/i)
  })
})
