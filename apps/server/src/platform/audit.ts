// The platform audit (docs/prd/web-app-pwa.md §11.7 step 4, docs/prd/platform-roadmap.md): every automatic act of the platform track
// leaves one row here: an answer from a notification, a channel made or tested, a trigger fired or refused, a chat moved by itself.
// Platform-wide table (`platform_audit`); each row names the person it concerns (`user_id`, nullable for the system): a user reads their
// own rows, an admin reads all. `detail` holds names, ids, numbers and fixed codes only: never a secret, a URL or message text.

import type { PlatformAuditEntry } from '@portal/contracts';
import type { Store } from '../store/store.js';

export interface AuditInput {
  severity?: PlatformAuditEntry['severity'];
  kind: string;
  actor: string;
  userId: string | null;
  subject?: string | null;
  detail?: Record<string, unknown>;
}

export interface AuditFilter {
  kind?: string;
  limit?: number;
  /** Rows with an id below this one (the next page). */
  before?: number;
}

const KIND = /^[a-z][a-z0-9_]{0,30}(?:\.[a-z][a-z0-9_]{0,30}){0,3}$/;
const RETENTION_MS = 90 * 86_400_000;
const DETAIL_MAX = 2_000;

/** Keeps a detail to what may be stored: plain values, short strings, nothing nested deeper than one level. */
export function cleanDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail ?? {}).slice(0, 24)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k)) continue;
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
    else if (typeof v === 'string') out[k] = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, 120);
    else if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string' || typeof x === 'number').slice(0, 10).map((x) => (typeof x === 'string' ? x.slice(0, 60) : x));
  }
  return out;
}

export class PlatformAudit {
  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Writes one row. Never throws: an audit row that cannot be written is logged (a read-only database). */
  record(e: AuditInput): void {
    const db = this.store.writable ? this.store.db : null;
    if (!db) return;
    if (!KIND.test(e.kind)) throw new Error(`audit kind "${e.kind}" must look like module.action`);
    try {
      let detail = JSON.stringify(cleanDetail(e.detail));
      if (detail.length > DETAIL_MAX) detail = '{}';
      db.prepare('INSERT INTO platform_audit (at, severity, kind, actor, user_id, subject, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        this.now().toISOString(),
        e.severity ?? 'info',
        e.kind,
        e.actor.slice(0, 120),
        e.userId,
        e.subject?.slice(0, 200) ?? null,
        detail,
      );
    } catch (err) {
      console.error(`[platform] an audit row could not be written: ${(err as Error).message}`);
    }
  }

  /** The rows a caller may read: their own (`userId`), or every row for an admin (`userId` null). Newest first. */
  list(filter: AuditFilter, userId: string | null): PlatformAuditEntry[] {
    const db = this.store.db;
    if (!db) return [];
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (userId !== null) {
      where.push('user_id = ?');
      args.push(userId);
    }
    if (filter.kind) {
      where.push('(kind = ? OR kind LIKE ?)');
      args.push(filter.kind, `${filter.kind.replace(/[\\%_]/g, (c) => `\\${c}`)}.%`);
    }
    if (filter.before) {
      where.push('id < ?');
      args.push(filter.before);
    }
    const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100)));
    const rows = db
      .prepare(`SELECT id, at, severity, kind, actor, user_id, subject, detail FROM platform_audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`)
      .all(...args) as { id: number; at: string; severity: PlatformAuditEntry['severity']; kind: string; actor: string; user_id: string | null; subject: string | null; detail: string }[];
    return rows.map((r) => ({ id: r.id, at: r.at, severity: r.severity, kind: r.kind, actor: r.actor, userId: r.user_id, subject: r.subject, detail: JSON.parse(r.detail) as Record<string, unknown> }));
  }

  /** Rows older than 90 days go. */
  sweep(): number {
    const db = this.store.writable ? this.store.db : null;
    if (!db) return 0;
    return Number(db.prepare('DELETE FROM platform_audit WHERE at < ?').run(new Date(this.now().getTime() - RETENTION_MS).toISOString()).changes);
  }
}
