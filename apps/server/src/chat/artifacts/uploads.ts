// Chat content: files you attach (chat-sessions PRD FR30, FR31). A file is uploaded on its own, ahead of
// the message it goes with: it is streamed into the blob store (never held whole in memory), hashed and
// sniffed, and waits as a `chat_uploads` row under an id the composer sends back with the message. That
// keeps big files off the chat socket, gives the composer progress and a way to cancel, and lets a refused
// file say why while the person is still choosing. What the person sent is only a hint: the type is the
// sniffed one, the name is made safe.

import { randomBytes } from 'node:crypto';
import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '@isnanme/core';
import { CHAT_MAX_UPLOAD_BYTES, type ChatFile, type ChatUpload } from '@portal/contracts';
import type { Store } from '../../store/store.js';
import { adoptBlob, blobDir, BLOB_ID, pruneBlobs } from '../blobs.js';
import { displayName, extensionOf } from './names.js';
import { assertRoom, MAX_PENDING_UPLOADS, UPLOAD_TTL_MS } from './quota.js';
import { intakeStream } from './intake.js';
import { fileRef } from './records.js';
import { sniff, type Sniffed } from './sniff.js';

const UPLOAD_ID = /^[a-f0-9]{24}$/;

/** A name's extension for a sniffed type, for a pasted or camera file that came without one. */
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

/** The name a file is kept under: the sender's, made safe, with an extension the bytes agree with when it had none. */
export function uploadName(raw: unknown, sniffed: Sniffed): string {
  const name = displayName(raw, 'file');
  if (extensionOf(name)) return name;
  const ext = EXT_BY_TYPE[sniffed.mediaType];
  return ext ? `${name}.${ext}` : name;
}

const tooLarge = () => new AppError('PAYLOAD_TOO_LARGE', `That file is over ${CHAT_MAX_UPLOAD_BYTES / 1_000_000} MB.`);

export interface UploadInput {
  /** The request body: the file's bytes. */
  body: ReadableStream<Uint8Array> | null;
  /** The sender's name for it (any characters; made safe here). */
  name: string | null;
  /** The size the sender announced, when it did: a file over the limit is refused before a byte is read. */
  declaredSize: number | null;
}

/** The pending upload's row, as stored. */
interface UploadRow {
  id: string;
  session_id: string;
  blob_sha256: string;
  name: string;
  media_type: string;
  size: number;
  meta: string;
  created_at: string;
}

const toUpload = (row: UploadRow): ChatUpload => {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(row.meta) as Record<string, unknown>;
  } catch {
    // unreadable meta: the file still has its columns
  }
  const file = fileRef({ ...meta, blobId: row.blob_sha256, name: row.name, mediaType: row.media_type, size: row.size });
  if (!file) throw new AppError('INTERNAL_ERROR', 'A stored upload could not be read.');
  return { ...file, id: row.id };
};

/**
 * Receives one file: streams it to a temporary file while hashing it and keeping its first bytes, refuses
 * an empty file, one over the limit, and one the chat has no room for, sniffs it, moves it into the blob
 * store and records the pending upload. A client that drops the connection leaves nothing behind.
 */
