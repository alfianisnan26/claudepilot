// Chat content: serving what is in the blob store (chat-sessions PRD §13 "Rendering": files get a sniffed
// type and `nosniff`, non-images download, no SVG). One policy for every blob: a type on the inline allow-list
// (images, PDF, audio, video) is served as itself so a browser can show or play it, honouring `Range` so
// media can seek; everything else is `application/octet-stream` with `Content-Disposition: attachment`,
// whatever the file claims to be. A blob is only ever served to a session that links it.

import { closeSync, createReadStream, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { AppError } from '@isnanme/core';
import { CHAT_MAX_PREVIEW_BYTES, type ChatPreview, type ChatTextPreview } from '@portal/contracts';
import type { Store } from '../../store/store.js';
import { blobDir } from '../blobs.js';
import { redact } from '../redact.js';
import { dispositionHeader } from './names.js';
import { blobRow } from './records.js';
import { isInlineType } from './sniff.js';

/** A blob a session links, and where its bytes are. */
export interface BlobFile {
  blobId: string;
  /** The file in the blob store. */
  path: string;
  name: string | null;
  mediaType: string;
  size: number;
  preview: ChatPreview;
}

/** The blob a session links, or null (not its blob, or the file is gone: retention removed it). */
export function blobFileFor(store: Store, sessionId: string, blobId: string): BlobFile | null {
  const row = blobRow(store, sessionId, blobId);
  if (!row) return null;
  const path = join(blobDir(store), blobId);
  try {
    const st = statSync(path);
    if (!st.isFile()) return null;
    return { blobId, path, name: row.name, mediaType: row.mediaType, size: st.size, preview: row.preview };
  } catch {
    return null;
  }
}

/** A `Range` request header against a file of `size` bytes: one range, or why not. Null: no usable header (serve it whole). */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (m[1] === '' && m[2] === '')) return null; // not a single byte range: the whole file is a valid answer
  if (size === 0) return 'unsatisfiable';
  if (m[1] === '') {
    const last = Number(m[2]); // "the last N bytes"
    if (last === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (!Number.isSafeInteger(start) || start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

/** Headers every blob response carries. */
function baseHeaders(file: BlobFile): Headers {
  const h = new Headers();
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Accept-Ranges', 'bytes');
  // Content-addressed: the bytes behind an id never change.
  h.set('Cache-Control', 'private, max-age=31536000, immutable');
  h.set('ETag', `"${file.blobId}"`);
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  // Where the global policy doesn't replace it (it does in the built app), a blob that is opened directly still can't run anything.
  h.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  return h;
}

/**
 * The response for a blob: inline when its type is on the allow-list (and `download` isn't asked for),
 * an attachment otherwise; `Range` answered with 206, a conditional request with 304. Throws a 404 for no file.
 */
export function serveBlob(req: Request, file: BlobFile | null, opts: { download?: boolean } = {}): Response {
  if (!file) throw new AppError('NOT_FOUND', 'No such file.');
  const inline = !opts.download && isInlineType(file.mediaType);
  const headers = baseHeaders(file);
  headers.set('Content-Type', inline ? file.mediaType : 'application/octet-stream');
  // A name for what is saved or opened in a tab; an image shown in the page has no use for one.
  headers.set('Content-Disposition', inline ? (file.mediaType.startsWith('image/') ? 'inline' : dispositionHeader('inline', file.name ?? 'file')) : dispositionHeader('attachment', file.name ?? 'download'));
  if (file.mediaType === 'application/pdf') headers.delete('Content-Security-Policy'); // a sandboxed PDF isn't shown by the browser's viewer

  if (req.headers.get('if-none-match')?.split(',').some((t) => t.trim().replace(/^W\//, '') === `"${file.blobId}"`)) return new Response(null, { status: 304, headers });

  const range = parseRange(req.headers.get('range'), file.size);
  if (range === 'unsatisfiable') {
    headers.set('Content-Range', `bytes */${file.size}`);
    return new Response(null, { status: 416, headers });
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, file.size - 1);
  headers.set('Content-Length', String(file.size === 0 ? 0 : end - start + 1));
  if (range) headers.set('Content-Range', `bytes ${start}-${end}/${file.size}`);
  if (req.method === 'HEAD' || file.size === 0) return new Response(null, { status: range ? 206 : 200, headers });
  const body = Readable.toWeb(createReadStream(file.path, { start, end })) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, { status: range ? 206 : 200, headers });
}

/** Whether a blob can be read as text in a preview: text files, and the sources of HTML and SVG (shown as text, never rendered). */
export const isTextual = (file: BlobFile): boolean => file.preview === 'text' || file.mediaType.startsWith('text/') || file.mediaType === 'image/svg+xml' || file.mediaType === 'application/json' || file.mediaType === 'application/xml';

/** A text file's start, secrets hidden: at most {@link CHAT_MAX_PREVIEW_BYTES} bytes, cut at a character boundary. */
export function textPreview(file: BlobFile, scrub: (text: string) => string = redact): ChatTextPreview {
  if (!isTextual(file)) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'That file has no text preview.');
  const buf = Buffer.alloc(Math.min(file.size, CHAT_MAX_PREVIEW_BYTES));
  const n = readStart(file.path, buf);
  const truncated = file.size > CHAT_MAX_PREVIEW_BYTES;
  const raw = decodeText(buf.subarray(0, n), truncated);
  const text = scrub(raw);
  return { text, truncated, redacted: text !== raw };
}

/** Reads the start of a file into `buf` and returns how many bytes it got. */
function readStart(path: string, buf: Buffer): number {
  const fd = openSync(path, 'r');
  try {
    let total = 0;
    while (total < buf.length) {
      const n = readSync(fd, buf, total, buf.length - total, total);
      if (n === 0) break;
      total += n;
    }
    return total;
  } finally {
    closeSync(fd);
  }
}

/**
 * UTF-8 (a BOM dropped), or UTF-16 when it has its byte order mark; anything undecodable shows as the
 * replacement character. `cut`: the bytes are only the start of a longer file, so a character cut by
 * their end is left out rather than shown as a replacement.
 */
function decodeText(b: Buffer, cut: boolean): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2), { stream: cut });
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2), { stream: cut });
  return new TextDecoder('utf-8').decode(b, { stream: cut }).replace(/^\u{feff}/u, '');
}
