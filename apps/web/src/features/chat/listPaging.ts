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

interface PageLike<T> {
  items: T[];
  next: string | null;
}

/** What a failed "older" load means: start again from page 1, let a tap try again, or nothing (the list moved on while it ran). */
export type MoreFailure = 'restart' | 'retry' | 'stale';

/**
 * The state of a paged list as plain data, so the hooks (the Sessions list, the CI runs list) stay thin and every rule is testable without React:
 * the first page and the older pages under it, the seam rule (`keepsOlder`) and a generation counter. A "load more" that started before the older
 * pages were dropped (a poll moved the seam, a filter changed, a restart) carries the old generation, and its page is refused when it lands.
 */
export class ListPager<T extends { id: string }> {
  head: PageLike<T> | null = null;
  older: PageLike<T> | null = null;
  private headNext: string | null | undefined = undefined;
  private gen = 0;

  /** A poll or a first load brought page 1. The older pages stay only while the seam under it holds. */
  applyHead(page: PageLike<T>): void {
    if (!keepsOlder(this.headNext, page.next)) this.dropOlder();
    this.headNext = page.next;
    this.head = page;
  }

  /** The filter changed, or the cursor expired: forget the seam and the older pages (the next head starts clean). */
  restart(): void {
    this.headNext = undefined;
    this.dropOlder();
  }

  private dropOlder(): void {
    this.older = null;
    this.gen += 1;
  }

  /** The cursor the next "load more" sends, or null at the end. */
  get next(): string | null {
    return this.older ? this.older.next : (this.head?.next ?? null);
  }

  /** Starts a "load more": a ticket to hand back with the page or the error. */
  beginMore(): { cursor: string; gen: number } | null {
    const cursor = this.next;
    return cursor ? { cursor, gen: this.gen } : null;
  }

  /** The older page landed. False when the older pages were dropped meanwhile: the page is stale and is not appended. */
  finishMore(ticket: { gen: number }, page: PageLike<T>): boolean {
    if (ticket.gen !== this.gen) return false;
    this.older = { items: [...(this.older?.items ?? []), ...page.items], next: page.next };
    return true;
  }

  failMore(ticket: { gen: number }, e: unknown): MoreFailure {
    if (ticket.gen !== this.gen) return 'stale';
    return cursorExpired(e) ? 'restart' : 'retry';
  }

  /** The rows to show: page 1, then the older rows it does not already hold. */
  get items(): T[] | null {
    if (!this.head) return null;
    const seen = new Set(this.head.items.map((s) => s.id));
    return [...this.head.items, ...(this.older?.items ?? []).filter((s) => !seen.has(s.id))];
  }
}