export async function receiveUpload(store: Store, sessionId: string, input: UploadInput): Promise<ChatUpload> {
  const db = store.db;
  if (!db || !store.writable) throw new AppError('SERVICE_UNAVAILABLE', 'The chat store is read-only.');
  if (!input.body) throw new AppError('BAD_REQUEST', 'Send the file as the request body.');
  if (input.declaredSize !== null && input.declaredSize > CHAT_MAX_UPLOAD_BYTES) throw tooLarge();
  sweepUploads(store); // stale ones first: they count against the room below
  const waiting = (db.prepare('SELECT COUNT(*) AS n FROM chat_uploads WHERE session_id = ?').get(sessionId) as { n: number }).n;
  if (waiting >= MAX_PENDING_UPLOADS) throw new AppError('LIMIT_REACHED', 'Too many files are waiting to be sent. Send the message or remove some.');
  assertRoom(store, sessionId, input.declaredSize ?? CHAT_MAX_UPLOAD_BYTES);

  const taken = await intakeStream(store, input.body, CHAT_MAX_UPLOAD_BYTES, { tooLarge, interrupted: () => new AppError('BAD_REQUEST', 'The upload was interrupted.') });
  const { tmp, size, head } = taken;
  if (size === 0) {
    rmSync(tmp, { force: true });
    throw new AppError('VALIDATION_FAILED', 'That file is empty.');
  }
  // The room is checked again with what really arrived (the announced size can be missing or wrong).
  try {
    assertRoom(store, sessionId, size);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }

  const sha = taken.sha256;
  const sniffed = sniff(head, displayName(input.name, 'file'), size, size > head.length);
  const name = uploadName(input.name, sniffed);
  adoptBlob(store, tmp, sha);

  const file: ChatFile = { blobId: sha, name, mediaType: sniffed.mediaType, size, preview: sniffed.preview, reach: sniffed.reach };
  if (sniffed.width && sniffed.height) {
    file.width = sniffed.width;
    file.height = sniffed.height;
  }
  const id = randomBytes(12).toString('hex');
  db.prepare('INSERT INTO chat_uploads (id, session_id, blob_sha256, name, media_type, size, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    sessionId,
    sha,
    name,
    sniffed.mediaType,
    size,
    JSON.stringify({ preview: file.preview, reach: file.reach, ...(file.width && file.height ? { width: file.width, height: file.height } : {}) }),
    new Date().toISOString(),
  );
  return { ...file, id };
}

/** The uploads a message names, in order: each must be this chat's and still waiting. A name that isn't throws, saying which. */
export function takeUploads(store: Store, sessionId: string, ids: string[]): ChatUpload[] {
  const db = store.db;
  if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The chat store is unavailable.');
  const get = db.prepare('SELECT * FROM chat_uploads WHERE id = ? AND session_id = ?');
  return ids.map((id) => {
    const row = UPLOAD_ID.test(id) ? (get.get(id, sessionId) as UploadRow | undefined) : undefined;
    if (!row) throw new AppError('VALIDATION_FAILED', 'An attached file is no longer there. Attach it again.', { details: { attachments: 'Unknown upload.' } });
    return toUpload(row);
  });
}

/** The bytes of an upload, for staging and for the image block. */
export function uploadPath(store: Store, blobId: string): string | null {
  if (!BLOB_ID.test(blobId)) return null;
  const file = join(blobDir(store), blobId);
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/** Forgets uploads once their message is recorded: its files are `chat_files` rows now, and the blobs stay. */
export function consumeUploads(store: Store, sessionId: string, ids: string[]): void {
  const db = store.db;
  if (!db || !store.writable || !ids.length) return;
  const del = db.prepare('DELETE FROM chat_uploads WHERE id = ? AND session_id = ?');
  for (const id of ids) del.run(id, sessionId);
}

/** Drops an upload that was never sent (the person removed it, or cancelled); its blob goes when nothing else links it. */
export function discardUpload(store: Store, sessionId: string, id: string): boolean {
  const db = store.db;
  if (!db || !store.writable || !UPLOAD_ID.test(id)) return false;
  const row = db.prepare('SELECT blob_sha256 FROM chat_uploads WHERE id = ? AND session_id = ?').get(id, sessionId) as { blob_sha256: string } | undefined;
  if (!row) return false;
  db.prepare('DELETE FROM chat_uploads WHERE id = ?').run(id);
  pruneBlobs(store, [row.blob_sha256]);
  return true;
}

/** Drops uploads that waited longer than {@link UPLOAD_TTL_MS}; returns how many went. */
export function sweepUploads(store: Store, now = Date.now()): number {
  const db = store.db;
  if (!db || !store.writable) return 0;
  const cutoff = new Date(now - UPLOAD_TTL_MS).toISOString();
  const stale = db.prepare('SELECT id, blob_sha256 FROM chat_uploads WHERE created_at < ?').all(cutoff) as { id: string; blob_sha256: string }[];
  if (!stale.length) return 0;
  const del = db.prepare('DELETE FROM chat_uploads WHERE id = ?');
  for (const s of stale) del.run(s.id);
  pruneBlobs(store, stale.map((s) => s.blob_sha256));
  return stale.length;
}
