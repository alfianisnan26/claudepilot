// Chat sessions: images (chat-sessions PRD FR30, FR31, FR47; §9 `chat_files`). Attachments and tool
// images are checked here, then kept content-addressed under `<dataDir>/chat-blobs/<sha256>` (0700
// directory, 0600 files) and linked to a session by a `chat_files` row. A blob is only ever served to
// a session that links it. Event payloads carry the reference ({@link ChatImage}), never the base64.

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '@isnanme/core';
import { CHAT_IMAGE_TYPES, CHAT_MAX_IMAGE_BYTES, CHAT_MAX_IMAGES, type ChatImage, type ChatImageType } from '@portal/contracts';
import type { Store } from '../store/store.js';

/** Where a `chat_files` blob came from: you attached it, or a tool returned it. */
export type ChatFileKind = 'upload' | 'tool_image';

const BLOB_ID = /^[a-f0-9]{64}$/;

/** The blob directory under the portal's data directory. */
const blobDir = (store: Store): string => join(store.dataDir, 'chat-blobs');

/**
 * Stores `bytes` (once per content, whatever the session) and links them to the session. The file is
 * written whole under a temporary name and renamed, so a crash never leaves half a blob behind.
 */
export function saveBlob(store: Store, sessionId: string, kind: ChatFileKind, name: string | null, mediaType: string, bytes: Buffer): ChatImage {
  const db = store.db;
  if (!db || !store.writable) throw new Error('The chat store is read-only.');
  const blobId = createHash('sha256').update(bytes).digest('hex');
  const dir = blobDir(store);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // not ours to change (e.g. a mount); the files inside are still 0600
  }
  const file = join(dir, blobId);
  if (!existsSync(file)) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }
  db.prepare('INSERT INTO chat_files (session_id, kind, blob_sha256, name, size, media_type, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    sessionId,
    kind,
    blobId,
    name,
    bytes.length,
    mediaType,
    new Date().toISOString(),
  );
  const image: ChatImage = { blobId, mediaType };
  if (name) image.name = name;
  return image;
}

/** A blob's bytes and type — only when a `chat_files` row links it to this session; else null. */
export function readBlob(store: Store, sessionId: string, blobId: string): { bytes: Buffer<ArrayBuffer>; mediaType: string } | null {
  if (typeof blobId !== 'string' || !BLOB_ID.test(blobId)) return null;
  const db = store.db;
  if (!db) return null;
  const row = db.prepare('SELECT media_type FROM chat_files WHERE session_id = ? AND blob_sha256 = ? ORDER BY id DESC LIMIT 1').get(sessionId, blobId) as
    | { media_type: string | null }
    | undefined;
  if (!row) return null;
  let bytes: Buffer<ArrayBuffer>;
  try {
    bytes = readFileSync(join(blobDir(store), blobId));
  } catch {
    return null;
  }
  // Only the image types we accept are served as such; anything else is plain bytes.
  return { bytes, mediaType: isChatImageType(row.media_type) ? row.media_type : 'application/octet-stream' };
}

/* ---------- Checking images ---------- */

const isChatImageType = (v: unknown): v is ChatImageType => typeof v === 'string' && (CHAT_IMAGE_TYPES as readonly string[]).includes(v);

const LABELS: Record<ChatImageType, string> = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP' };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Whether the bytes start the way that image type does (so the API won't refuse it mid-turn). */
function looksLike(bytes: Buffer, mediaType: ChatImageType): boolean {
  switch (mediaType) {
    case 'image/png':
      return bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG);
    case 'image/jpeg':
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/gif': {
      const head = bytes.toString('latin1', 0, 6);
      return head === 'GIF87a' || head === 'GIF89a';
    }
    case 'image/webp':
      return bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP';
  }
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The decoded size of strict, padded base64 (no whitespace), or null when it isn't that. */
function base64Size(data: string): number | null {
  if (!data || data.length % 4 !== 0 || !BASE64.test(data)) return null;
  return (data.length / 4) * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}

/** One attachment, checked and decoded; `dataBase64` is kept to write the user line, never stored. */
export interface DecodedImage {
  name: string | null;
  mediaType: ChatImageType;
  dataBase64: string;
  bytes: Buffer;
}

/** A display name: no control characters, at most 200 characters; null when nothing is left. */
function cleanName(v: unknown): string | null {
  // eslint-disable-next-line no-control-regex
  const name = typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 200) : '';
  return name || null;
}

const invalid = (message: string) => new AppError('VALIDATION_FAILED', message, { details: { attachments: message } });

/**
 * Checks a message's attachments (at most {@link CHAT_MAX_IMAGES}; PNG, JPEG, GIF or WebP; valid base64;
 * at most {@link CHAT_MAX_IMAGE_BYTES} each, decoded) and decodes them. Throws a friendly validation
 * error naming the first image that fails.
 */
export function decodeAttachments(list: unknown): DecodedImage[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw invalid('Attachments must be a list of images.');
  if (list.length > CHAT_MAX_IMAGES) throw invalid(`Attach at most ${CHAT_MAX_IMAGES} images to one message.`);
  return list.map((raw, i) => {
    const a = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const name = cleanName(a.name);
    const label = `“${name ?? `Image ${i + 1}`}”`;
    const mediaType = a.mediaType;
    if (!isChatImageType(mediaType)) throw invalid(`${label} isn't a supported image. Use PNG, JPEG, GIF or WebP.`);
    const dataBase64 = typeof a.dataBase64 === 'string' ? a.dataBase64 : '';
    const size = base64Size(dataBase64);
    if (!size) throw invalid(`${label} couldn't be read. Attach it again.`);
    if (size > CHAT_MAX_IMAGE_BYTES) throw invalid(`${label} is too large. Images can be up to ${CHAT_MAX_IMAGE_BYTES / 1_000_000} MB.`);
    const bytes = Buffer.from(dataBase64, 'base64');
    if (!looksLike(bytes, mediaType)) throw invalid(`${label} isn't a valid ${LABELS[mediaType]} image.`);
    return { name, mediaType, dataBase64, bytes };
  });
}

/** Tool images bigger than this (decoded) are left out of the transcript. */
const MAX_TOOL_IMAGE_BYTES = 10 * 1024 * 1024;

/** A tool's base64 image decoded, or null when it isn't an accepted, well-formed image of a sane size. */
export function decodeToolImage(mediaType: string, dataBase64: string): { mediaType: ChatImageType; bytes: Buffer } | null {
  if (!isChatImageType(mediaType)) return null;
  const size = base64Size(dataBase64);
  if (!size || size > MAX_TOOL_IMAGE_BYTES) return null;
  const bytes = Buffer.from(dataBase64, 'base64');
  return looksLike(bytes, mediaType) ? { mediaType, bytes } : null;
}
