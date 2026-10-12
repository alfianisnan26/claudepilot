// Chat content: how much a chat, and the portal, may keep in the blob store (chat-sessions PRD FR42, §9).
// Uploads and artifacts both count; the same bytes in two chats count in each (each chat could be deleted
// alone). Limits can be changed with PORTAL_CHAT_SESSION_QUOTA_MB and PORTAL_CHAT_BLOB_QUOTA_MB.

import { AppError } from '@isnanme/core';
import type { Store } from '../../store/store.js';
import { sessionBlobBytes } from './records.js';

const mb = (name: string, fallback: number): number => {
  const n = Number(process.env[name]);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 1_000_000;
};

/** What one chat may keep, and what all chats may keep together. */
export const sessionQuotaBytes = (): number => mb('PORTAL_CHAT_SESSION_QUOTA_MB', 500);
export const totalQuotaBytes = (): number => mb('PORTAL_CHAT_BLOB_QUOTA_MB', 10_000);

/** Uploads waiting for a message, per chat (a person attaching, removing and attaching again never reaches it). */
export const MAX_PENDING_UPLOADS = 40;
/** How long an upload waits for its message before it is dropped. */
export const UPLOAD_TTL_MS = 60 * 60_000;

/** The distinct bytes every chat links together. */
export function totalBlobBytes(store: Store): number {
  const db = store.db;
  if (!db) return 0;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(size), 0) AS n FROM (
         SELECT blob_sha256, MAX(size) AS size FROM chat_files WHERE blob_sha256 IS NOT NULL GROUP BY blob_sha256
         UNION
         SELECT blob_sha256, MAX(size) AS size FROM chat_uploads GROUP BY blob_sha256
       )`,
    )
    .get() as { n: number };
  return row.n;
}

const mbText = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

/** Whether `incoming` more bytes fit in this chat and in the portal; a limit hit says which, in the person's terms. */
export function roomFor(store: Store, sessionId: string, incoming: number): { ok: true } | { ok: false; message: string } {
  const session = sessionQuotaBytes();
  if (sessionBlobBytes(store, sessionId) + incoming > session) return { ok: false, message: `This chat's files are full (${mbText(session)}). Delete files or start another chat.` };
  const total = totalQuotaBytes();
  if (totalBlobBytes(store) + incoming > total) return { ok: false, message: `The portal's chat file storage is full (${mbText(total)}). Delete old chats to free space.` };
  return { ok: true };
}

/** Like {@link roomFor}, for a request that must be refused. */
export function assertRoom(store: Store, sessionId: string, incoming: number): void {
  const room = roomFor(store, sessionId, incoming);
  if (!room.ok) throw new AppError('LIMIT_REACHED', room.message);
}
