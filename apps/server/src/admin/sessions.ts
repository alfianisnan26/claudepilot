// The Admin console's own sessions (docs/prd/organizations.md §6.11; migration 470). Never the main portal's session: a separate table, a
// separate cookie (`__Host-pilot_admin`), shorter clocks. A session lives while its account is an ACTIVE admin (read on every use), at most
// 15 minutes after its last request and 2 hours after its sign-in. A step-up (the password again) marks the session for 5 minutes.
// Only a sha256 of the token is stored; the token exists only in the browser's cookie.

import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import { ADMIN_SESSION_LIMITS } from '@portal/contracts';

export interface AdminSession {
  id: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  reauthAt: number | null;
}

interface Row {
  id: string;
  user_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  reauth_at: number | null;
  ended_at: number | null;
}

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');
/** Ended rows are kept this long (the user page counts live ones only). */
const KEEP_ENDED_MS = 30 * 86_400_000;

export interface AdminSessionsDeps {
  db: () => DatabaseSync | null;
  writable?: () => DatabaseSync | null;
  /** Whether the account is an active admin NOW. Anything else ends its sessions on their next use. */
  isActiveAdmin: (userId: string) => boolean;
  now?: () => number;
  limits?: { idleMs: number; absoluteMs: number; stepUpMs: number };
}

export class AdminSessions {
  readonly #db: () => DatabaseSync | null;
  readonly #w: () => DatabaseSync | null;
  readonly #isActiveAdmin: (userId: string) => boolean;
  readonly #now: () => number;
  readonly limits: { idleMs: number; absoluteMs: number; stepUpMs: number };

  constructor(d: AdminSessionsDeps) {
    this.#db = d.db;
    this.#w = d.writable ?? d.db;
    this.#isActiveAdmin = d.isActiveAdmin;
    this.#now = d.now ?? Date.now;
    this.limits = d.limits ?? ADMIN_SESSION_LIMITS;
  }

  #write(): DatabaseSync {
    const db = this.#w();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    return db;
  }

  /** A new session for an account the caller has just checked (an active admin, the right password). Returns the cookie's token. */
  open(userId: string): { token: string; session: AdminSession } {
    if (!this.#isActiveAdmin(userId)) throw new AppError('UNAUTHORIZED', 'That email or password is not right.');
    const token = randomBytes(32).toString('base64url');
    const id = `as_${randomBytes(9).toString('base64url')}`;
    const now = this.#now();
    const db = this.#write();
    db.prepare('DELETE FROM admin_sessions WHERE ended_at IS NOT NULL AND ended_at < ?').run(now - KEEP_ENDED_MS);
    db.prepare('INSERT INTO admin_sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      hashOf(token),
      userId,
      now,
      now,
      now + this.limits.absoluteMs,
    );
    return { token, session: { id, userId, createdAt: now, lastSeenAt: now, expiresAt: now + this.limits.absoluteMs, reauthAt: null } };
  }

  /**
   * The live session of this token, touched (its idle clock starts again), or null. An idle, expired or ended session, or one whose account
   * is no longer an active admin, is ended here and answers null. A database that cannot be read answers null (fail closed).
   */
  check(token: string | undefined): AdminSession | null {
    if (!token || token.length > 200) return null;
    let r: Row | undefined;
    try {
      r = this.#db()?.prepare('SELECT id, user_id, created_at, last_seen_at, expires_at, reauth_at, ended_at FROM admin_sessions WHERE token_hash = ?').get(hashOf(token)) as
        | Row
        | undefined;
    } catch {
      return null;
    }
    if (!r || r.ended_at !== null) return null;
    const now = this.#now();
    const reason =
      now >= r.expires_at ? 'expired' : now - r.last_seen_at >= this.limits.idleMs ? 'idle' : !this.#isActiveAdmin(r.user_id) ? 'not an active admin' : null;
    if (reason) {
      this.#end(r.id, reason);
      return null;
    }
    this.#w()?.prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?').run(now, r.id);
    return { id: r.id, userId: r.user_id, createdAt: r.created_at, lastSeenAt: now, expiresAt: r.expires_at, reauthAt: r.reauth_at };
  }

  /** Marks a step-up (the caller checked the password). */
  stepUp(id: string): number {
    const now = this.#now();
    this.#write().prepare('UPDATE admin_sessions SET reauth_at = ? WHERE id = ? AND ended_at IS NULL').run(now, id);
    return now;
  }

  /** Whether the session stepped up within the window. */
  fresh(s: Pick<AdminSession, 'reauthAt'>): boolean {
    return s.reauthAt !== null && this.#now() - s.reauthAt <= this.limits.stepUpMs;
  }

  /** Until when the step-up counts, or null. */
  freshUntil(s: Pick<AdminSession, 'reauthAt'>): number | null {
    return this.fresh(s) ? s.reauthAt! + this.limits.stepUpMs : null;
  }

  end(id: string, reason: string): void {
    this.#end(id, reason);
  }

  #end(id: string, reason: string): void {
    this.#w()?.prepare('UPDATE admin_sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(this.#now(), reason.slice(0, 60), id);
  }

  /** Ends every live session of one account (but `keep`); returns how many. */
  endAllFor(userId: string, reason: string, keep?: string): number {
    return Number(
      this.#write()
        .prepare('UPDATE admin_sessions SET ended_at = ?, end_reason = ? WHERE user_id = ? AND ended_at IS NULL AND id IS NOT ?')
        .run(this.#now(), reason.slice(0, 60), userId, keep ?? null).changes,
    );
  }

  /** Live sessions of one account (not ended, not past either clock). */
  liveCount(userId: string): number {
    const now = this.#now();
    const r = this.#db()
      ?.prepare('SELECT count(*) AS n FROM admin_sessions WHERE user_id = ? AND ended_at IS NULL AND expires_at > ? AND last_seen_at > ?')
      .get(userId, now, now - this.limits.idleMs) as { n: number } | undefined;
    return r?.n ?? 0;
  }
}
