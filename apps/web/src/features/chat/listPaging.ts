// The session list's paging rules (D-58, T-382 S2 fix), as pure functions so they can be tested without React.

/**
 * The older pages loaded with "Older" may stay under a refreshed first page only when nothing moved at the seam: the first page's `next`
 * cursor names its last row, so the same cursor before and after means the same last row, and the older pages still start right after it.
 * Any other cursor (a session arrived and pushed a row off the page, or one left) leaves a row in neither list, and the older rows may be
 * stale: drop them, and "Older" loads them again from the new seam.
 */
export function keepsOlder(prevNext: string | null | undefined, nextNext: string | null): boolean {
  return prevNext !== undefined && prevNext === nextNext;
}

/** A refused cursor (a 400: it expired with a server restart, or it was made for another list): the list starts again from page 1. */
export function cursorExpired(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { status?: unknown }).status === 400;
}
