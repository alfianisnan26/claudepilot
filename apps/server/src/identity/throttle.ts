// Attempt limits (identity PRD FR20, I1 to I3, I5, I7, I8, decision D5): counters are rows of `auth_throttle`, so a restart does not
// reset them; a blocked key is also held in memory until its block ends, so a flood from a blocked address costs no database write.
//
// Two shapes of limit:
// - `lockout` (per username, per address): failures in a window; at the threshold the key locks, and for the per-username scope each
//   further failure doubles the lock up to a ceiling while failures continue (the window restarts at every lock, so the attacker has to
//   stay away for the whole window to start over). Attempts made while locked are answered 429 before anything else and are not counted.
// - `quota` (registration, invitation redemptions, lookups): at most N events per window; the (N+1)th is refused.
//
// Hand-computed table for the per-username scope (5 failures in 15 min, 30 s base, 15 min ceiling): failure 5 -> 30 s, 6 -> 60 s,
// 7 -> 120 s, 8 -> 240 s, 9 -> 480 s, 10 -> 900 s, 11 and on -> 900 s. Per address: 20 failures in 10 min -> 10 min, flat.

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import { IDENTITY_ERROR_CODES, LOGIN_LIMITS } from '@portal/contracts';
import './errors.js';

export type ThrottleScope = 'user' | 'ip' | 'register' | 'invitation' | 'reauth' | 'lookup' | 'share' | 'team_invite';

export interface LockoutRule {
  failures: number;
  windowMs: number;
  baseLockMs: number;
  maxLockMs: number;
}

export const LOCKOUT_RULES: Record<'user' | 'ip' | 'reauth', LockoutRule> = {
  user: { failures: LOGIN_LIMITS.perUser.failures, windowMs: LOGIN_LIMITS.perUser.windowMs, baseLockMs: LOGIN_LIMITS.perUser.baseLockMs, maxLockMs: LOGIN_LIMITS.perUser.maxLockMs },
  ip: { failures: LOGIN_LIMITS.perIp.failures, windowMs: LOGIN_LIMITS.perIp.windowMs, baseLockMs: LOGIN_LIMITS.perIp.lockMs, maxLockMs: LOGIN_LIMITS.perIp.lockMs },
  // Per sign-in session: a stolen cookie cannot guess the password faster than the sign-in screen allows (FR21).
  reauth: { failures: LOGIN_LIMITS.reauth.failures, windowMs: LOGIN_LIMITS.reauth.windowMs, baseLockMs: LOGIN_LIMITS.reauth.windowMs, maxLockMs: LOGIN_LIMITS.reauth.windowMs },
};

/** The lock a key gets at its n-th failure of the window (n >= threshold), the PRD's doubling with a ceiling. */
export function lockMsFor(rule: LockoutRule, failures: number): number {
  if (failures < rule.failures) return 0;
  return Math.min(rule.maxLockMs, rule.baseLockMs * 2 ** (failures - rule.failures));
}

/** A username never goes into the table as typed: the key is a fingerprint, so a password pasted into the name field is never stored (I19). */
export const fingerprint = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 32);

interface Row {
  failures: number;
  window_start_ms: number;
  locked_until_ms: number;
}

const MAX_MEMORY_KEYS = 20_000;

export class Throttle {
  /** Blocked keys, until when: answered without a read (`scope:key` -> ms). */
  readonly #blocked = new Map<string, number>();

  constructor(
    private readonly db: () => DatabaseSync | null,
    private readonly now: () => number = Date.now,
  ) {}

