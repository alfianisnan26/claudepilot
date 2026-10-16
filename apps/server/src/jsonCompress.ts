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

/** The built app's text files: scripts, styles, SVG and JSON (images and fonts are already compressed). */
export const ASSET_TYPE = /^\s*(?:text\/(?:javascript|css)|application\/(?:javascript|json)|image\/svg\+xml)\s*(?:;|$)/i;

/**
 * The middleware for `/assets/*` (app.ts, T-376 S3): the main bundle was 1.27 MB on the wire, uncompressed, on every first open of the app.
 * Files are immutable and cached for a year, so the compressor runs once per client.
 */
export function assetCompress(): MiddlewareHandler {
  const inner = compress({ encoding: 'gzip', contentTypeFilter: ASSET_TYPE });
  return async (c, next) => {
    await inner(c, next);
    // A cache must key the file by the client's Accept-Encoding (a year-long immutable copy): Vary is set here whatever Hono does, once.
    const vary = c.res.headers.get('vary') ?? '';
    if (c.res.headers.get('content-encoding') && !/accept-encoding|\*/i.test(vary)) c.res.headers.set('Vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
  };
}
