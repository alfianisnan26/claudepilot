// Chat content: the portal's record of the files in a chat (`chat_files`, chat-sessions PRD §9) and the
// allow-listed shape an event payload carries. Rows link a blob to a session; a blob is only ever served to
// a session that links it. What is in a row came from the sniffer or the portal, never from a workspace's
// say-so, except the name and path, which are made safe before they are kept.

import type { ChatArtifactSource, ChatFile, ChatPreview, ChatReach } from '@portal/contracts';
import type { Store } from '../../store/store.js';
import { BLOB_ID, type ChatFileKind } from '../blobs.js';
import { displayName, HIDDEN_CHARS } from './names.js';

const PREVIEWS = new Set<string>(['image', 'text', 'pdf', 'audio', 'video', 'html', 'none']);
const REACHES = new Set<string>(['sees', 'reads', 'path']);
const SOURCES = new Set<string>(['write', 'edit', 'command', 'tool', 'publish']);
/** `type/subtype` made of the characters a media type has: nothing that could close a header or a tag. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$/i;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const count = (v: unknown, max: number): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max ? v : undefined);

/** A path to show: absolute, one line, bounded. Never used to read anything. */
export function shownPath(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const p = v.replace(HIDDEN_CHARS, '').trim();
  return p.startsWith('/') && p.length <= 1024 ? p : undefined;
}

/** Only the known fields of a file, each checked (a payload is read back after any number of releases). */
export function fileRef(v: unknown): ChatFile | null {
  const o = obj(v);
  if (!o || typeof o.blobId !== 'string' || !BLOB_ID.test(o.blobId)) return null;
  if (typeof o.mediaType !== 'string' || !MEDIA_TYPE.test(o.mediaType)) return null;
  if (typeof o.size !== 'number' || !Number.isFinite(o.size) || o.size < 0) return null;
  const file: ChatFile = {
    blobId: o.blobId,
    name: displayName(o.name, 'file'),
    mediaType: o.mediaType.toLowerCase(),
    size: Math.floor(o.size),
    preview: (typeof o.preview === 'string' && PREVIEWS.has(o.preview) ? o.preview : 'none') as ChatPreview,
  };
  const width = count(o.width, 100_000);
  const height = count(o.height, 100_000);
  if (width && height) {
    file.width = width;
    file.height = height;
  }
  if (typeof o.reach === 'string' && REACHES.has(o.reach)) file.reach = o.reach as ChatReach;
  const path = shownPath(o.path);
  if (path) file.path = path;
  if (typeof o.source === 'string' && SOURCES.has(o.source)) file.source = o.source as ChatArtifactSource;
  if (o.redacted === true) file.redacted = true;
  return file;
}

/** {@link fileRef} over a list; what isn't a file is left out. */
export function fileRefs(v: unknown): ChatFile[] {
  return Array.isArray(v) ? v.map(fileRef).filter((f): f is ChatFile => f !== null) : [];
}

/** The part of a file that doesn't have a column of its own. */
function metaOf(file: ChatFile): string {
  const meta: Record<string, unknown> = { preview: file.preview };
  if (file.reach) meta.reach = file.reach;
  if (file.source) meta.source = file.source;
  if (file.redacted) meta.redacted = true;
  return JSON.stringify(meta);
}

