// Accounts (identity PRD §6 to §10, §13): the `users` table and nothing else. Every write goes through here, so the invariants hold in one
// place: one account per `username_key`, the reserved names, the display-name rules, and the last-admin triggers' `LAST_ADMIN` surfacing as
// a 409. A password hash enters and leaves this file only as an opaque string for passwords.ts.

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import {
  DISPLAY_NAME_MAX,
  FOUNDING_USER_ID,
  IDENTITY_ERROR_CODES,
  normalizeUsername,
  usernameProblem,
  type User,
  type UserRole,
  type UserState,
  type UserSummary,
} from '@portal/contracts';
import './errors.js';

export interface UserRow {
  id: string;
  username: string;
  username_key: string;
  display_name: string;
  role: UserRole;
  state: UserState;
  password_hash: string;
  password_changed_at: string;
  avatar_sha256: string | null;
  token_epoch: number;
  created_at: string;
  created_by: string;
  last_login_at: string | null;
  disabled_at: string | null;
  disabled_by: string | null;
  disabled_reason: string | null;
}

const COLUMNS = 'id, username, username_key, display_name, role, state, password_hash, password_changed_at, avatar_sha256, token_epoch, created_at, created_by, last_login_at, disabled_at, disabled_by, disabled_reason';

/** A new user id: `u_` plus 20 base32-ish characters of randomness (no creation time inside, unlike a UUIDv7). */
export const newUserId = (): string => `u_${randomBytes(15).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)}`;

/** Checks a username for the wire: format, reserved, taken -> `USERNAME_UNAVAILABLE` (one answer for taken and reserved, FR15). */
export function checkUsername(raw: unknown): { username: string; key: string } {
  if (typeof raw !== 'string') throw new AppError('VALIDATION_FAILED', 'Choose a username.', { details: { username: 'Required.' } });
  const problem = usernameProblem(raw);
  if (problem === 'format') throw new AppError('VALIDATION_FAILED', 'A username is 3 to 32 letters, digits, dots, underscores or dashes, starting with a letter.', { details: { username: 'format' } });
  if (problem === 'reserved') throw new AppError(IDENTITY_ERROR_CODES.USERNAME_UNAVAILABLE, 'That username isn’t available.');
  const username = raw.normalize('NFKC').trim();
  return { username, key: normalizeUsername(username) };
}

/** 1 to 60 characters, plain text, NFC, no control characters (FR15). */
export function checkDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') throw new AppError('VALIDATION_FAILED', 'Enter a name.', { details: { displayName: 'Required.' } });
  const name = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim();
  if (!name || [...name].length > DISPLAY_NAME_MAX) throw new AppError('VALIDATION_FAILED', `A name is 1 to ${DISPLAY_NAME_MAX} characters.`, { details: { displayName: 'length' } });
  return name;
}

export const toSummary = (r: UserRow): UserSummary => ({ id: r.id, username: r.username, displayName: r.display_name, avatar: r.avatar_sha256 });

export class Users {
  constructor(
    private readonly db: () => DatabaseSync | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  #db(): DatabaseSync {
    const db = this.db();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The database is not available.');
    return db;
  }

  /** Whether any account exists at all: setup mode is `!any()` (FR1). */
  any(): boolean {
    const db = this.db();
    return !!db && !!db.prepare('SELECT 1 FROM users LIMIT 1').get();
  }

  /** Accounts that were not made by the dev seed: what makes the seed refuse to start (FR44). */
  anyReal(): boolean {
    const db = this.db();
    return !!db && !!db.prepare("SELECT 1 FROM users WHERE created_by <> 'dev-seed' LIMIT 1").get();
  }