  #row(scope: ThrottleScope, key: string): Row | undefined {
    return this.db()?.prepare('SELECT failures, window_start_ms, locked_until_ms FROM auth_throttle WHERE scope = ? AND key = ?').get(scope, key) as Row | undefined;
  }

  #write(scope: ThrottleScope, key: string, row: Row) {
    this.db()
      ?.prepare(
        'INSERT INTO auth_throttle (scope, key, failures, window_start_ms, locked_until_ms, updated_ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (scope, key) DO UPDATE SET failures = excluded.failures, window_start_ms = excluded.window_start_ms, locked_until_ms = excluded.locked_until_ms, updated_ms = excluded.updated_ms',
      )
      .run(scope, key, row.failures, row.window_start_ms, row.locked_until_ms, this.now());
  }

  #remember(scope: ThrottleScope, key: string, until: number) {
    if (this.#blocked.size >= MAX_MEMORY_KEYS) {
      const now = this.now();
      for (const [k, t] of this.#blocked) if (t <= now) this.#blocked.delete(k);
      if (this.#blocked.size >= MAX_MEMORY_KEYS) this.#blocked.delete(this.#blocked.keys().next().value!);
    }
    this.#blocked.set(`${scope}:${key}`, until);
  }

  /** Seconds a locked key must still wait, or 0. Memory first, then the table. */
  retryAfter(scope: ThrottleScope, key: string): number {
    const now = this.now();
    const remembered = this.#blocked.get(`${scope}:${key}`);
    if (remembered !== undefined) {
      if (remembered > now) return Math.ceil((remembered - now) / 1000);
      this.#blocked.delete(`${scope}:${key}`);
    }
    const row = this.#row(scope, key);
    if (row && row.locked_until_ms > now) {
      this.#remember(scope, key, row.locked_until_ms);
      return Math.ceil((row.locked_until_ms - now) / 1000);
    }
    return 0;
  }

  /** Throws `LOCKED_OUT` (429, `Retry-After`) when the key is locked. The same answer whether or not the account exists. */
  assertOpen(scope: ThrottleScope, key: string): void {
    const wait = this.retryAfter(scope, key);
    if (wait > 0) throw new AppError(IDENTITY_ERROR_CODES.LOCKED_OUT, `Too many tries. Try again in ${wait > 90 ? `${Math.ceil(wait / 60)} minutes` : `${wait} seconds`}.`, { details: { retryAfter: wait } });
  }

  /** Counts one failure. Returns the lock it caused in ms (0 when none): the caller audits `auth.lockout` when a lock starts. */
  fail(scope: 'user' | 'ip' | 'reauth', key: string, rule: LockoutRule = LOCKOUT_RULES[scope]): number {
    const now = this.now();
    const row = this.#row(scope, key);
    const fresh = !row || now - row.window_start_ms > rule.windowMs;
    const failures = fresh ? 1 : row.failures + 1;
    const lockMs = lockMsFor(rule, failures);
    const next: Row = { failures, window_start_ms: fresh || lockMs > 0 ? now : row.window_start_ms, locked_until_ms: lockMs > 0 ? now + lockMs : 0 };
    this.#write(scope, key, next);
    if (lockMs > 0) this.#remember(scope, key, next.locked_until_ms);
    return lockMs;
  }

  /** A success: the key starts over (and an admin's reset clears a lock the same way, I6). */
  reset(scope: ThrottleScope, key: string): void {
    this.#blocked.delete(`${scope}:${key}`);
    this.db()?.prepare('DELETE FROM auth_throttle WHERE scope = ? AND key = ?').run(scope, key);
  }

  /**
   * A quota: counts one event and says whether it was within `limit` per `windowMs` (the first `limit` are allowed, the next refused until
   * the window passes). `weight` counts an event several times (a lookup miss counts double, I5).
   */
  take(scope: ThrottleScope, key: string, limit: number, windowMs: number, weight = 1): boolean {
    const now = this.now();
    const row = this.#row(scope, key);
    const fresh = !row || now - row.window_start_ms > windowMs;
    const used = (fresh ? 0 : row.failures) + weight;
    this.#write(scope, key, { failures: used, window_start_ms: fresh ? now : row.window_start_ms, locked_until_ms: 0 });
    return used <= limit;
  }

  /** Throws `LOCKED_OUT` when the quota is spent. */
  assertQuota(scope: ThrottleScope, key: string, limit: number, windowMs: number, weight = 1): void {
    if (!this.take(scope, key, limit, windowMs, weight)) {
      const row = this.#row(scope, key);
      const wait = Math.max(1, Math.ceil(((row?.window_start_ms ?? this.now()) + windowMs - this.now()) / 1000));
      throw new AppError(IDENTITY_ERROR_CODES.LOCKED_OUT, 'Too many requests. Try again later.', { details: { retryAfter: wait } });
    }
  }

  /** Rows whose window and lock are long over (a day) go; called by the identity sweep. */
  sweep(): number {
    const db = this.db();
    if (!db) return 0;
    const cutoff = this.now() - 24 * 60 * 60 * 1000;
    return Number(db.prepare('DELETE FROM auth_throttle WHERE updated_ms < ? AND locked_until_ms < ?').run(cutoff, this.now()).changes);
  }
}
