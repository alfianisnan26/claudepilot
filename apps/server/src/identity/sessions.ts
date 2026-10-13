// Login sessions (identity PRD §9, FR24, FR28 to FR34, decision D4): rows of `login_sessions`, looked up by the SHA-256 of the cookie's
// 256-bit token on every request and every socket handshake. Nothing is cached beyond the request, so a revocation by an admin or the CLI
// is effective at once and the socket sweep cuts the connection. While the store is Frozen (read-only) a sign-in lives in memory until
// the next restart (FR8), as the old code login did.

import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { SESSION_LIFETIME, type LoginSession, type UserState } from '@portal/contracts';
import { deviceLabel } from './devices.js';

export const COOKIE_NAME = 'portal_session';
/** The same cookie, prefixed, when the request is HTTPS: a `__Host-` cookie cannot be set by a subdomain or over plain HTTP (FR24). */
export const HOST_COOKIE_NAME = `__Host-${COOKIE_NAME}`;
/** A first-party client's bearer token (FR51): `cppt_` plus 256 bits. */
export const CLIENT_TOKEN_PREFIX = 'cppt_';

/** `last_seen_at` is written at most this often (FR30). */
const TOUCH_MS = 60_000;

export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
export const newToken = (): string => randomBytes(32).toString('base64url');
const newSessionId = (): string => `ls_${randomBytes(9).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x')}`;

export interface SessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  absolute_expires_at: string;
  kept: number;
  reauth_at: string | null;
  ip: string | null;
  user_agent: string | null;
  device: string | null;
  client: string | null;
  token_epoch: number;
}

/** A sign-in as the rest of the server sees it: who, which row, and whether it still counts as a fresh password check. */
export interface ResolvedSession {
  id: string;
  userId: string;
  role: 'admin' | 'member';
  client: string | null;
  kept: boolean;
  createdAt: number;
  expiresAt: number;
  reauthAt: number | null;
  tokenEpoch: number;
}

export interface NewSession {
  userId: string;
  tokenEpoch: number;
  kept?: boolean;
  ip?: string | null;
  userAgent?: string | null;
  /** `vscode`, `cli`: a first-party client's sign-in (FR51), which carries a bearer token instead of a cookie. */
  client?: string | null;
}

const COLUMNS = 'id, token_hash, user_id, created_at, last_seen_at, expires_at, absolute_expires_at, kept, reauth_at, ip, user_agent, device, client, token_epoch';

export class LoginSessions {
  /** Sign-ins made while the store was read-only: kept until the next restart (FR8). */
  readonly #memory = new Map<string, SessionRow>();

  constructor(
    private readonly store: { db: DatabaseSync | null; writable: boolean },
    private readonly userState: (userId: string) => { state: UserState; role: 'admin' | 'member'; tokenEpoch: number } | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  #writable(): DatabaseSync | null {
    return this.store.writable ? this.store.db : null;
  }