/** Links a blob to a session as a file of `kind` (`upload`, `download` for an artifact). Returns the row's id. */
export function recordFile(store: Store, sessionId: string, kind: ChatFileKind, file: ChatFile, eventSeq: number | null = null): number {
  const db = store.db;
  if (!db || !store.writable) throw new Error('The chat store is read-only.');
  const r = db
    .prepare('INSERT INTO chat_files (session_id, kind, blob_sha256, name, workspace_path, size, media_type, at, event_seq, width, height, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sessionId, kind, file.blobId, file.name, file.path ?? null, file.size, file.mediaType, new Date().toISOString(), eventSeq, file.width ?? null, file.height ?? null, metaOf(file));
  return Number(r.lastInsertRowid);
}

/** The event a file was recorded before its event existed: fills in the row. */
export function setFileEvent(store: Store, rowIds: number[], eventSeq: number): void {
  const db = store.db;
  if (!db || !store.writable || !rowIds.length) return;
  const set = db.prepare('UPDATE chat_files SET event_seq = ? WHERE id = ?');
  for (const id of rowIds) set.run(eventSeq, id);
}

/** What a session's latest row for a blob says: its name, sniffed type, size and preview. Null when the session doesn't link it. */
export interface BlobRow {
  name: string | null;
  mediaType: string;
  size: number;
  preview: ChatPreview;
}

export function blobRow(store: Store, sessionId: string, blobId: string): BlobRow | null {
  if (typeof blobId !== 'string' || !BLOB_ID.test(blobId)) return null;
  const db = store.db;
  if (!db) return null;
  const row = db.prepare('SELECT name, media_type, size, meta FROM chat_files WHERE session_id = ? AND blob_sha256 = ? ORDER BY id DESC LIMIT 1').get(sessionId, blobId) as
    | { name: string | null; media_type: string | null; size: number | null; meta: string | null }
    | undefined;
  if (!row) return null;
  let meta: Record<string, unknown> = {};
  try {
    meta = obj(JSON.parse(row.meta ?? '{}')) ?? {};
  } catch {
    // a row without usable meta (an image saved before schema 60): the type says what it is
  }
  const mediaType = typeof row.media_type === 'string' && MEDIA_TYPE.test(row.media_type) ? row.media_type.toLowerCase() : 'application/octet-stream';
  return {
    name: row.name,
    mediaType,
    size: typeof row.size === 'number' ? row.size : 0,
    preview: (typeof meta.preview === 'string' && PREVIEWS.has(meta.preview) ? meta.preview : mediaType.startsWith('image/') && mediaType !== 'image/svg+xml' ? 'image' : 'none') as ChatPreview,
  };
}

/** The distinct stored bytes a session links, in bytes (what counts against its quota). */
export function sessionBlobBytes(store: Store, sessionId: string): number {
  const db = store.db;
  if (!db) return 0;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(size), 0) AS n FROM (
         SELECT blob_sha256, MAX(size) AS size FROM chat_files WHERE session_id = ? AND blob_sha256 IS NOT NULL GROUP BY blob_sha256
         UNION
         SELECT blob_sha256, MAX(size) AS size FROM chat_uploads WHERE session_id = ? GROUP BY blob_sha256
       )`,
    )
    .get(sessionId, sessionId) as { n: number };
  return row.n;
}

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/**
 * The files of some transcript events, in the order asked: an `artifact` event's `files`, and the images
 * of any event (a tool's screenshot, an attached photo). What the zip of a turn is made of.
 */
export function eventFiles(store: Store, sessionId: string, seqs: number[]): ChatFile[] {
  const db = store.db;
  if (!db || !seqs.length) return [];
  const rows = db
    .prepare(`SELECT seq, payload FROM chat_events WHERE session_id = ? AND seq IN (${seqs.map(() => '?').join(',')})`)
    .all(sessionId, ...seqs) as { seq: number; payload: string }[];
  const bySeq = new Map(rows.map((r) => [r.seq, r.payload]));
  const out: ChatFile[] = [];
  for (const seq of seqs) {
    const raw = bySeq.get(seq);
    if (raw === undefined) continue;
    let payload: Record<string, unknown> = {};
    try {
      payload = obj(JSON.parse(raw)) ?? {};
    } catch {
      continue;
    }
    out.push(...fileRefs(payload.files));
    for (const image of Array.isArray(payload.images) ? payload.images : []) {
      const o = obj(image);
      if (!o || typeof o.blobId !== 'string' || typeof o.mediaType !== 'string') continue;
      const ext = IMAGE_EXT[o.mediaType] ?? 'img';
      const file = fileRef({ blobId: o.blobId, mediaType: o.mediaType, size: 0, name: typeof o.name === 'string' && o.name ? o.name : `image-${o.blobId.slice(0, 8)}.${ext}`, preview: 'image' });
      if (file) out.push(file);
    }
  }
  return out;
}

/**
 * Whether a tool request is only a read of a file the portal staged for one of THIS chat's attachments: the
 * tool is `Read` and its path is exactly where an upload of this session was written in the workspace. Claude
 * Code asks permission for it (the uploads folder is outside the session's folder); the person put the file
 * there themselves, so the controller may answer for them. Nothing else qualifies: not another chat's
 * upload, not a path next to it, not a different tool.
 */
export function isStagedUpload(store: Store, sessionId: string, toolName: string | null | undefined, input: unknown): boolean {
  if (toolName !== 'Read') return false;
  const o = obj(input);
  const path = typeof input === 'string' ? input : typeof o?.file_path === 'string' ? o.file_path : null;
  const db = store.db;
  if (!path || !db || path.length > 4096 || !path.startsWith('/') || path.split('/').includes('..')) return false;
  const row = db.prepare("SELECT 1 FROM chat_files WHERE session_id = ? AND kind = 'upload' AND workspace_path = ? LIMIT 1").get(sessionId, path);
  return !!row;
}
