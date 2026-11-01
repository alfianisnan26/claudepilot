// The instance admin's side of organizations that the Admin console adds (owner, 2026-11-01: "the console controls everything"; §6.7: the
// platform admin creates, suspends and deletes organizations and sees names, member counts and owners). A file of its own so the org service
// (./service.ts) stays as the org's members use it; suspend, resume, recover owner and the list stay there.
//
// - `create`: an org whose first owner is the account the admin picks (not necessarily the admin). Not counted against anyone's
//   `createdPerUser`; audited `org.created` with `by: 'platform'`.
// - `detail`: the summary, members and roles, the objects it owns (kind, id, name: never content), pending invitations (never the code),
//   open break-glass entries, and its SSO providers and domains where this portal has them (slice 10; else null).
// - `delete`: as an owner's delete (only when it owns nothing; `deleting` at once, purged after 30 days), by the platform.
// Every call is an instance admin as a person (`requireInstanceAdmin`); an org that is gone is the same 404.

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import {
  FOUNDING_USER_ID,
  ORG_DELETE_GRACE_MS,
  ORG_LIMITS,
  ORG_SLUG_PATTERN,
  ORGS_ERROR_CODES,
  actorString,
  actorUserId,
  isUserId,
  orgRef,
  type Actor,
  type AdminOrgDetail,
  type AdminOrgObject,
  type OrgId,
  type OrgInvitation,
  type OrgMember,
  type OrgMembershipVia,
  type OrgRole,
  type UserId,
} from '@portal/contracts';
import { emitAccessChange } from '../authz/seam.js';
import type { AuditInput } from '../platform/audit.js';
import { requireInstanceAdmin } from './abilities.js';
import type { OrgsService } from './service.js';

const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
const notFound = () => new AppError('NOT_FOUND', 'Not found.');

/** The tables an org owns objects in, with how each names its rows (OWNED_TABLES of ./authority.ts). */
const OBJECTS: { kind: AdminOrgObject['kind']; sql: string }[] = [
  { kind: 'workspace', sql: "SELECT workspace_id AS id, workspace_id AS name FROM workspace_owners WHERE owner_kind = 'org' AND owner_id = ?" },
  { kind: 'ticket_bucket', sql: "SELECT key AS id, name FROM ticket_buckets WHERE owner_kind = 'org' AND owner_id = ?" },
  { kind: 'vault', sql: "SELECT id, name FROM kg_vaults WHERE owner_kind = 'org' AND owner_id = ? AND deleted_at IS NULL" },
  { kind: 'pool', sql: "SELECT id, type || ': ' || name AS name FROM pools WHERE owner_kind = 'org' AND owner_id = ?" },
  { kind: 'account', sql: "SELECT id, name FROM accounts WHERE owner_kind = 'org' AND owner_id = ?" },
  { kind: 'endpoint', sql: "SELECT id, name FROM endpoints WHERE owner_kind = 'org' AND owner_id = ?" },
];

export interface PlatformOrgsDeps {
  db: () => DatabaseSync | null;
  writable?: () => DatabaseSync | null;
  orgs: OrgsService;
  audit: (e: AuditInput) => void;
  now?: () => Date;
}

export class PlatformOrgs {
  readonly #db: () => DatabaseSync | null;
  readonly #w: () => DatabaseSync | null;
  readonly #orgs: OrgsService;
  readonly #audit: (e: AuditInput) => void;
  readonly #now: () => Date;

  constructor(d: PlatformOrgsDeps) {
    this.#db = d.db;
    this.#w = d.writable ?? d.db;
    this.#orgs = d.orgs;
    this.#audit = d.audit;
    this.#now = d.now ?? (() => new Date());
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

  #record(kind: string, actor: Actor, orgId: OrgId, userId: UserId | null, detail: Record<string, unknown>, severity: AuditInput['severity'] = 'medium'): void {
    this.#audit({ kind, severity, actor: actorString(actor), userId, subject: `org:${orgId}`, detail: { orgId, by: 'platform', ...detail } });
  }

  #accountActive(userId: string): boolean {
    if (userId === FOUNDING_USER_ID) return true;
    if (!isUserId(userId)) return false;
    return (this.#read().prepare('SELECT state FROM users WHERE id = ?').get(userId) as { state: string } | undefined)?.state === 'active';
  }

