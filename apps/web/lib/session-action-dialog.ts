import type { EffortLevel } from '@agent-hq-orchestron/shared'

export type SessionActionKind = 'reopen' | 'fork' | 'respawn'

export interface SessionActionOpts {
  model?: string
  effort?: EffortLevel
  prompt?: string
  useTmux?: boolean
}

/** One runner per action — in the page, the three mutations' `.mutate`. */
export type SessionActionRunners = Record<
  SessionActionKind,
  (opts: SessionActionOpts) => void
>

/**
 * Confirm a session lifecycle action.
 *
 * NF24. The page used to do this inline, and the first thing it did was close
 * the dialog:
 *
 *     const action = actionDialog
 *     setActionDialog(null)        // dialog unmounts here
 *     if (action === 'reopen') reopenMutation.mutate({ … })
 *
 * The dialog was therefore gone before `pending` could ever become true, which
 * made three things unreachable at once: the `Reopen…` label on the confirm
 * button, `disabled={pending}` on every control, and the `!pending` in
 * `useDialogDismiss(open && !pending, onClose)` — a clause written to stop
 * Escape dismissing a dialog mid-write, guarding a window that did not exist.
 * Measured with the reopen POST held open for 8s: the dialog was gone at 1.5s.
 *
 * Nothing broke because of it — the mutation still ran and the action still
 * completed. What was wrong is that the batch-11 PR claimed all three guarded
 * callers held the dialog open while a mutation was in flight, and this one
 * did not, so a reader trusting that sentence would believe in a window that
 * was never there. Metadata Edit and Delete Record close from the mutation's
 * `onSuccess`; this now does the same.
 *
 * Deliberately does **not** close. Closing is `settleSessionAction`'s job, and
 * splitting them is the whole point: the two must not be reachable from the
 * same callback again.
 */
export function confirmSessionAction(
  kind: SessionActionKind | null,
  opts: SessionActionOpts,
  run: SessionActionRunners,
): void {
  if (!kind) return
  run[kind](opts)
}

/**
 * Close the dialog once the mutation has settled — on success only.
 *
 * A failed action leaves it open, which is what the siblings do: the form
 * still holds what was typed, so the operator can retry without rebuilding it.
 *
 * That "nothing said about why" this used to note as an inherited gap is
 * closed (NF27): each of the three mutations now has an `onError` that puts
 * the API's own message in the dialog's `error` prop, next to the button the
 * operator is about to press again. Calling this with `'error'` stays part of
 * that path — it is how the caller says "settled, do not close" in the same
 * breath as setting the message, rather than by omitting a branch.
 */
export function settleSessionAction(
  outcome: 'success' | 'error',
  close: () => void,
): void {
  if (outcome === 'success') close()
}
