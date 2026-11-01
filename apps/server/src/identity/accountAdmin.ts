// Managing email accounts with every side effect, in ONE place for both doors (owner, 2026-11-01: "the Admin console controls everything"):
// the main portal's /api/admin/users (app.ts) and the Admin console's /admin-api/users (admin/routes.ts) call these, and each writes its own
// audit row from what they return.
//
// - Review #3: a password reset, a disable or a demotion ends the account's main-portal sessions now (and its sockets with them).
// - Review M1: a disable, a demotion or a removal also ends every token the account minted and every agent of a session it started, for good
//   (identity/accountGate.ts `revokeAccountTokens`).
// - A removal also drops the account from session shares, teams and SSO identities.
// Nothing here logs, stores or returns a password (a one-time one is returned to the caller, which shows it once).

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import type { CreatePortalUserRequest, PortalUser, UpdatePortalUserRequest } from '@portal/contracts';
import { revokeAccountTokens } from './accountGate.js';
import type { PortalUsers } from './users.js';

export type TokensEnded = ReturnType<typeof revokeAccountTokens>;

export interface AccountAdminDeps {
  users: PortalUsers;
  /** The writable database (null while the store is frozen). */
  writable: () => DatabaseSync | null;
  /** Ends the account's main-portal sessions (and cuts their sockets): `portal.revokeUser`. */
  revokeSessions: (id: string) => void;
  /** What else holds the account by id: session shares, teams, SSO identities. */
  forget: { removeUser(id: string): void }[];
  now?: () => Date;
}

/** A password the policy accepts and nobody chose: 24 characters of base64url (144 bits), shown once to the admin who made it. */
export function oneTimePassword(): string {
  return randomBytes(18).toString('base64url');
}

export class AccountAdmin {
  constructor(private readonly d: AccountAdminDeps) {}

  #now = () => (this.d.now ?? (() => new Date()))().toISOString();

  /** Revokes what the account minted or started; returns the counts (all zero when nothing was live). */
  endTokens(id: string, reason: string): TokensEnded {
    const db = this.d.writable();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    return revokeAccountTokens(db, id, this.#now(), reason);
  }

  create(req: Partial<CreatePortalUserRequest>, by: string): Promise<PortalUser> {
    return this.d.users.create(req, by);
  }

  /** Changes an account; ends its sessions (and tokens) when the change takes rights away. `tokens` is null when none were ended. */
  async update(id: string, req: Partial<UpdatePortalUserRequest>): Promise<{ before: PortalUser; after: PortalUser; tokens: TokensEnded | null; reason: string | null }> {
    const before = this.d.users.get(id);
    const after = await this.d.users.update(id, req);
    const demoted = before.role === 'admin' && after.role === 'member';
    if (req.password !== undefined || after.state === 'disabled' || demoted) this.d.revokeSessions(id);
    const reason = after.state === 'disabled' ? 'account disabled' : demoted ? 'account demoted' : null;
    return { before, after, tokens: reason ? this.endTokens(id, reason) : null, reason };
  }

  /** Removes an account and everything that holds it by id. Its objects stay where they are (reassigning them is not built yet). */
  remove(id: string): { before: PortalUser; tokens: TokensEnded } {
    const before = this.d.users.get(id);
    this.d.users.remove(id);
    for (const f of this.d.forget) f.removeUser(id);
    this.d.revokeSessions(id);
    return { before, tokens: this.endTokens(id, 'account removed') };
  }
}
