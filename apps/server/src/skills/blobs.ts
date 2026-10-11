// The blob store (Skillset PRD §18 A5): content-addressed files at `<dataDir>/blobs/sha256/<aa>/<sha256>`
// (folders 0700, files 0600), with a `blobs` row each for garbage collection. Nothing here knows what a
// blob is for: users register a reference source (skill files, for one), and a blob that no source has
// referenced for 30 days is deleted. Written for skill files first; nothing in it is skill-specific.

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/store.js';

const SHA256 = /^[0-9a-f]{64}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Unreferenced blobs are kept this long, so a restored backup or an undo still finds its files (A5). */
export const BLOB_TTL_MS = 30 * DAY_MS;

export const sha256Hex = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function privateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // not ours to change (e.g. a mount); the files inside are still 0600
  }
}

export class BlobStore {
  readonly root: string;
  readonly #sources: (() => Iterable<string>)[] = [];

  constructor(
    private readonly store: Store,
    private readonly opts: { ttlMs?: number; now?: () => Date } = {},
  ) {
    this.root = join(store.dataDir, 'blobs', 'sha256');
  }

  #path(sha: string) {
    return join(this.root, sha.slice(0, 2), sha);
  }

  /** Adds a source of referenced blob hashes; collection keeps everything any source names. */
  addSource(source: () => Iterable<string>): void {
    this.#sources.push(source);
  }

  /**
   * Stores bytes once per content and returns their SHA-256. The file is written whole under a temporary
   * name and renamed, so a crash never leaves half a blob; an existing file with the wrong size (a torn
   * write from before) is replaced. Records the blob as referenced now, so a collection can't take it
   * between this call and the row that will refer to it.
   */
  put(bytes: Buffer): string {
    const sha = sha256Hex(bytes);
    const file = this.#path(sha);
    let present = false;
    try {
      present = statSync(file).size === bytes.length;
    } catch {
      present = false;
    }
    if (!present) {
      privateDir(this.root);
      privateDir(join(this.root, sha.slice(0, 2)));
      const tmp = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(tmp, bytes, { mode: 0o600, flag: 'wx' });
        renameSync(tmp, file);
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    }
    const now = (this.opts.now?.() ?? new Date()).toISOString();
    const db = this.store.db;
    if (db && this.store.writable) {
      db.prepare('INSERT INTO blobs (sha256, size, created_at) VALUES (?, ?, ?) ON CONFLICT (sha256) DO UPDATE SET unreferenced_since = NULL').run(sha, bytes.length, now);
    }
    return sha;
  }

  /** The bytes, or null when missing or damaged (their hash no longer matches). */
  get(sha: string): Buffer | null {
    if (!SHA256.test(sha)) return null;
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.#path(sha));
    } catch {
      return null;
    }
    return sha256Hex(bytes) === sha ? bytes : null;
  }

  has(sha: string): boolean {
    return SHA256.test(sha) && existsSync(this.#path(sha));
  }

  /**
   * One garbage-collection pass: blobs some source references are kept (and marked referenced); the
   * rest are marked unreferenced, and deleted once they've been so for the TTL. Files on disk without a
   * row (a crash between writing and recording) get one, starting their TTL now. Returns what it deleted.
   */
  collect(): { deleted: number; kept: number } {
    const db = this.store.db;
    if (!db || !this.store.writable) return { deleted: 0, kept: 0 };
    const now = this.opts.now?.() ?? new Date();
    const ttl = this.opts.ttlMs ?? BLOB_TTL_MS;
    const referenced = new Set<string>();
    for (const source of this.#sources) for (const sha of source()) referenced.add(sha);

    // Files no row knows about.
    const known = new Set((db.prepare('SELECT sha256 FROM blobs').all() as { sha256: string }[]).map((r) => r.sha256));
    if (existsSync(this.root)) {
      const insert = db.prepare('INSERT OR IGNORE INTO blobs (sha256, size, created_at, unreferenced_since) VALUES (?, ?, ?, ?)');
      for (const shard of readdirSync(this.root)) {
        if (!/^[0-9a-f]{2}$/.test(shard)) continue;
        for (const name of readdirSync(join(this.root, shard))) {
          const file = join(this.root, shard, name);
          if (name.endsWith('.tmp')) {
            // A temp file from a write that died: gone after a day.
            if (now.getTime() - statSync(file).mtimeMs > DAY_MS) rmSync(file, { force: true });
            continue;
          }
          if (!SHA256.test(name) || known.has(name)) continue;
          insert.run(name, statSync(file).size, now.toISOString(), referenced.has(name) ? null : now.toISOString());
        }
      }
    }

    const rows = db.prepare('SELECT sha256, unreferenced_since FROM blobs').all() as { sha256: string; unreferenced_since: string | null }[];
    const mark = db.prepare('UPDATE blobs SET unreferenced_since = ? WHERE sha256 = ?');
    const drop = db.prepare('DELETE FROM blobs WHERE sha256 = ?');
    let deleted = 0;
    let kept = 0;
    for (const r of rows) {
      if (referenced.has(r.sha256)) {
        if (r.unreferenced_since) mark.run(null, r.sha256);
        kept++;
      } else if (!r.unreferenced_since) {
        mark.run(now.toISOString(), r.sha256);
        kept++;
      } else if (now.getTime() - new Date(r.unreferenced_since).getTime() >= ttl) {
        rmSync(this.#path(r.sha256), { force: true });
        drop.run(r.sha256);
        deleted++;
      } else kept++;
    }
    return { deleted, kept };
  }
}