  get(id: string): UserRow | undefined {
    return this.db()?.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id) as UserRow | undefined;
  }

  byUsername(raw: string): UserRow | undefined {
    return this.db()?.prepare(`SELECT ${COLUMNS} FROM users WHERE username_key = ?`).get(normalizeUsername(raw)) as UserRow | undefined;
  }

  list(filter: { state?: UserState } = {}): UserRow[] {
    const db = this.db();
    if (!db) return [];
    if (filter.state) return db.prepare(`SELECT ${COLUMNS} FROM users WHERE state = ? ORDER BY created_at, id`).all(filter.state) as UserRow[];
    return db.prepare(`SELECT ${COLUMNS} FROM users ORDER BY created_at, id`).all() as UserRow[];
  }

  countActiveAdmins(): number {
    return Number((this.db()?.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin' AND state = 'active'").get() as { n: number } | undefined)?.n ?? 0);
  }

  /**
   * Inserts an account. `USERNAME_UNAVAILABLE` when the key is taken (the unique index decides, so two parallel inserts cannot both win).
   * The caller runs this inside its own transaction when more than the row must hold together (setup, an invitation).
   */
  insert(u: { id?: string; username: string; displayName: string; role: UserRole; state: UserState; passwordHash: string; createdBy: string }): UserRow {
    const { username, key } = checkUsername(u.username);
    const displayName = checkDisplayName(u.displayName);
    const id = u.id ?? newUserId();
    const at = this.now().toISOString();
    try {
      this.#db()
        .prepare('INSERT INTO users (id, username, username_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, username, key, displayName, u.role, u.state, u.passwordHash, at, at, u.createdBy);
    } catch (e) {
      if (/UNIQUE constraint failed: users\.(username_key|id)/.test((e as Error).message)) throw new AppError(IDENTITY_ERROR_CODES.USERNAME_UNAVAILABLE, 'That username isn’t available.');
      throw e;
    }
    return this.get(id)!;
  }

  /** Any column change; the last-admin triggers answer `LAST_ADMIN` (409). */
  #update(id: string, set: Record<string, string | number | null>): void {
    const keys = Object.keys(set);
    if (!keys.length) return;
    try {
      const r = this.#db().prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k]!), id);
      if (Number(r.changes) === 0) throw new AppError('NOT_FOUND', 'Not found.');
    } catch (e) {
      if (/LAST_ADMIN/.test((e as Error).message)) throw new AppError(IDENTITY_ERROR_CODES.LAST_ADMIN, 'The last admin can’t be removed.');
      throw e;
    }
  }

  setPassword(id: string, passwordHash: string, opts: { bumpEpoch?: boolean } = {}): void {
    const set: Record<string, string | number | null> = { password_hash: passwordHash, password_changed_at: this.now().toISOString() };
    this.#update(id, set);
    if (opts.bumpEpoch) this.bumpEpoch(id);
  }

  /** Kills the person's Portal MCP tokens and agent tokens at their next call (FR22, FR23, FR32). */
  bumpEpoch(id: string): number {
    this.#db().prepare('UPDATE users SET token_epoch = token_epoch + 1 WHERE id = ?').run(id);
    return this.get(id)?.token_epoch ?? 0;
  }

  /** Every user's epoch moves: what a restore does (FR55). */
  bumpAllEpochs(): void {
    this.#db().prepare('UPDATE users SET token_epoch = token_epoch + 1').run();
  }

  touchLogin(id: string): void {
    this.#update(id, { last_login_at: this.now().toISOString() });
  }

  setProfile(id: string, p: { displayName?: string; avatar?: string | null }): void {
    const set: Record<string, string | number | null> = {};
    if (p.displayName !== undefined) set.display_name = checkDisplayName(p.displayName);
    if (p.avatar !== undefined) set.avatar_sha256 = p.avatar;
    this.#update(id, set);
  }

  setRole(id: string, role: UserRole): void {
    if (role !== 'admin' && role !== 'member') throw new AppError('VALIDATION_FAILED', 'A role is admin or member.', { details: { role: 'invalid' } });
    this.#update(id, { role });
  }

  disable(id: string, by: string, reason: string | null): void {
    this.#update(id, { state: 'disabled', disabled_at: this.now().toISOString(), disabled_by: by, disabled_reason: reason });
  }

  /** Enabling restores sign-in only: old tokens stay dead (the epoch moved when it was disabled). */
  enable(id: string): void {
    this.#update(id, { state: 'active', disabled_at: null, disabled_by: null, disabled_reason: null });
  }

  /** A pending registration becomes an account (FR14). */
  approve(id: string): void {
    this.#update(id, { state: 'active', role: 'member' });
  }

  /** A pending registration rejected, or a disabled user who owns nothing deleted (FR35). The triggers keep the last admin. */
  delete(id: string): void {
    try {
      this.#db().prepare('DELETE FROM users WHERE id = ?').run(id);
    } catch (e) {
      if (/LAST_ADMIN/.test((e as Error).message)) throw new AppError(IDENTITY_ERROR_CODES.LAST_ADMIN, 'The last admin can’t be removed.');
      throw e;
    }
  }

  /** Pending sign-ups older than 14 days go (FR13). */
  sweepPending(maxAgeMs: number): number {
    const db = this.db();
    if (!db) return 0;
    return Number(db.prepare("DELETE FROM users WHERE state = 'pending' AND created_at < ?").run(new Date(this.now().getTime() - maxAgeMs).toISOString()).changes);
  }

  countPending(): number {
    return Number((this.db()?.prepare("SELECT count(*) AS n FROM users WHERE state = 'pending'").get() as { n: number } | undefined)?.n ?? 0);
  }

  /** The wire shape an admin (or the person) sees. `resetPending` is told by invitations.ts; the hash never leaves. */
  toUser(r: UserRow, resetPending: boolean): User {
    return {
      ...toSummary(r),
      role: r.role,
      state: r.state,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      passwordChangedAt: r.password_changed_at,
      resetPending,
      disabledAt: r.disabled_at,
      disabledReason: r.disabled_reason,
      createdBy: r.created_by,
    };
  }
}

export { FOUNDING_USER_ID };
