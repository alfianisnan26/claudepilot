// Per-user abilities (docs/prd/organizations.md §6.11, OD-2): what an instance admin grants a person one by one, off by default. Today there
// is one, `orgs.create` (POST /api/orgs checks it). An instance admin (role = admin, read on every use through the seam) holds every ability
// without a row. Granting and revoking are for a PERSON who is an instance admin (never a token or an agent) and write the platform audit; the
// Admin console (slice 4) exposes them behind its own session and step-up. A disabled or removed account holds no ability, whatever its rows say.

import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import { ABILITIES, FOUNDING_USER_ID, actorString, isAbility, isUserId, platformRef, type Ability, type Actor, type UserAbility, type UserId } from '@portal/contracts';
import { isPlatformAdmin, requireCan } from '../authz/seam.js';
import type { AuditInput } from '../platform/audit.js';

export interface AbilitiesDeps {
  db: () => DatabaseSync | null;
  writable?: () => DatabaseSync | null;
  audit: (e: AuditInput) => void;
  now?: () => Date;
}

/** A person (a signed-in user) who is an instance admin; anything else is refused the way the platform refuses (403 platform_only, 404 for a token). */
export function requireInstanceAdmin(actor: Actor): asserts actor is Actor & { kind: 'user' } {
  if (actor.kind !== 'user') throw new AppError('NOT_FOUND', 'Not found.');
  requireCan(actor, 'manage', platformRef('users'));
}

export class UserAbilities {
  readonly #db: () => DatabaseSync | null;
  readonly #w: () => DatabaseSync | null;
  readonly #audit: (e: AuditInput) => void;
  readonly #now: () => Date;

  constructor(deps: AbilitiesDeps) {
    this.#db = deps.db;
    this.#w = deps.writable ?? deps.db;
    this.#audit = deps.audit;
    this.#now = deps.now ?? (() => new Date());
  }

  #read(): DatabaseSync {
    const db = this.#db();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is not available.');
    return db;
  }
  #write(): DatabaseSync {
    const db = this.#w();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    return db;
  }

  /** Whether the user holds the ability by a ROW, and the account is active. Fails closed (false) when the database cannot be read. */
  holds(userId: UserId, ability: Ability): boolean {
    if (!isUserId(userId) || !isAbility(ability)) return false;
    try {
      return !!this.#db()
        ?.prepare("SELECT 1 FROM user_abilities a JOIN users u ON u.id = a.user_id WHERE a.user_id = ? AND a.ability = ? AND u.state = 'active'")
        .get(userId, ability);
    } catch {
      return false;
    }
  }

  /** Whether the user may do what the ability allows: an instance admin always, anyone else by a row (`holds`). */
  may(userId: UserId, ability: Ability): boolean {
    return isPlatformAdmin(userId) || this.holds(userId, ability);
  }

  /** The abilities one account holds by a row (for the Admin console's user page). Instance admins only. */
  of(actor: Actor, userId: UserId): UserAbility[] {
    requireInstanceAdmin(actor);
    return this.#rows('WHERE user_id = ?', userId);
  }

  /** Every row of one ability (the Admin console's Abilities screen). Instance admins only. */
  list(actor: Actor, ability?: Ability): UserAbility[] {
    requireInstanceAdmin(actor);
    if (ability !== undefined && !isAbility(ability)) throw new AppError('VALIDATION_FAILED', 'Unknown ability.', { details: { ability: 'Unknown.' } });
    return ability ? this.#rows('WHERE ability = ?', ability) : this.#rows('');
  }

  #rows(where: string, ...args: string[]): UserAbility[] {
    const rows = this.#read()
      .prepare(`SELECT user_id, ability, granted_by, granted_at FROM user_abilities ${where} ORDER BY granted_at, user_id`)
      .all(...args) as { user_id: string; ability: string; granted_by: string; granted_at: string }[];
    return rows.filter((r) => isAbility(r.ability)).map((r) => ({ userId: r.user_id, ability: r.ability as Ability, grantedBy: r.granted_by, grantedAt: r.granted_at }));
  }

  /** Gives an account an ability. Idempotent: `changed` is false (and no audit row) when it held it already. */
  grant(actor: Actor, userId: UserId, ability: Ability, reason?: string): { changed: boolean } {
    requireInstanceAdmin(actor);
    this.#check(userId, ability);
    const db = this.#write();
    const r = db
      .prepare('INSERT INTO user_abilities (user_id, ability, granted_by, granted_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, ability) DO NOTHING')
      .run(userId, ability, actorString(actor), this.#now().toISOString());
    const changed = Number(r.changes) > 0;
    if (changed) this.#record('ability.granted', actor, userId, ability, reason);
    return { changed };
  }

  /** Takes an ability away. Idempotent like `grant`. What the person already created stays (an org they made keeps them as its owner). */
  revoke(actor: Actor, userId: UserId, ability: Ability, reason?: string): { changed: boolean } {
    requireInstanceAdmin(actor);
    if (!isUserId(userId)) throw new AppError('NOT_FOUND', 'No such account.');
    if (!isAbility(ability)) throw new AppError('VALIDATION_FAILED', 'Unknown ability.', { details: { ability: `One of ${ABILITIES.join(', ')}.` } });
    const changed = Number(this.#write().prepare('DELETE FROM user_abilities WHERE user_id = ? AND ability = ?').run(userId, ability).changes) > 0;
    if (changed) this.#record('ability.revoked', actor, userId, ability, reason);
    return { changed };
  }

  #check(userId: UserId, ability: Ability): void {
    if (!isAbility(ability)) throw new AppError('VALIDATION_FAILED', 'Unknown ability.', { details: { ability: `One of ${ABILITIES.join(', ')}.` } });
    // The founding user is an instance admin (no row needed, and it has no account row); any other id must be an existing account.
    if (!isUserId(userId) || userId === FOUNDING_USER_ID || !this.#read().prepare('SELECT 1 FROM users WHERE id = ?').get(userId))
      throw new AppError('NOT_FOUND', 'No such account.');
  }

  #record(kind: 'ability.granted' | 'ability.revoked', actor: Actor, userId: UserId, ability: Ability, reason?: string): void {
    this.#audit({
      kind,
      severity: 'medium',
      actor: actorString(actor),
      userId,
      subject: `user:${userId}`,
      detail: { ability, ...(reason ? { reason } : {}) },
    });
  }
}