  /** Creates an org with `ownerId` (an active account; the admin when absent) as its first owner. */
  create(actor: Actor, req: { name?: unknown; slug?: unknown; ownerId?: unknown }): AdminOrgDetail {
    requireInstanceAdmin(actor);
    const name = typeof req.name === 'string' ? clean(req.name) : '';
    if (!name || name.length > ORG_LIMITS.nameMax)
      throw new AppError('VALIDATION_FAILED', `Give it a name of at most ${ORG_LIMITS.nameMax} characters.`, { details: { name: 'Required.' } });
    const slug = typeof req.slug === 'string' ? req.slug.trim().toLowerCase() : '';
    if (!ORG_SLUG_PATTERN.test(slug))
      throw new AppError('VALIDATION_FAILED', `A slug is ${ORG_LIMITS.slugMin}-${ORG_LIMITS.slugMax} lower-case letters, digits and hyphens.`, { details: { slug: 'Not a slug.' } });
    const owner = (typeof req.ownerId === 'string' && req.ownerId ? req.ownerId : actorUserId(actor)) as UserId | null;
    if (!owner || !this.#accountActive(owner)) throw new AppError('VALIDATION_FAILED', 'Pick an active account as the owner.', { details: { ownerId: 'Not an active account.' } });
    const db = this.#write();
    const id = `org_${randomBytes(9).toString('base64url')}` as OrgId;
    const at = this.#now().toISOString();
    const by = actorString(actor);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT 1 FROM orgs WHERE slug = ?').get(slug))
        throw new AppError('CONFLICT', 'That slug is taken.', { details: { slug: 'Already used.', reason: ORGS_ERROR_CODES.ORG_SLUG_TAKEN } });
      db.prepare("INSERT INTO orgs (id, slug, name, state, policies, created_by, created_at) VALUES (?, ?, ?, 'active', '{}', ?, ?)").run(id, slug, name, by, at);
      db.prepare("INSERT INTO org_members (org_id, user_id, role, state, via, added_by, added_at) VALUES (?, ?, 'owner', 'active', 'created', ?, ?)").run(id, owner, by, at);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    this.#record('org.created', actor, id, owner, { slug, name, owner, ability: 'instance_admin' }, 'info');
    return this.detail(actor, id);
  }

  /** Everything the console shows about one org: names, roles, counts and ids; never content. */
  detail(actor: Actor, id: OrgId): AdminOrgDetail {
    requireInstanceAdmin(actor);
    const summary = this.#orgs.listAll(actor).find((o) => o.id === id);
    if (!summary || summary.state === 'deleting') throw notFound();
    const db = this.#read();
    const members = (
      db
        .prepare(
          `SELECT m.user_id, m.role, m.via, m.added_at, u.email, u.display_name FROM org_members m
           LEFT JOIN users u ON u.id = m.user_id OR (m.user_id = '${FOUNDING_USER_ID}' AND u.founder = 1)
           WHERE m.org_id = ? AND m.state = 'active'
           ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.email_key, m.user_id`,
        )
        .all(id) as { user_id: string; role: OrgRole; via: OrgMembershipVia; added_at: string; email: string | null; display_name: string | null }[]
    ).map(
      (r): OrgMember => ({
        userId: r.user_id as UserId,
        email: r.email ?? '',
        displayName: r.display_name ?? (r.user_id === FOUNDING_USER_ID ? 'Owner' : 'A removed account'),
        role: r.role,
        via: r.via,
        joinedAt: r.added_at,
      }),
    );
    const objects: AdminOrgObject[] = [];
    for (const o of OBJECTS) {
      try {
        for (const r of db.prepare(`${o.sql} ORDER BY 2 LIMIT 500`).all(id) as { id: string; name: string }[]) objects.push({ kind: o.kind, id: String(r.id), name: String(r.name) });
      } catch {
        // a table this database does not have yet: nothing of that kind
      }
    }
    const now = this.#now().getTime();
    const invitations = (
      db
        .prepare('SELECT id, email_key, role, invited_by, created_at, expires_at FROM org_invitations WHERE org_id = ? AND used_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 200')
        .all(id) as { id: string; email_key: string; role: OrgInvitation['role']; invited_by: string; created_at: string; expires_at: string }[]
    ).map(
      (r): OrgInvitation => ({
        id: r.id,
        email: r.email_key,
        role: r.role,
        invitedBy: r.invited_by,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        state: Date.parse(r.expires_at) <= now ? 'expired' : 'pending',
      }),
    );
    const breakGlassOpen = (
      db.prepare('SELECT admin_user_id, expires_at FROM org_break_glass WHERE org_id = ? AND ended_at IS NULL AND expires_at > ? ORDER BY started_at').all(id, new Date(now).toISOString()) as {
        admin_user_id: string;
        expires_at: string;
      }[]
    ).map((r) => ({ adminUserId: r.admin_user_id, expiresAt: r.expires_at }));
    return { ...summary, memberList: members, objects, invitations, sso: this.#sso(db, id), domains: this.#domains(db, id), breakGlassOpen };
  }

  /** The org's own SSO providers, when this database has org SSO (`sso_providers.org_id`, slice 10); else null. */
  #sso(db: DatabaseSync, id: OrgId): AdminOrgDetail['sso'] {
    const cols = db.prepare("SELECT name FROM pragma_table_info('sso_providers')").all() as { name: string }[];
    if (!cols.some((c) => c.name === 'org_id')) return null;
    return (db.prepare('SELECT id, name, enabled FROM sso_providers WHERE org_id = ? ORDER BY name').all(id) as { id: string; name: string; enabled: number }[]).map((r) => ({
      id: r.id,
      name: r.name,
      enabled: r.enabled === 1,
    }));
  }

  /** The org's domains, when this database has them (`org_domains`, slice 10); else null. */
  #domains(db: DatabaseSync, id: OrgId): AdminOrgDetail['domains'] {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'org_domains'").get()) return null;
    const cols = new Set((db.prepare("SELECT name FROM pragma_table_info('org_domains')").all() as { name: string }[]).map((c) => c.name));
    if (!cols.has('org_id') || !cols.has('domain')) return null;
    const verified = cols.has('verified_at') ? 'verified_at IS NOT NULL' : '0';
    return (db.prepare(`SELECT domain, ${verified} AS verified FROM org_domains WHERE org_id = ? ORDER BY domain`).all(id) as { domain: string; verified: number }[]).map((r) => ({
      domain: r.domain,
      verified: r.verified === 1,
    }));
  }

