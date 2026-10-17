// Email accounts (owner, 2026-10-17: "multi user feature login by email"; T-118 MU1-min). An account is an email, a name and a scrypt hash
// (passwords.ts); checking one costs the same whether the email exists or not (a dummy hash), and failures are throttled per email and per
// address (throttle.ts, LOGIN_LIMITS). A good sign-in gives the caller nothing but "this account": app.ts then opens the same portal session
// the server code opens. Nothing here logs, stores or returns a password.

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import { EMAIL, IDENTITY_ERROR_CODES, normalizeEmail, type CreatePortalUserRequest, type PortalUser, type UpdatePortalUserRequest } from '@portal/contracts';
import './errors.js';
import { acceptNewPassword, normalizePassword, PasswordHasher, UNMATCHABLE_HASH } from './passwords.js';
import { fingerprint, Throttle } from './throttle.js';

interface Row {
  id: string;
  email: string;
  email_key: string;
  display_name: string;
  role: 'admin' | 'member';
  state: 'active' | 'disabled';
  password_hash: string;
  created_at: string;
  created_by: string;
  last_login_at: string | null;
}

const view = (r: Row): PortalUser => ({
  id: r.id,
  email: r.email,
  displayName: r.display_name,
  role: r.role,
  state: r.state,
  createdAt: r.created_at,
  createdBy: r.created_by,
  lastLoginAt: r.last_login_at,
});

/** The uniform refusal for a wrong email, a wrong password and a disabled account: it never says which. */
const WRONG = () => new AppError('UNAUTHORIZED', 'That email or password is not right.');

export class PortalUsers {
  readonly throttle: Throttle;

  /** `db` reads (roleOf, verify, list); `writable` writes (null while the store is frozen). Without `writable`, `db` is used for both. */
  constructor(
    private readonly db: () => DatabaseSync | null,
    readonly hasher: PasswordHasher = new PasswordHasher(),
    private readonly now: () => Date = () => new Date(),
    private readonly writable: () => DatabaseSync | null = db,
  ) {
    this.throttle = new Throttle(writable, () => this.now().getTime());
  }

  #db(): DatabaseSync {
    const db = this.db();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is not available.');
    return db;
  }

  #w(): DatabaseSync {
    const db = this.writable();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    return db;
  }

  #row(id: string): Row {
    const r = this.#db().prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new AppError('NOT_FOUND', 'No such account.');
    return r;
  }

  /** Whether any account can sign in (the sign-in page then offers email first). */
  any(): boolean {
    return !!this.db()?.prepare("SELECT 1 FROM users WHERE state = 'active' LIMIT 1").get();
  }

  list(): PortalUser[] {
    return (this.#db().prepare('SELECT * FROM users ORDER BY created_at').all() as unknown as Row[]).map(view);
  }

  async create(req: Partial<CreatePortalUserRequest>, by: string): Promise<PortalUser> {
    const email = typeof req.email === 'string' ? normalizeEmail(req.email) : '';
    if (!EMAIL.test(email) || email.length > 254) throw new AppError('VALIDATION_FAILED', 'Give a valid email address.', { details: { email: 'An email address.' } });
    const displayName = (typeof req.displayName === 'string' && req.displayName.trim() ? req.displayName.trim() : email.split('@')[0]!).slice(0, 60);
    const password = acceptNewPassword(req.password, { username: email.split('@')[0], displayName });
    if (this.#db().prepare('SELECT 1 FROM users WHERE email_key = ?').get(email))
      throw new AppError('CONFLICT', 'An account with that email exists.', { details: { email: 'Already used.' } });
    const hash = await this.hasher.hash(password);
    // Review #2: default deny: only an explicit 'admin' makes an admin.
    const role = req.role === 'admin' ? 'admin' : 'member';
    const id = `u_${randomBytes(9).toString('base64url')}`;
    const at = this.now().toISOString();
    try {
      this.#w()
        .prepare('INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, email, email, displayName, role, 'active', hash, at, at, by);
    } catch (e) {
      // Review #9: two creates of one email at once: the unique index refuses the second; answer 409, not 500.
      if (/UNIQUE/i.test(String((e as Error).message))) throw new AppError('CONFLICT', 'An account with that email exists.', { details: { email: 'Already used.' } });
      throw e;
    }
    return view(this.#row(id));
  }

  async update(id: string, req: Partial<UpdatePortalUserRequest>): Promise<PortalUser> {
    const r = this.#row(id);
    // Review #9: the password is checked and hashed BEFORE anything is written, then every change lands in one transaction.
    const hash =
      req.password !== undefined ? await this.hasher.hash(acceptNewPassword(req.password, { username: r.email.split('@')[0], displayName: r.display_name })) : null;
    const db = this.#w();
    const at = this.now().toISOString();
    db.exec('BEGIN');
    try {
      if (req.role === 'admin' || req.role === 'member') db.prepare('UPDATE users SET role = ? WHERE id = ?').run(req.role, id);
      if (typeof req.displayName === 'string' && req.displayName.trim()) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(req.displayName.trim().slice(0, 60), id);
      if (req.state === 'active' || req.state === 'disabled') db.prepare('UPDATE users SET state = ?, disabled_at = ? WHERE id = ?').run(req.state, req.state === 'disabled' ? at : null, id);
      if (hash) db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(hash, at, id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return view(this.#row(id));
  }

  /** What the account is now (portal.roleOf): its role while active, 'disabled', or null when it is gone. Read on every request. */
  roleOf(id: string): 'admin' | 'member' | 'disabled' | null {
    const r = this.db()?.prepare('SELECT role, state FROM users WHERE id = ?').get(id) as { role: 'admin' | 'member'; state: string } | undefined;
    if (!r) return null;
    return r.state === 'active' ? r.role : 'disabled';
  }

  /** One account as its own holder sees it. */
  get(id: string): PortalUser {
    return view(this.#row(id));
  }

  remove(id: string): void {
    this.#row(id);
    this.#w().prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  /**
   * Checks an email and a password. Throttled per email (existing or not) and per address before any hash; an unknown email costs one
   * full hash too; a wrong one, an unknown one and a disabled account give the same refusal. Returns the account on success.
   */
  async verify(rawEmail: unknown, rawPassword: unknown, address: string): Promise<PortalUser> {
    const email = typeof rawEmail === 'string' ? normalizeEmail(rawEmail) : '';
    const userKey = fingerprint(email);
    const ipKey = fingerprint(address || 'unknown');
    this.throttle.assertOpen('ip', ipKey);
    this.throttle.assertOpen('user', userKey);
    const password = normalizePassword(rawPassword);
    const r = EMAIL.test(email) ? (this.#db().prepare('SELECT * FROM users WHERE email_key = ?').get(email) as Row | undefined) : undefined;
    const { ok } = await this.hasher.verify(password ?? 'x', r?.password_hash ?? UNMATCHABLE_HASH);
    if (!ok || !r || !password || r.state !== 'active') {
      this.throttle.fail('user', userKey);
      this.throttle.fail('ip', ipKey);
      throw WRONG();
    }
    this.throttle.reset('user', userKey);
    this.writable()?.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(this.now().toISOString(), r.id);
    return view(this.#row(r.id));
  }
}

export { IDENTITY_ERROR_CODES };
