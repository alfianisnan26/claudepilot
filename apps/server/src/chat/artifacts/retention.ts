// Chat content: how long files are kept and what is cleaned up (chat-sessions PRD FR42). Files, like events and
// requests, are kept 90 days after a chat's last activity; then the stored copies (attachments, artifacts, tool
// images) go, and a card that points at one says it is unavailable. Blobs nothing links any more (a crash between
// storing and recording, a deleted chat's leftovers) and half-written temporary files are swept too. The portal's
// backups carry the database (which files a chat had, their names and sizes), not the blob store's bytes.

import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../../store/store.js';
import { BLOB_ID, blobDir, pruneBlobs } from '../blobs.js';

/** Files are kept this long after a chat's last activity (FR42). */
export const RETENTION_MS = 90 * 24 * 60 * 60_000;
/** An unlinked blob is only removed once it is this old (it may be between being stored and being recorded). */
const ORPHAN_GRACE_MS = 24 * 60 * 60_000;
/** A temporary file is only removed once it is this old (it may be an upload still arriving). */
const TEMP_GRACE_MS = 60 * 60_000;

/** Deletes the stored files of chats idle for more than {@link RETENTION_MS}. Returns how many chats and blobs it touched. */
export function expireFiles(store: Store, now = Date.now()): { chats: number; blobs: number } {
  const db = store.db;
  if (!db || !store.writable) return { chats: 0, blobs: 0 };
  const cutoff = new Date(now - RETENTION_MS).toISOString();
  const idle = db.prepare('SELECT id FROM chat_sessions WHERE last_activity_at < ? AND EXISTS (SELECT 1 FROM chat_files WHERE chat_files.session_id = chat_sessions.id)').all(cutoff) as { id: string }[];
  const blobs = new Set<string>();
  for (const { id } of idle) {
    for (const row of db.prepare('SELECT DISTINCT blob_sha256 AS b FROM chat_files WHERE session_id = ? AND blob_sha256 IS NOT NULL').all(id) as { b: string }[]) blobs.add(row.b);
    db.prepare('DELETE FROM chat_files WHERE session_id = ?').run(id);
  }
  pruneBlobs(store, [...blobs]);
  return { chats: idle.length, blobs: blobs.size };
}

/** Deletes blob files nothing links and temporary files left behind. Returns how many it removed. */
export function sweepOrphans(store: Store, now = Date.now()): number {
  const db = store.db;
  if (!db || !store.writable) return 0;
  const dir = blobDir(store);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0; // no blob store yet
  }
  const linked = new Set((db.prepare('SELECT blob_sha256 AS b FROM chat_files WHERE blob_sha256 IS NOT NULL UNION SELECT blob_sha256 AS b FROM chat_uploads').all() as { b: string }[]).map((r) => r.b));
  let removed = 0;
  for (const name of names) {
    const file = join(dir, name);
    let age: number;
    try {
      age = now - statSync(file).mtimeMs;
    } catch {
      continue;
    }
    const orphan = BLOB_ID.test(name) && !linked.has(name) && age > ORPHAN_GRACE_MS;
    const temp = /\.(?:part|tmp)$/.test(name) && age > TEMP_GRACE_MS;
    if (orphan || temp) {
      rmSync(file, { force: true });
      removed++;
    }
  }
  return removed;
}