  /**
   * Owner need 2026-11-01 (Members → Add): puts an active account in the org with a role (admin, member or guest; never owner) through the
   * org service's `admit` (via `invite`: the column has no platform value, and the audit row says who). Refused for an org being deleted, an
   * account that is not active, and someone already in it (their role changes inside the org).
   */
  addMember(actor: Actor, id: OrgId, userId: unknown, role: unknown): void {
    requireInstanceAdmin(actor);
    const state = this.#orgs.stateOf(id);
    if (!state || state === 'deleting') throw notFound();
    if (role !== 'admin' && role !== 'member' && role !== 'guest')
      throw new AppError('VALIDATION_FAILED', 'Pick admin, member or guest.', { details: { role: 'One of admin, member, guest.' } });
    if (typeof userId !== 'string' || !this.#accountActive(userId)) throw new AppError('VALIDATION_FAILED', 'Pick an active account.', { details: { userId: 'Not an active account.' } });
    if (this.#orgs.roleOf(id, userId as UserId)) throw new AppError('CONFLICT', 'Already a member. Their role is changed in the org.', { details: { userId: 'Already a member.' } });
    this.#orgs.admit(id, userId as UserId, role as OrgRole, 'invite', actorString(actor));
    this.#record('org.member_added_by_admin', actor, id, userId as UserId, { member: userId, role, ability: 'instance_admin' });
  }

  /** Members → Remove: ends a membership that is not an owner's (the org service's `removeByPlatform`). */
  removeMember(actor: Actor, id: OrgId, userId: string): void {
    const role = this.#orgs.removeByPlatform(actor, id, userId as UserId);
    this.#record('org.member_removed_by_admin', actor, id, userId as UserId, { member: userId, role, ability: 'instance_admin' });
  }

  /** Deletes an org that owns nothing, by the platform: `deleting` at once (invitations revoked, nobody sees it), purged after 30 days. */
  delete(actor: Actor, id: OrgId, rawReason?: unknown): void {
    requireInstanceAdmin(actor);
    const state = this.#orgs.stateOf(id);
    if (!state || state === 'deleting') throw notFound();
    const owned = this.#orgs.ownedCount(id);
    if (owned > 0) throw new AppError('CONFLICT', 'The organization still owns things. Move them out first.', { details: { reason: ORGS_ERROR_CODES.ORG_OWNS_OBJECTS, owned } });
    const reason = typeof rawReason === 'string' ? clean(rawReason).slice(0, 300) : '';
    const db = this.#write();
    const at = this.#now().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE orgs SET state = 'deleting', deleted_at = ?, suspended_by = NULL WHERE id = ? AND state IN ('active', 'suspended')").run(at, id);
      db.prepare('UPDATE org_invitations SET revoked_at = ? WHERE org_id = ? AND used_at IS NULL AND revoked_at IS NULL').run(at, id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    this.#record('org.deleted', actor, id, actorUserId(actor) as UserId | null, { purgeAfter: new Date(this.#now().getTime() + ORG_DELETE_GRACE_MS).toISOString(), ...(reason ? { reason } : {}) });
    const members = this.#read().prepare("SELECT user_id FROM org_members WHERE org_id = ? AND state = 'active'").all(id) as { user_id: string }[];
    for (const r of members) if (isUserId(r.user_id)) emitAccessChange({ userId: r.user_id, ref: orgRef(id), why: 'org_membership_ended' });
  }
}
