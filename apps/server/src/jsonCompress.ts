// JSON answers of the API gzip-compressed when the client accepts gzip (T-376: a long transcript was 12.3 MiB on the wire uncompressed).
// Scoped to `application/json` by content type, so a stream (`text/event-stream`), a WebSocket upgrade, a blob or a download is never
// touched: a compressed event stream is buffered by the compressor and arrives late. Small answers (under Hono's 1 KiB threshold), ranges
// (206), HEAD and answers already encoded pass as they are.

import { compress } from 'hono/compress';
import type { MiddlewareHandler } from 'hono';

/** Content types that are compressed: JSON and nothing else. */
export const COMPRESSED_TYPE = /^\s*application\/json\s*(?:;|$)/i;

/** The middleware for `/api/*` (app.ts). */
export function jsonCompress(): MiddlewareHandler {
  return compress({ encoding: 'gzip', contentTypeFilter: COMPRESSED_TYPE });
}
