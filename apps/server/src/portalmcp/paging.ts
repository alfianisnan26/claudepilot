import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { PortalToolError } from './registry.js';

// Paged lists over MCP (portal-mcp PRD FR9): `cursor` and `limit` (default 25, at most 100). A cursor is
// HMAC-signed, bound to the filter it was issued for, and expires after an hour, so a model can't forge one
// or carry one across a different query. The key lives in memory: a restart ends every cursor, and clients
// just list again.

export const PAGE_DEFAULT = 25;
export const PAGE_MAX = 100;
const CURSOR_TTL_MS = 60 * 60_000;

/** The two fields every list tool takes. Spread into the tool's `input`: `z.object({ ...pageInput, query: … })`. */
export const pageInput = {
  cursor: z.string().max(400).optional().describe('From the previous page’s `next_cursor`.'),
  limit: z.number().int().min(1).max(PAGE_MAX).optional().describe(`Items per page (default ${PAGE_DEFAULT}, at most ${PAGE_MAX}).`),
};

export interface Page<T> {
  items: T[];
  /** Pass as `cursor` for the next page; null on the last. */
  next_cursor: string | null;
  total: number;
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');

export class Cursors {
  constructor(
    private readonly key: Buffer = randomBytes(32),
    private readonly now: () => number = Date.now,
  ) {}

  #mac(body: string): string {
    return createHmac('sha256', this.key).update(body).digest('base64url');
  }

  encode(offset: number, filterKey: string): string {
    const body = b64(JSON.stringify({ o: offset, f: filterKey, e: this.now() + CURSOR_TTL_MS }));
    return `${body}.${this.#mac(body)}`;
  }

  /** The offset a cursor stands for. Throws INVALID_CURSOR for a forged, expired or other-filter cursor. */
  decode(cursor: string, filterKey: string): number {
    const [body, mac] = cursor.split('.');
    const bad = () => new PortalToolError('INVALID_CURSOR', 'That cursor is not valid for this query (it may have expired). List again without a cursor.');
    if (!body || !mac) throw bad();
    const want = Buffer.from(this.#mac(body));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) throw bad();
    try {
      const v = JSON.parse(Buffer.from(body, 'base64url').toString()) as { o?: unknown; f?: unknown; e?: unknown };
      if (typeof v.o !== 'number' || v.f !== filterKey || typeof v.e !== 'number' || v.e < this.now()) throw bad();
      return Math.max(0, Math.trunc(v.o));
    } catch (e) {
      throw e instanceof PortalToolError ? e : bad();
    }
  }
}

/** The portal's cursors. */
export const cursors = new Cursors();

/** One page of an in-memory list, in order. `filter` is whatever the query depends on besides the page (it binds the cursor). */
export function paginate<T>(items: T[], args: { cursor?: string | undefined; limit?: number | undefined }, filter: unknown = ''): Page<T> {
  const key = JSON.stringify(filter);
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? PAGE_DEFAULT), 1), PAGE_MAX);
  const offset = args.cursor ? cursors.decode(args.cursor, key) : 0;
  const slice = items.slice(offset, offset + limit);
  const end = offset + slice.length;
  return { items: slice, next_cursor: end < items.length ? cursors.encode(end, key) : null, total: items.length };
}

/** For lists read from the database a page at a time: the offset a cursor means, and the cursor for the next page. */
export function pageWindow(args: { cursor?: string | undefined; limit?: number | undefined }, filter: unknown = '') {
  const key = JSON.stringify(filter);
  const limit = Math.min(Math.max(Math.trunc(args.limit ?? PAGE_DEFAULT), 1), PAGE_MAX);
  const offset = args.cursor ? cursors.decode(args.cursor, key) : 0;
  return { limit, offset, next: (returned: number, total: number) => (offset + returned < total ? cursors.encode(offset + returned, key) : null) };
}
