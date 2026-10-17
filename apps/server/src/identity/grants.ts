// Session sharing (owner, 2026-10-17): one chat session given to one account or one team, with what they may do on it (read, send,
// respond, stop) and until when. Nothing else of the workspace comes with it: no terminal, no files, no other session, no credentials, no
// Bypass, model or end. Read on every request, so a revoke, an expiry or leaving a team applies at once.

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import {
  isSessionShareCap,
  SESSION_SHARE_CAPS,
  SESSION_SHARE_MAX_DAYS,
  type SessionShare,
  type SessionShareCap,
  type ShareSubjectRef,
} from '@portal/contracts';

interface Row {
  id: string;
  session_id: string;
  subject_kind: 'user' | 'team';
  subject_id: string;
  caps: string;
  bypass_ack: number;
  expires_at: string | null;
  note: string | null;
  granted_by: string;
  created_at: string;
}

/** Caps in their fixed order, `read` always first and always there. */
export function normalizeCaps(raw: unknown): SessionShareCap[] {
  if (!Array.isArray(raw) || !raw.every(isSessionShareCap))
    throw new AppError('VALIDATION_FAILED', 'Pick what they may do.', { details: { caps: `Some of ${SESSION_SHARE_CAPS.join(', ')}.` } });
  const set = new Set<SessionShareCap>(['read', ...raw]);
  return SESSION_SHARE_CAPS.filter((c) => set.has(c));
}

