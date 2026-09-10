/**
 * Turning an id that arrived over the wire into a session route.
 *
 * Three flows navigate to a session they just created — Adopt, Import and
 * "Run now" — and Spawn is the fourth (it used to refetch the list and stay
 * put, which is what `NF6` in the post-batch-3 sweep caught against
 * `USAGE.md:115`). They read the id out of differently shaped bodies, so the
 * shared part is only the last step: validate, then build the path.
 *
 * Kept here as pure functions rather than inline in the mutation callbacks
 * because apps/web's vitest suite is node-only and covers `lib/`, not
 * component rendering.
 */

/**
 * `/session/<id>`, or `null` when the value cannot be trusted as a path
 * segment.
 *
 * Anything a session id never contains is refused rather than escaped: a
 * traversal or a query string smuggled into a `router.push()` is not a route
 * worth constructing at all. `null` means "stay where you are" — every caller
 * treats navigation as the bonus on top of an action that already succeeded.
 */
export function sessionHref(id: unknown): string | null {
  if (typeof id !== 'string') return null
  const trimmed = id.trim()
  if (!trimmed) return null
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null
  return `/session/${trimmed}`
}

/**
 * Where a successful spawn should leave the user.
 *
 * `POST /api/sessions` answers `201` with the whole session record, so the id
 * is on `id`. `null` on anything else — an older API, or a body that failed to
 * parse — leaves the dashboard doing what it did before: refresh the list.
 */
export function spawnedSessionHref(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  return sessionHref((body as { id?: unknown }).id)
}
