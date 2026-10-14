// The Inbox, the delivery log and what quiet hours hold back (docs/prd/web-app-pwa.md §11.2, §11.8). Each row belongs to a user and
// every read filters by that user. The history keeps the text a destination without detail would have got (templates over names and
// numbers); the log keeps a status and a fixed code, never a URL, a path or a provider's reply. 30 days each.

import { randomBytes } from 'node:crypto';
import { fillTimeMarks, hasTimeMarks, zonedTime, type MuteScope, type NotifyDelivery, type NotifyError, type NotifyEvent, type NotifyHistoryItem, type NotifyHistoryPage, type NotifyKind, type NotifySuppression } from '@portal/contracts';
import type { Store } from '../store/store.js';
import type { Rendered } from './templates.js';

const RETENTION_MS = 30 * 86_400_000;
const TOKEN_KEEP_MS = 86_400_000;
/** Reset times this close are one period (as the usage monitor's pace reads them). */
const QUOTA_SAME_PERIOD_MS = 60_000;
export const QUOTA_RECOVERED = 'Recovered';

interface HistoryRow {
  id: string;
  kind: NotifyKind;
  at: string;
  title: string;
  body: string;
  path: string | null;
  subject_type: NotifyHistoryItem['subject']['type'];
  subject_id: string;
  workspace_id: string | null;
  read_at: string | null;
  resolved_at: string | null;
  resolution: string | null;
  muted: number;
}

export interface HeldItem {
  id: number;
  eventId: string;
  kind: NotifyKind;
  tag: string;
  at: string;
}