  /** Makes a sign-in and returns the token for the cookie (shown once, never stored). */
  create(s: NewSession): { token: string; session: SessionRow } {
    const token = s.client ? `${CLIENT_TOKEN_PREFIX}${newToken()}` : newToken();
    const now = this.now();
    const kept = !!s.kept;
    const idle = kept ? SESSION_LIFETIME.keptIdleMs : SESSION_LIFETIME.shortMs;
    const absolute = kept ? SESSION_LIFETIME.keptAbsoluteMs : SESSION_LIFETIME.shortMs;
    const row: SessionRow = {
      id: newSessionId(),
      token_hash: tokenHash(token),
      user_id: s.userId,
      created_at: new Date(now).toISOString(),
      last_seen_at: new Date(now).toISOString(),
      expires_at: new Date(now + idle).toISOString(),
      absolute_expires_at: new Date(now + absolute).toISOString(),
      kept: kept ? 1 : 0,
      reauth_at: null,
      ip: s.ip ?? null,
      user_agent: (s.userAgent ?? '').slice(0, 300) || null,
      device: deviceLabel(s.userAgent),
      client: s.client ?? null,
      token_epoch: s.tokenEpoch,
    };
    const db = this.#writable();
    if (db) {
      db.prepare(`INSERT INTO login_sessions (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.id, row.token_hash, row.user_id, row.created_at, row.last_seen_at, row.expires_at, row.absolute_expires_at, row.kept, row.reauth_at, row.ip, row.user_agent, row.device, row.client, row.token_epoch,
      );
    } else this.#memory.set(row.token_hash, row);
    return { token, session: row };
  }

  #rowByHash(hash: string): SessionRow | undefined {
    return this.#memory.get(hash) ?? (this.store.db?.prepare(`SELECT ${COLUMNS} FROM login_sessions WHERE token_hash = ?`).get(hash) as SessionRow | undefined);
  }

  #delete(hash: string): void {
    this.#memory.delete(hash);
    this.#writable()?.prepare('DELETE FROM login_sessions WHERE token_hash = ?').run(hash);
  }

  /**
   * The sign-in a token stands for, or undefined: unknown, expired (idle or absolute), its user not active, or the user's epoch moved past
   * it (a reset, a restore). A dead row is deleted on the way. `last_seen_at` is extended at most once a minute, and a kept session's idle
   * expiry slides with it.
   */
  resolve(token: string | undefined, opts: { touch?: boolean } = {}): ResolvedSession | undefined {
    if (!token || token.length > 400) return undefined;
    const hash = tokenHash(token);
    const row = this.#rowByHash(hash);
    if (!row) return undefined;
    const now = this.now();
    const expiresAt = Math.min(Date.parse(row.expires_at), Date.parse(row.absolute_expires_at));
    if (!(expiresAt > now)) return void this.#delete(hash);
    const user = this.userState(row.user_id);
    if (!user || user.state !== 'active' || user.tokenEpoch !== row.token_epoch) return void this.#delete(hash);
    if (opts.touch !== false && now - Date.parse(row.last_seen_at) >= TOUCH_MS) {
      const seen = new Date(now).toISOString();
      const slide = row.kept ? new Date(Math.min(now + SESSION_LIFETIME.keptIdleMs, Date.parse(row.absolute_expires_at))).toISOString() : row.expires_at;
      row.last_seen_at = seen;
      row.expires_at = slide;
      this.#writable()?.prepare('UPDATE login_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(seen, slide, hash);
    }
    return {
      id: row.id,
      userId: row.user_id,
      role: user.role,
      client: row.client,
      kept: !!row.kept,
      createdAt: Date.parse(row.created_at),
      expiresAt,
      reauthAt: row.reauth_at ? Date.parse(row.reauth_at) : null,
      tokenEpoch: row.token_epoch,
    };
  }

  /** The person's sign-ins, newest first, for the device list (FR30). Never the token hash. */
  listFor(userId: string, currentId: string | null): LoginSession[] {
    const rows = [...(this.store.db?.prepare(`SELECT ${COLUMNS} FROM login_sessions WHERE user_id = ? ORDER BY created_at DESC`).all(userId) as SessionRow[] | undefined) ?? []];
    for (const r of this.#memory.values()) if (r.user_id === userId) rows.unshift(r);
    const now = this.now();
    return rows
      .filter((r) => Math.min(Date.parse(r.expires_at), Date.parse(r.absolute_expires_at)) > now)
      .map((r) => ({
        id: r.id,
        current: r.id === currentId,
        device: r.device ?? 'Unknown device',
        ip: r.ip,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        expiresAt: new Date(Math.min(Date.parse(r.expires_at), Date.parse(r.absolute_expires_at))).toISOString(),
        kept: !!r.kept,
        client: r.client,
      }));
  }

  /** Ends one sign-in of the person by its id (a device revoke). True when it existed. */
  revoke(userId: string, id: string): boolean {
    for (const [hash, r] of this.#memory) if (r.user_id === userId && r.id === id) return this.#memory.delete(hash);
    return Number(this.#writable()?.prepare('DELETE FROM login_sessions WHERE user_id = ? AND id = ?').run(userId, id).changes ?? 0) > 0;
  }

  /** Ends every sign-in of the person except `keepId` (null: all of them). Returns how many ended. */
  revokeAll(userId: string, keepId: string | null = null): number {
    let n = 0;
    for (const [hash, r] of this.#memory) if (r.user_id === userId && r.id !== keepId) n += Number(this.#memory.delete(hash));
    const db = this.#writable();
    if (db) n += Number(keepId ? db.prepare('DELETE FROM login_sessions WHERE user_id = ? AND id <> ?').run(userId, keepId).changes : db.prepare('DELETE FROM login_sessions WHERE user_id = ?').run(userId).changes);
    return n;
  }

  /** Ends the sign-in a cookie stands for (sign-out). */
  end(token: string | undefined): SessionRow | undefined {
    if (!token) return undefined;
    const hash = tokenHash(token);
    const row = this.#rowByHash(hash);
    if (row) this.#delete(hash);
    return row;
  }

  /** Marks a recent password check on the sign-in (FR21). */
  markReauth(id: string): void {
    const at = new Date(this.now()).toISOString();
    for (const r of this.#memory.values()) if (r.id === id) r.reauth_at = at;
    this.#writable()?.prepare('UPDATE login_sessions SET reauth_at = ? WHERE id = ?').run(at, id);
  }

  /** Whether the sign-in checked the password within the window. */
  reauthFresh(s: Pick<ResolvedSession, 'reauthAt'> | undefined): boolean {
    return !!s?.reauthAt && this.now() - s.reauthAt <= SESSION_LIFETIME.reauthMs;
  }

  /** Until when a recent check counts, for `Me.reauthUntil`. */
  reauthUntil(s: Pick<ResolvedSession, 'reauthAt'> | undefined): string | null {
    return this.reauthFresh(s) ? new Date(s!.reauthAt! + SESSION_LIFETIME.reauthMs).toISOString() : null;
  }

  /** Every sign-in of everyone ends (a restore, FR55). */
  clearAll(): number {
    this.#memory.clear();
    return Number(this.#writable()?.prepare('DELETE FROM login_sessions').run().changes ?? 0);
  }

  /** Expired rows go. */
  sweep(): number {
    const iso = new Date(this.now()).toISOString();
    for (const [hash, r] of this.#memory) if (Math.min(Date.parse(r.expires_at), Date.parse(r.absolute_expires_at)) <= this.now()) this.#memory.delete(hash);
    return Number(this.#writable()?.prepare('DELETE FROM login_sessions WHERE expires_at <= ? OR absolute_expires_at <= ?').run(iso, iso).changes ?? 0);
  }

  /** How many sign-ins the person has (an admin sees counts only, FR36). */
  countFor(userId: string): number {
    const iso = new Date(this.now()).toISOString();
    return Number((this.store.db?.prepare('SELECT count(*) AS n FROM login_sessions WHERE user_id = ? AND expires_at > ? AND absolute_expires_at > ?').get(userId, iso, iso) as { n: number } | undefined)?.n ?? 0);
  }
}

/** The cookie's value from a Cookie header: the `__Host-` name first, then the plain one (sockets and requests accept either, FR24). */
export function sessionCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  let plain: string | undefined;
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === HOST_COOKIE_NAME || k === COOKIE_NAME) {
      let value: string;
      try {
        value = decodeURIComponent(v.join('='));
      } catch {
        continue;
      }
      if (k === HOST_COOKIE_NAME) return value;
      plain ??= value;
    }
  }
  return plain;
}
