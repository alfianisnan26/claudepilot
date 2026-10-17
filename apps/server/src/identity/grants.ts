// Session delegation (owner, 2026-10-17): one chat session given to one account at `view` (read it live) or `operate` (also send, stop
// and answer its approvals). Nothing else of the workspace comes with it: no terminal, no files, no other session, no credentials, no
// Bypass, model or end. Read on every request, so a revoke applies at once.

import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import type { SessionGrant, SessionGrantLevel } from '@portal/contracts';

export class SessionGrants {
  constructor(
    private readonly db: () => DatabaseSync | null,
    private readonly writable: () => DatabaseSync | null = db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  #w(): DatabaseSync {
    const db = this.writable();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    return db;
  }

  grant(sessionId: string, userId: string, level: SessionGrantLevel, by: string): SessionGrant {
    if (level !== 'view' && level !== 'operate') throw new AppError('VALIDATION_FAILED', 'A level is view or operate.', { details: { level: 'view or operate' } });
    const at = this.now().toISOString();
    this.#w()
      .prepare('INSERT INTO session_grants (session_id, user_id, level, granted_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (session_id, user_id) DO UPDATE SET level = excluded.level, granted_by = excluded.granted_by, created_at = excluded.created_at')
      .run(sessionId, userId, level, by, at);
    return { sessionId, userId, level, grantedBy: by, createdAt: at };
  }

  revoke(sessionId: string, userId: string): boolean {
    return Number(this.#w().prepare('DELETE FROM session_grants WHERE session_id = ? AND user_id = ?').run(sessionId, userId).changes) > 0;
  }

  /** Every grant of an account, or of a session. */
  forUser(userId: string): SessionGrant[] {
    return this.#rows('SELECT * FROM session_grants WHERE user_id = ? ORDER BY created_at', userId);
  }
  forSession(sessionId: string): SessionGrant[] {
    return this.#rows('SELECT * FROM session_grants WHERE session_id = ? ORDER BY created_at', sessionId);
  }
  removeUser(userId: string): void {
    this.writable()?.prepare('DELETE FROM session_grants WHERE user_id = ?').run(userId);
  }

  /** The level an account holds on a session, or null. */
  levelOf(sessionId: string, userId: string): SessionGrantLevel | null {
    const r = this.db()?.prepare('SELECT level FROM session_grants WHERE session_id = ? AND user_id = ?').get(sessionId, userId) as { level: SessionGrantLevel } | undefined;
    return r?.level ?? null;
  }

  #rows(sql: string, arg: string): SessionGrant[] {
    const rows = (this.db()?.prepare(sql).all(arg) ?? []) as { session_id: string; user_id: string; level: SessionGrantLevel; granted_by: string; created_at: string }[];
    return rows.map((r) => ({ sessionId: r.session_id, userId: r.user_id, level: r.level, grantedBy: r.granted_by, createdAt: r.created_at }));
  }
}