export class NotifyHistory {
  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get #w() {
    return this.store.writable ? this.store.db : null;
  }

  /**
   * One Inbox row for one user. The body is the first line only: detail never goes in the history. `muted`: a rule hushed it (stored,
   * marked, left out of the list and the unread count by default). `scope`: the event's narrowest mute scope, for "Mute similar" later.
   */
  add(ownerId: string, e: NotifyEvent, r: Rendered, opts: { muted?: boolean; scope?: MuteScope | null } = {}): string | null {
    const db = this.#w;
    if (!db) return null;
    const id = `nh_${randomBytes(8).toString('hex')}`;
    db.prepare(
      'INSERT INTO notify_history (id, owner_id, event_id, kind, at, title, body, path, subject_type, subject_id, workspace_id, tag, muted, scope_type, scope_id, scope_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, ownerId, e.id, e.kind, e.at, r.title, r.body.split('\n')[0] ?? '', r.path, e.subject.type, e.subject.id, e.subject.workspaceId ?? null, r.tag, opts.muted ? 1 : 0, opts.scope?.type ?? null, opts.scope?.id ?? null, opts.scope?.label ?? null);
    return id;
  }

  /**
   * T-126 item 2: a quota alert is ONE row per (person, Claude, window, period) that updates as its stage changes. `worse` says whether
   * this event made it worse (or opened it): only then is it pushed, and the row is unread again and moves to the top. The same stage
   * refreshes the numbers in place; a milder one (a projection after 95 %) leaves the row as it is. A row of an earlier period is closed
   * as Recovered and a new one opened. Without a period (no reset time) every alert is a row of its own, as before.
   */
  addQuota(ownerId: string, e: NotifyEvent, r: Rendered, q: { stage: number; period: number | null }, opts: { muted?: boolean; scope?: MuteScope | null } = {}): { id: string; worse: boolean } | null {
    const db = this.#w;
    if (!db) return null;
    const open =
      q.period === null
        ? undefined
        : (db
            .prepare("SELECT id, stage, period FROM notify_history WHERE owner_id = ? AND tag = ? AND kind = 'quota_low' AND resolved_at IS NULL AND period IS NOT NULL ORDER BY at DESC LIMIT 1")
            .get(ownerId, r.tag) as { id: string; stage: number | null; period: number } | undefined);
    if (open && q.period !== null && Math.abs(open.period - q.period) < QUOTA_SAME_PERIOD_MS) {
      const was = open.stage ?? -1;
      if (q.stage < was) return { id: open.id, worse: false };
      const worse = q.stage > was;
      db.prepare(
        `UPDATE notify_history SET event_id = ?, title = ?, body = ?, path = ?, stage = ?, period = ?${worse ? ', at = ?, read_at = NULL, muted = ?' : ''} WHERE id = ?`,
      ).run(...([e.id, r.title, r.body.split('\n')[0] ?? '', r.path, q.stage, q.period, ...(worse ? [e.at, opts.muted ? 1 : 0] : []), open.id] as (string | number | null)[]));
      return { id: open.id, worse };
    }
    if (open) db.prepare('UPDATE notify_history SET resolved_at = ?, resolution = ? WHERE id = ?').run(this.now().toISOString(), QUOTA_RECOVERED, open.id);
    const id = this.add(ownerId, e, r, opts);
    if (id) db.prepare('UPDATE notify_history SET stage = ?, period = ? WHERE id = ?').run(q.stage, q.period, id);
    return id ? { id, worse: true } : null;
  }

  /** T-126 item 2: a quota row whose window has reset is closed as Recovered. Returns how many closed. */
  recoverQuota(): number {
    const db = this.#w;
    if (!db) return 0;
    const now = this.now();
    return Number(
      db
        .prepare("UPDATE notify_history SET resolved_at = ?, resolution = ? WHERE kind = 'quota_low' AND resolved_at IS NULL AND period IS NOT NULL AND period <= ?")
        .run(now.toISOString(), QUOTA_RECOVERED, now.getTime()).changes,
    );
  }

  /* ---------- Quota alerts for an idle Claude (T-126 item 1) ---------- */

  /** Whether the person hears of this Claude's quota even when no chat runs on it. */
  watches(ownerId: string, claudeId: string): boolean {
    return !!this.store.db?.prepare('SELECT 1 FROM notify_quota_watch WHERE owner_id = ? AND claude_id = ?').get(ownerId, claudeId);
  }

  watched(ownerId: string): string[] {
    return ((this.store.db?.prepare('SELECT claude_id FROM notify_quota_watch WHERE owner_id = ? ORDER BY claude_id').all(ownerId) ?? []) as { claude_id: string }[]).map((r) => r.claude_id);
  }

  setWatch(ownerId: string, claudeId: string, on: boolean): void {
    const db = this.#w;
    if (!db) return;
    if (on) db.prepare('INSERT OR IGNORE INTO notify_quota_watch (owner_id, claude_id, at) VALUES (?, ?, ?)').run(ownerId, claudeId, this.now().toISOString());
    else db.prepare('DELETE FROM notify_quota_watch WHERE owner_id = ? AND claude_id = ?').run(ownerId, claudeId);
  }

  page(ownerId: string, opts: { before?: string; limit?: number; muted?: boolean } = {}): NotifyHistoryPage {
    const db = this.store.db;
    if (!db) return { items: [], next: null, unread: 0 };
    const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
    const nowMs = this.now().getTime();
    const before = opts.before && !Number.isNaN(Date.parse(opts.before)) ? opts.before : null;
    const rows = db
      .prepare(
        `SELECT id, kind, at, title, body, path, subject_type, subject_id, workspace_id, read_at, resolved_at, resolution, muted FROM notify_history WHERE owner_id = ? ${opts.muted ? '' : 'AND muted = 0'} ${before ? 'AND at < ?' : ''} ORDER BY at DESC, id DESC LIMIT ?`,
      )
      .all(...(before ? [ownerId, before, limit + 1] : [ownerId, limit + 1])) as unknown as HistoryRow[];
    const items = rows.slice(0, limit).map(
      (r): NotifyHistoryItem => ({
        id: r.id,
        kind: r.kind,
        at: r.at,
        title: r.title,
        ...(hasTimeMarks(r.body) ? { body: fillTimeMarks(r.body, (iso) => `${zonedTime(iso, nowMs, 'UTC')} UTC`), bodyMarked: r.body } : { body: r.body }),
        path: r.path,
        subject: { type: r.subject_type, id: r.subject_id, ...(r.workspace_id ? { workspaceId: r.workspace_id } : {}) },
        readAt: r.read_at,
        resolvedAt: r.resolved_at,
        resolution: r.resolution,
        muted: r.muted === 1,
      }),
    );
    return { items, next: rows.length > limit ? items.at(-1)!.at : null, unread: this.unread(ownerId) };
  }

  unread(ownerId: string): number {
    return (this.store.db?.prepare('SELECT COUNT(*) AS n FROM notify_history WHERE owner_id = ? AND read_at IS NULL AND muted = 0').get(ownerId) as { n: number } | undefined)?.n ?? 0;
  }

  markRead(ownerId: string, upTo?: string | null): number {
    const db = this.#w;
    if (!db) return this.unread(ownerId);
    const at = this.now().toISOString();
    if (upTo && !Number.isNaN(Date.parse(upTo))) db.prepare('UPDATE notify_history SET read_at = ? WHERE owner_id = ? AND read_at IS NULL AND at <= ?').run(at, ownerId, upTo);
    else db.prepare('UPDATE notify_history SET read_at = ? WHERE owner_id = ? AND read_at IS NULL').run(at, ownerId);
    return this.unread(ownerId);
  }

  clear(ownerId: string): void {
    this.#w?.prepare('DELETE FROM notify_history WHERE owner_id = ?').run(ownerId);
  }

  /** The item is dealt with (a request answered, a run passed): every user's row under this tag is shown dimmed. Returns the owners touched. */
  resolve(tag: string, resolution: string): string[] {
    const db = this.#w;
    if (!db) return [];
    const owners = (db.prepare('SELECT DISTINCT owner_id FROM notify_history WHERE tag = ? AND resolved_at IS NULL').all(tag) as { owner_id: string }[]).map((r) => r.owner_id);
    if (owners.length) db.prepare('UPDATE notify_history SET resolved_at = ?, resolution = ? WHERE tag = ? AND resolved_at IS NULL').run(this.now().toISOString(), resolution.slice(0, 60), tag);
    db.prepare('DELETE FROM notify_held WHERE tag = ?').run(tag);
    return owners;
  }

  /** Whether the latest row under the tag is dealt with (a quota tag is reused period after period: an older Recovered row says nothing). */
  resolved(tag: string): boolean {
    const r = this.store.db?.prepare('SELECT resolved_at FROM notify_history WHERE tag = ? ORDER BY at DESC, rowid DESC LIMIT 1').get(tag) as { resolved_at: string | null } | undefined;
    return !!r && r.resolved_at !== null;
  }

  /* ---------- Delivery log ---------- */

  log(ownerId: string, row: { eventId: string; kind: NotifyKind; destinationId: string; status: NotifyDelivery['status']; code: NotifyError | NotifySuppression | null; attempts?: number; httpStatus?: number | null }): void {
    this.#w
      ?.prepare('INSERT INTO notify_log (owner_id, at, event_id, kind, destination_id, status, code, attempts, http_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(ownerId, this.now().toISOString(), row.eventId, row.kind, row.destinationId, row.status, row.code, row.attempts ?? 0, row.httpStatus ?? null);
  }

  deliveries(ownerId: string, opts: { destination?: string; limit?: number } = {}): NotifyDelivery[] {
    const db = this.store.db;
    if (!db) return [];
    const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
    const rows = db
      .prepare(`SELECT id, at, event_id, kind, destination_id, status, code, attempts, http_status FROM notify_log WHERE owner_id = ? ${opts.destination ? 'AND destination_id = ?' : ''} ORDER BY id DESC LIMIT ?`)
      .all(...(opts.destination ? [ownerId, opts.destination, limit] : [ownerId, limit])) as {
      id: number;
      at: string;
      event_id: string;
      kind: NotifyKind;
      destination_id: string;
      status: NotifyDelivery['status'];
      code: NotifyDelivery['code'];
      attempts: number;
      http_status: number | null;
    }[];
    return rows.map((r) => ({ id: r.id, at: r.at, eventId: r.event_id, kind: r.kind, destinationId: r.destination_id, status: r.status, code: r.code, attempts: r.attempts, httpStatus: r.http_status }));
  }

  /* ---------- Quiet hours ---------- */

  hold(ownerId: string, destinationId: string, e: NotifyEvent, tag: string): void {
    this.#w?.prepare('INSERT INTO notify_held (owner_id, destination_id, event_id, kind, tag, at) VALUES (?, ?, ?, ?, ?, ?)').run(ownerId, destinationId, e.id, e.kind, tag, e.at);
  }

  /** Destinations with something held. */
  heldDestinations(): string[] {
    return ((this.store.db?.prepare('SELECT DISTINCT destination_id FROM notify_held').all() ?? []) as { destination_id: string }[]).map((r) => r.destination_id);
  }

  /** Takes what one destination holds, minus what was dealt with meanwhile (one per tag). */
  takeHeld(destinationId: string): HeldItem[] {
    const db = this.#w;
    if (!db) return [];
    const rows = db.prepare('SELECT id, event_id, kind, tag, at FROM notify_held WHERE destination_id = ? ORDER BY id').all(destinationId) as { id: number; event_id: string; kind: NotifyKind; tag: string; at: string }[];
    db.prepare('DELETE FROM notify_held WHERE destination_id = ?').run(destinationId);
    const seen = new Set<string>();
    return rows
      .filter((r) => !this.resolved(r.tag) && !seen.has(r.tag) && seen.add(r.tag))
      .map((r) => ({ id: r.id, eventId: r.event_id, kind: r.kind, tag: r.tag, at: r.at }));
  }

  /** History and log after 30 days, used or expired answer tokens after a day. */
  sweep(): void {
    const db = this.#w;
    if (!db) return;
    const now = this.now().getTime();
    const old = new Date(now - RETENTION_MS).toISOString();
    db.prepare('DELETE FROM notify_history WHERE at < ?').run(old);
    db.prepare('DELETE FROM notify_log WHERE at < ?').run(old);
    db.prepare('DELETE FROM notify_held WHERE at < ?').run(old);
    const dayAgo = new Date(now - TOKEN_KEEP_MS).toISOString();
    db.prepare('DELETE FROM notify_action_tokens WHERE (used_at IS NOT NULL AND used_at < ?) OR expires_at < ?').run(dayAgo, dayAgo);
  }
}
