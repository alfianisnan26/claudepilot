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

  constructor(
    private readonly db: () => DatabaseSync | null,
    readonly hasher: PasswordHasher = new PasswordHasher(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.throttle = new Throttle(db, () => this.now().getTime());
  }

  #db(): DatabaseSync {
    const db = this.db();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is not available.');
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
    if (!EMAIL.test(email)) throw new AppError('VALIDATION_FAILED', 'Give a valid email address.', { details: { email: 'An email address.' } });
    const displayName = (typeof req.displayName === 'string' && req.displayName.trim() ? req.displayName.trim() : email.split('@')[0]!).slice(0, 60);
    const password = acceptNewPassword(req.password, { username: email.split('@')[0], displayName });
    if (this.#db().prepare('SELECT 1 FROM users WHERE email_key = ?').get(email))
      throw new AppError('CONFLICT', 'An account with that email exists.', { details: { email: 'Already used.' } });
    const hash = await this.hasher.hash(password);
    const id = `u_${randomBytes(9).toString('base64url')}`;
    const at = this.now().toISOString();
    this.#db()
      .prepare('INSERT INTO users (id, email, email_key, display_name, role, state, password_hash, password_changed_at, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, email, email, displayName, 'admin', 'active', hash, at, at, by);
    return view(this.#row(id));
  }

  async update(id: string, req: Partial<UpdatePortalUserRequest>): Promise<PortalUser> {
    const r = this.#row(id);
    if (typeof req.displayName === 'string' && req.displayName.trim())
      this.#db().prepare('UPDATE users SET display_name = ? WHERE id = ?').run(req.displayName.trim().slice(0, 60), id);
    if (req.state === 'active' || req.state === 'disabled')
      this.#db().prepare('UPDATE users SET state = ?, disabled_at = ? WHERE id = ?').run(req.state, req.state === 'disabled' ? this.now().toISOString() : null, id);
    if (req.password !== undefined) {
      const password = acceptNewPassword(req.password, { username: r.email.split('@')[0], displayName: r.display_name });
      this.#db().prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(await this.hasher.hash(password), this.now().toISOString(), id);
    }
    return view(this.#row(id));
  }

  remove(id: string): void {
    this.#row(id);
    this.#db().prepare('DELETE FROM users WHERE id = ?').run(id);
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
    this.#db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(this.now().toISOString(), r.id);
    return view(this.#row(r.id));
  }
}

export { IDENTITY_ERROR_CODES };