/** What an account holds on one session, every share it reaches together. */
export interface HeldShare {
  caps: SessionShareCap[];
  /** Every share that gives an act also accepted Bypass. */
  bypassAck: boolean;
  expiresAt: string | null;
  via: string[];
}

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

  #view = (r: Row, name: (s: ShareSubjectRef) => string): SessionShare => {
    const subject: ShareSubjectRef = { kind: r.subject_kind, id: r.subject_id };
    return {
      id: r.id,
      sessionId: r.session_id,
      subject,
      subjectName: name(subject),
      caps: r.caps.split(',').filter(isSessionShareCap),
      bypassAck: r.bypass_ack === 1,
      expiresAt: r.expires_at,
      expired: r.expires_at !== null && r.expires_at <= this.now().toISOString(),
      note: r.note,
      grantedBy: r.granted_by,
      createdAt: r.created_at,
    };
  };

  /** An end time: null, or an ISO time in the future and at most a year away. */
  #expiry(raw: unknown): string | null {
    if (raw === null || raw === undefined || raw === '') return null;
    const t = typeof raw === 'string' ? Date.parse(raw) : NaN;
    const now = this.now().getTime();
    if (!Number.isFinite(t) || t <= now) throw new AppError('VALIDATION_FAILED', 'Pick an end in the future.', { details: { expiresAt: 'A future time.' } });
    if (t > now + SESSION_SHARE_MAX_DAYS * 86_400_000)
      throw new AppError('VALIDATION_FAILED', `At most ${SESSION_SHARE_MAX_DAYS} days.`, { details: { expiresAt: 'Too far.' } });
    return new Date(t).toISOString();
  }

  /** Checks what a share would be, writing nothing. */
  validate(opts: { caps: unknown; expiresAt?: unknown; note?: unknown }): { caps: SessionShareCap[]; expiresAt: string | null; note: string | null } {
    return {
      caps: normalizeCaps(opts.caps),
      expiresAt: this.#expiry(opts.expiresAt),
      note: typeof opts.note === 'string' && opts.note.trim() ? opts.note.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : null,
    };
  }

  /** Create or replace the share of `subject` on `sessionId`. */
  share(
    sessionId: string,
    subject: ShareSubjectRef,
    opts: { caps: unknown; expiresAt?: unknown; note?: unknown; bypassAck?: boolean },
    by: string,
    name: (s: ShareSubjectRef) => string = (s) => s.id,
  ): SessionShare {
    const { caps, expiresAt, note } = this.validate(opts);
    const acts = caps.some((c) => c !== 'read');
    const at = this.now().toISOString();
    const id = `sh_${randomBytes(9).toString('hex')}`;
    this.#w()
      .prepare(
        `INSERT INTO session_shares (id, session_id, subject_kind, subject_id, caps, bypass_ack, expires_at, note, granted_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (session_id, subject_kind, subject_id) DO UPDATE SET caps = excluded.caps, bypass_ack = excluded.bypass_ack,
           expires_at = excluded.expires_at, note = excluded.note, granted_by = excluded.granted_by, created_at = excluded.created_at`,
      )
      .run(id, sessionId, subject.kind, subject.id, caps.join(','), acts && opts.bypassAck ? 1 : 0, expiresAt, note, by, at);
    return this.#view(this.#one(sessionId, subject)!, name);
  }

  /** Change one share in place (caps, end, note, the Bypass acceptance). */
  update(
    shareId: string,
    patch: { caps?: unknown; expiresAt?: unknown; note?: unknown; bypassAck?: boolean },
    by: string,
    name: (s: ShareSubjectRef) => string = (s) => s.id,
  ): SessionShare {
    const r = this.byId(shareId);
    if (!r) throw new AppError('NOT_FOUND', 'No such share.');
    // An ended share is never brought back by changing something else: the end is said again (a new one, or null for none).
    if (patch.expiresAt === undefined && r.expires_at !== null && r.expires_at <= this.now().toISOString())
      throw new AppError('VALIDATION_FAILED', 'This share has ended. Give it a new end, or none.', { details: { expiresAt: 'Required for an ended share.' } });
    return this.share(
      r.session_id,
      { kind: r.subject_kind, id: r.subject_id },
      {
        caps: patch.caps ?? r.caps.split(','),
        expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : r.expires_at,
        note: patch.note !== undefined ? patch.note : r.note,
        bypassAck: patch.bypassAck ?? r.bypass_ack === 1,
      },
      by,
      name,
    );
  }

  #one(sessionId: string, subject: ShareSubjectRef): Row | undefined {
    return this.db()?.prepare('SELECT * FROM session_shares WHERE session_id = ? AND subject_kind = ? AND subject_id = ?').get(sessionId, subject.kind, subject.id) as
      | Row
      | undefined;
  }

  byId(shareId: string): Row | undefined {
    return this.db()?.prepare('SELECT * FROM session_shares WHERE id = ?').get(shareId) as Row | undefined;
  }

  revokeId(shareId: string): Row | null {
    const r = this.byId(shareId);
    if (!r) return null;
    this.#w().prepare('DELETE FROM session_shares WHERE id = ?').run(shareId);
    return r;
  }

  /** The old path: an account's direct share on a session. */
  revoke(sessionId: string, userId: string): boolean {
    return Number(this.#w().prepare("DELETE FROM session_shares WHERE session_id = ? AND subject_kind = 'user' AND subject_id = ?").run(sessionId, userId).changes) > 0;
  }

  forSession(sessionId: string, name?: (s: ShareSubjectRef) => string): SessionShare[] {
    return this.#rows('SELECT * FROM session_shares WHERE session_id = ? ORDER BY created_at', [sessionId], name);
  }
  forTeam(teamId: string, name?: (s: ShareSubjectRef) => string): SessionShare[] {
    return this.#rows("SELECT * FROM session_shares WHERE subject_kind = 'team' AND subject_id = ? ORDER BY created_at", [teamId], name);
  }
  all(name?: (s: ShareSubjectRef) => string): SessionShare[] {
    return this.#rows('SELECT * FROM session_shares ORDER BY created_at DESC LIMIT 2000', [], name);
  }

  /** The live (not expired) shares an account reaches: its own and those of `teams` (the account's team ids). */
  #current(userId: string, teams: string[]): Row[] {
    const db = this.db();
    if (!db) return [];
    const now = this.now().toISOString();
    const marks = teams.map(() => '?').join(',');
    const sql = `SELECT * FROM session_shares WHERE (expires_at IS NULL OR expires_at > ?) AND ((subject_kind = 'user' AND subject_id = ?)${
      teams.length ? ` OR (subject_kind = 'team' AND subject_id IN (${marks}))` : ''
    })`;
    return db.prepare(sql).all(now, userId, ...teams) as unknown as Row[];
  }

  /** Session ids an account reaches, with what it holds on each. */
  sessionsFor(userId: string, teams: string[], teamName: (id: string) => string): Map<string, HeldShare> {
    const out = new Map<string, HeldShare>();
    for (const r of this.#current(userId, teams)) {
      const prev = out.get(r.session_id);
      const caps = r.caps.split(',').filter(isSessionShareCap);
      const acts = caps.some((c) => c !== 'read');
      const via = r.subject_kind === 'user' ? 'you' : teamName(r.subject_id);
      if (!prev) {
        out.set(r.session_id, { caps, bypassAck: !acts || r.bypass_ack === 1, expiresAt: r.expires_at, via: [via] });
        continue;
      }
      const set = new Set([...prev.caps, ...caps]);
      prev.caps = SESSION_SHARE_CAPS.filter((c) => set.has(c));
      prev.bypassAck = prev.bypassAck && (!acts || r.bypass_ack === 1);
      prev.expiresAt = prev.expiresAt === null ? r.expires_at : r.expires_at === null ? prev.expiresAt : prev.expiresAt < r.expires_at ? prev.expiresAt : r.expires_at;
      prev.via.push(via);
    }
    return out;
  }

  /** What an account holds on one session, or null. */
  held(sessionId: string, userId: string, teams: string[], teamName: (id: string) => string = (id) => id): HeldShare | null {
    return this.sessionsFor(userId, teams, teamName).get(sessionId) ?? null;
  }

  removeUser(userId: string): void {
    this.writable()?.prepare("DELETE FROM session_shares WHERE subject_kind = 'user' AND subject_id = ?").run(userId);
  }
  removeTeam(teamId: string): void {
    this.writable()?.prepare("DELETE FROM session_shares WHERE subject_kind = 'team' AND subject_id = ?").run(teamId);
  }

  #rows(sql: string, args: string[], name: (s: ShareSubjectRef) => string = (s) => s.id): SessionShare[] {
    const rows = (this.db()?.prepare(sql).all(...args) ?? []) as unknown as Row[];
    return rows.map((r) => this.#view(r, name));
  }
}
