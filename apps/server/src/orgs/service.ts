// Organizations, the core (docs/prd/organizations.md §6.1, §6.2, §6.5, §6.7, §13.2 row 3). Read this header before calling it.
//
// - Rights on the org itself go through the one `can()` (object type `org`, resolver in ./authz.ts): owner and admin `manage`, member and guest
//   `view`, anyone else nothing, answered exactly like a missing org (404). Membership is read on every decision, never cached.
// - Owner-only acts (making or unmaking an owner, removing an owner) are checked here by the actor's role; an admin changes roles up to admin.
// - THE INVARIANT: an org that is active or suspended always keeps at least one ACTIVE owner. Every write that could end an owner's membership
//   runs the check and the write in one IMMEDIATE transaction (so a second writer waits), and migration 463's triggers refuse it in the
//   database too (another connection, a script, a bug here). Both answer 409 with `details.reason = ORG_NEEDS_OWNER`.
// - Creating an org needs the ability `orgs.create` (./abilities.ts) or an instance admin, and a PERSON (no token, no agent: PRD §10 says no
//   tool creates orgs). The creator becomes the first owner.
// - The platform admin's list (`listAll`) and owner recovery (`recoverOwner`) are service functions for the Admin console (slice 4, its own
//   host, session and step-up). They read names, counts and owners, never content; a platform admin holds no right on an org by being one.
// - Slice 8 (§6.9): leaving or removal ends the grants the person made of their personal objects to the org and their creator grants on the
//   org's objects, in the same transaction as the membership; suspension (an owner, or the platform admin from the Admin console, which only
//   it can undo) makes every right from the org none (the resolver and the seam read the state); deletion needs an org that owns nothing,
//   leaves it `deleting` for 30 days (nobody sees it) and `purgeDeleted` then removes it with its memberships, invitations and grants.
// Every change writes a platform audit row (`org.*`, subject `org:<id>`, the actor as `actorString`; `platform_audit.org_id` from the subject).

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import {
  ABILITIES,
  FOUNDING_USER_ID,
  ORG_DELETE_GRACE_MS,
  ORG_LIMITS,
  ORG_POLICY_DEFAULTS,
  ORG_SLUG_PATTERN,
  ORGS_ERROR_CODES,
  actorString,
  actorUserId,
  isOrgId,
  isOrgRole,
  isUserId,
  orgRef,
  type Actor,
  type AdminOrgSummary,
  type MyAbilities,
  type ObjectRef,
  type Org,
  type OrgId,
  type OrgMember,
  type OrgMembershipVia,
  type OrgPolicies,
  type OrgRole,
  type OrgState,
  type PlatformAuditEntry,
  type UserId,
} from '@portal/contracts';
import { emitAccessChange, isPlatformAdmin, requireCan, resolve, visible } from '../authz/seam.js';
import type { AuditInput } from '../platform/audit.js';
import { requireInstanceAdmin, type UserAbilities } from './abilities.js';
import { OWNED_TABLES } from './authority.js';
import { registerOrgResolver } from './authz.js';

export interface OrgsDeps {
  db: () => DatabaseSync | null;
  writable?: () => DatabaseSync | null;
  abilities: UserAbilities;
  audit: (e: AuditInput) => void;
  now?: () => Date;
}

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  state: OrgState;
  policies: string;
  created_by: string;
  created_at: string;
}

const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
const needsOwner = () =>
  new AppError('CONFLICT', 'An organization keeps at least one owner. Make someone else an owner first.', { details: { reason: ORGS_ERROR_CODES.ORG_NEEDS_OWNER } });
const notFound = () => new AppError('NOT_FOUND', 'Not found.');

export class OrgsService {
  readonly #db: () => DatabaseSync | null;
  readonly #w: () => DatabaseSync | null;
  readonly #abilities: UserAbilities;
  readonly #audit: (e: AuditInput) => void;
  readonly #now: () => Date;

  constructor(deps: OrgsDeps) {
    this.#db = deps.db;
    this.#w = deps.writable ?? deps.db;
    this.#abilities = deps.abilities;
    this.#audit = deps.audit;
    this.#now = deps.now ?? (() => new Date());
    // The seam decides every right on an org through this resolver (membership, read on every call); without it every org is not found.
    registerOrgResolver(this);
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

  /* ---------- What the resolver reads (./authz.ts) ---------- */

  /** The org's state, or null when there is no such org (or the database cannot be read: fail closed). */
  stateOf(id: string): OrgState | null {
    if (!isOrgId(id)) return null;
    try {
      return (this.#db()?.prepare('SELECT state FROM orgs WHERE id = ?').get(id) as { state: OrgState } | undefined)?.state ?? null;
    } catch {
      return null;
    }
  }

  /** The user's ACTIVE role in the org, or null. Read on every decision. */
  roleOf(id: string, userId: UserId): OrgRole | null {
    if (!isOrgId(id) || !isUserId(userId)) return null;
    try {
      const r = this.#db()?.prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ? AND state = 'active'").get(id, userId) as { role: string } | undefined;
      return r && isOrgRole(r.role) ? r.role : null;
    } catch {
      return null;
    }
  }

  /** The org's ACTIVE owners (who is told about its objects and a break-glass entry); empty when unreadable. */
  activeOwners(id: string): UserId[] {
    if (!isOrgId(id)) return [];
    try {
      return ((this.#db()?.prepare("SELECT user_id FROM org_members WHERE org_id = ? AND role = 'owner' AND state = 'active' ORDER BY added_at, user_id").all(id) ?? []) as { user_id: unknown }[])
        .map((r) => r.user_id)
        .filter((u): u is UserId => isUserId(u));
    } catch {
      return [];
    }
  }

  /* ---------- A member's view ---------- */

  #row(id: string): OrgRow | null {
    return (this.#read().prepare('SELECT id, slug, name, state, policies, created_by, created_at FROM orgs WHERE id = ?').get(id) as OrgRow | undefined) ?? null;
  }

  #policies(raw: string): OrgPolicies {
    let parsed: Record<string, unknown> = {};
    try {
      const v = JSON.parse(raw) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>;
    } catch {
      // defaults
    }
    const out: OrgPolicies = { ...ORG_POLICY_DEFAULTS };
    for (const k of Object.keys(ORG_POLICY_DEFAULTS) as (keyof OrgPolicies)[]) {
      const v = parsed[k];
      if (k === 'ssoFreshnessDays') out.ssoFreshnessDays = typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 365 ? v : ORG_POLICY_DEFAULTS.ssoFreshnessDays;
      else if (k === 'defaultJoinRole') out.defaultJoinRole = v === 'admin' || v === 'member' || v === 'guest' ? v : ORG_POLICY_DEFAULTS.defaultJoinRole;
      else if (typeof v === 'boolean') out[k] = v;
    }
    return out;
  }

  /** The org's policies (§6.6), defaults for a missing key; defaults when there is no such org. */
  policiesOf(id: string): OrgPolicies {
    const raw = (this.#read().prepare('SELECT policies FROM orgs WHERE id = ?').get(id) as { policies: string } | undefined)?.policies;
    return this.#policies(raw ?? '{}');
  }

  #activeMembers(id: string): number {
    return (this.#read().prepare("SELECT count(*) AS n FROM org_members WHERE org_id = ? AND state = 'active'").get(id) as { n: number }).n;
  }

  #view(r: OrgRow, role: OrgRole): Org {
    const out: Org = { id: r.id, slug: r.slug, name: r.name, state: r.state, myRole: role, members: role === 'guest' ? 0 : this.#activeMembers(r.id), createdAt: r.created_at };
    if (role === 'owner' || role === 'admin') out.policies = this.#policies(r.policies);
    return out;
  }

  /** The orgs the actor is in and may see (the switcher). A token sees its user's; an agent sees none (it is boxed to its session). */
  mine(actor: Actor): Org[] {
    const userId = actorUserId(actor);
    if (!userId || actor.kind === 'agent') return [];
    const rows = this.#read()
      .prepare(
        `SELECT o.id, o.slug, o.name, o.state, o.policies, o.created_by, o.created_at, m.role FROM orgs o
         JOIN org_members m ON m.org_id = o.id AND m.user_id = ? AND m.state = 'active' ORDER BY o.name COLLATE NOCASE, o.id`,
      )
      .all(userId) as unknown as (OrgRow & { role: OrgRole })[];
    return visible(actor, 'org', rows, (r) => r.id).map((r) => this.#view(r, r.role));
  }

  /** The abilities the actor may use, for the web's "New organization" (§6.11). A person only: a token or an agent gets none (they cannot create). */
  myAbilities(actor: Actor): MyAbilities {
    if (actor.kind !== 'user') return { abilities: [] };
    return { abilities: ABILITIES.filter((a) => this.#abilities.may(actor.userId, a)) };
  }

  get(actor: Actor, id: OrgId): Org {
    requireCan(actor, 'view', orgRef(id));
    const r = this.#row(id);
    const role = actorUserId(actor) ? this.roleOf(id, actorUserId(actor) as UserId) : null;
    if (!r || !role) throw notFound();
    return this.#view(r, role);
  }

  #name(raw: unknown): string {
    const name = typeof raw === 'string' ? clean(raw) : '';
    if (!name || name.length > ORG_LIMITS.nameMax)
      throw new AppError('VALIDATION_FAILED', `Give it a name of at most ${ORG_LIMITS.nameMax} characters.`, { details: { name: 'Required.' } });
    return name;
  }

  #slug(raw: unknown): string {
    const slug = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!ORG_SLUG_PATTERN.test(slug))
      throw new AppError('VALIDATION_FAILED', `A slug is ${ORG_LIMITS.slugMin}-${ORG_LIMITS.slugMax} lower-case letters, digits and hyphens.`, { details: { slug: 'Not a slug.' } });
    return slug;
  }

  /**
   * Creates an org with the actor as its first owner. Needs a person (a signed-in user, not a token or an agent) who is an instance admin or
   * holds the ability `orgs.create`; anything else is 403 ORG_CREATE_NOT_ALLOWED (creating is not about an existing object: nothing leaks).
   */
  create(actor: Actor, req: { name?: unknown; slug?: unknown }): Org {
    if (actor.kind !== 'user') throw new AppError('FORBIDDEN', 'Organizations are created by a person.', { details: { reason: ORGS_ERROR_CODES.ORG_CREATE_NOT_ALLOWED } });
    const userId = actor.userId;
    const admin = isPlatformAdmin(userId);
    if (!admin && !this.#abilities.holds(userId, 'orgs.create'))
      throw new AppError('FORBIDDEN', 'Your account can’t create organizations. An admin can allow it.', { details: { reason: ORGS_ERROR_CODES.ORG_CREATE_NOT_ALLOWED } });
    const name = this.#name(req.name);
    const slug = this.#slug(req.slug);
    const db = this.#write();
    const id = `org_${randomBytes(9).toString('base64url')}`;
    const at = this.#now().toISOString();
    const by = actorString(actor);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!admin && (db.prepare('SELECT count(*) AS n FROM orgs WHERE created_by = ?').get(by) as { n: number }).n >= ORG_LIMITS.createdPerUser)
        throw new AppError('CONFLICT', 'You have created as many organizations as the portal allows.');
      if (db.prepare('SELECT 1 FROM orgs WHERE slug = ?').get(slug))
        throw new AppError('CONFLICT', 'That slug is taken.', { details: { slug: 'Already used.', reason: ORGS_ERROR_CODES.ORG_SLUG_TAKEN } });
      db.prepare("INSERT INTO orgs (id, slug, name, state, policies, created_by, created_at) VALUES (?, ?, ?, 'active', '{}', ?, ?)").run(id, slug, name, by, at);
      db.prepare("INSERT INTO org_members (org_id, user_id, role, state, via, added_by, added_at) VALUES (?, ?, 'owner', 'active', 'created', ?, ?)").run(id, userId, by, at);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    this.#record('org.created', actor, id, userId, { slug, name, ability: admin ? 'instance_admin' : 'orgs.create' });
    return this.get(actor, id);
  }

  /** Renames an org (manage: owners and admins). Policies come with Org settings (a later slice). */
  update(actor: Actor, id: OrgId, req: { name?: unknown }): Org {
    requireCan(actor, 'manage', orgRef(id));
    if (req.name !== undefined) {
      const name = this.#name(req.name);
      this.#write().prepare('UPDATE orgs SET name = ? WHERE id = ?').run(name, id);
      this.#record('org.updated', actor, id, actorUserId(actor), { name });
    }
    return this.get(actor, id);
  }

  /** The member directory: members and up; a guest sees the org's name only (§6.2). */
  members(actor: Actor, id: OrgId): OrgMember[] {
    requireCan(actor, 'view', orgRef(id));
    const me = this.roleOf(id, actorUserId(actor) as UserId);
    if (!me) throw notFound();
    if (me === 'guest') throw new AppError('FORBIDDEN', 'Guests don’t see the member list.');
    const rows = this.#read()
      .prepare(
        `SELECT m.user_id, m.role, m.via, m.added_at, u.email, u.display_name FROM org_members m
         LEFT JOIN users u ON u.id = m.user_id OR (m.user_id = '${FOUNDING_USER_ID}' AND u.founder = 1)
         WHERE m.org_id = ? AND m.state = 'active'
         ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END, u.email_key, m.user_id`,
      )
      .all(id) as { user_id: string; role: OrgRole; via: OrgMembershipVia; added_at: string; email: string | null; display_name: string | null }[];
    return rows.map((r) => ({
      userId: r.user_id,
      email: r.email ?? '',
      displayName: r.display_name ?? (r.user_id === FOUNDING_USER_ID ? 'Owner' : 'A removed account'),
      role: r.role,
      via: r.via,
      joinedAt: r.added_at,
    }));
  }

  /**
   * Runs `fn` in one IMMEDIATE transaction after checking that the org keeps another active owner than `leaving` (when `leaving` is an active
   * owner). The trigger of migration 463 is the second line: its refusal is turned into the same 409.
   */
  #keepingAnOwner(db: DatabaseSync, orgId: OrgId, leaving: UserId, fn: () => void): void {
    db.exec('BEGIN IMMEDIATE');
    try {
      const role = (db.prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ? AND state = 'active'").get(orgId, leaving) as { role: string } | undefined)?.role;
      if (role === 'owner') {
        const others = (
          db.prepare("SELECT count(*) AS n FROM org_members WHERE org_id = ? AND user_id != ? AND role = 'owner' AND state = 'active'").get(orgId, leaving) as { n: number }
        ).n;
        if (others === 0) throw needsOwner();
      }
      fn();
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      if (e instanceof Error && e.message.includes(ORGS_ERROR_CODES.ORG_NEEDS_OWNER) && !(e instanceof AppError)) throw needsOwner();
      throw e;
    }
  }

  /** The actor's role, for the owner-only rules (after `requireCan` has decided they may manage at all). */
  #myRole(actor: Actor, id: OrgId): OrgRole {
    const role = this.roleOf(id, actorUserId(actor) as UserId);
    if (!role) throw notFound();
    return role;
  }

  /** Changes a member's role. Admins change roles up to admin and never touch an owner; owners change anything (§6.2). */
  setRole(actor: Actor, id: OrgId, userId: UserId, role: OrgRole): void {
    requireCan(actor, 'manage', orgRef(id));
    if (!isOrgRole(role)) throw new AppError('VALIDATION_FAILED', 'Unknown role.', { details: { role: 'One of owner, admin, member, guest.' } });
    const mine = this.#myRole(actor, id);
    const theirs = this.roleOf(id, userId);
    if (!theirs) throw notFound();
    if (theirs === role) return;
    if (mine !== 'owner' && (theirs === 'owner' || role === 'owner')) throw new AppError('FORBIDDEN', 'Only an owner changes who the owners are.');
    const db = this.#write();
    this.#keepingAnOwner(db, id, userId, () => {
      db.prepare("UPDATE org_members SET role = ? WHERE org_id = ? AND user_id = ? AND state = 'active'").run(role, id, userId);
    });
    this.#record('org.member_role_changed', actor, id, userId, { member: userId, from: theirs, to: role });
  }

  /** Removes a member (manage). Only an owner removes an owner; the last owner cannot be removed. The row stays, `removed`, for audit. */
  removeMember(actor: Actor, id: OrgId, userId: UserId): void {
    requireCan(actor, 'manage', orgRef(id));
    const mine = this.#myRole(actor, id);
    const theirs = this.roleOf(id, userId);
    if (!theirs) throw notFound();
    if (theirs === 'owner' && mine !== 'owner') throw new AppError('FORBIDDEN', 'Only an owner removes an owner.');
    this.#end(id, userId);
    this.#record('org.member_removed', actor, id, userId, { member: userId, role: theirs });
  }

  /** Leaves an org (any member, guests too). The last owner cannot leave. */
  leave(actor: Actor, id: OrgId): void {
    requireCan(actor, 'view', orgRef(id));
    const userId = actorUserId(actor) as UserId;
    const role = this.#myRole(actor, id);
    this.#end(id, userId);
    this.#record('org.member_left', actor, id, userId, { role });
  }

  #end(id: OrgId, userId: UserId): void {
    const db = this.#write();
    // §6.9: the grants that relied on the membership go in the same transaction: what they shared of their PERSONAL objects to this org,
    // and their creator grants on this org's objects (the objects stay the org's). Decided before the write, through the resolvers.
    const ended = this.#grantsEndingWith(id, userId);
    this.#keepingAnOwner(db, id, userId, () => {
      db.prepare("UPDATE org_members SET state = 'removed', ended_at = ? WHERE org_id = ? AND user_id = ? AND state = 'active'").run(this.#now().toISOString(), id, userId);
      const del = db.prepare('DELETE FROM grants WHERE id = ?');
      for (const g of ended) del.run(g);
    });
    // Rights are read on every call; this tells open sockets, terminals and sessions that relied on the membership (§6.9).
    emitAccessChange({ userId, ref: orgRef(id), why: 'org_membership_ended' });
  }

  /** The ids of the grants that end when `userId` leaves org `id` (§6.9). None when the table cannot be read (the membership still ends). */
  #grantsEndingWith(id: OrgId, userId: UserId): string[] {
    let rows: { id: string; object_type: string; object_id: string; subject_kind: string }[] = [];
    try {
      rows = this.#read()
        .prepare(
          `SELECT id, object_type, object_id, subject_kind FROM grants
           WHERE (subject_kind = 'org' AND subject_id = ? AND granted_by = ? AND share_id != 'creator')
              OR (subject_kind = 'user' AND subject_id = ? AND share_id = 'creator')`,
        )
        .all(id, `user:${userId}`, userId) as typeof rows;
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const g of rows) {
      const owner = resolve({ type: g.object_type, id: g.object_id } as ObjectRef)?.owner;
      const ends = g.subject_kind === 'org' ? owner?.kind === 'user' && owner.id === userId : owner?.kind === 'org' && owner.id === id;
      if (ends) out.push(g.id);
    }
    return out;
  }

  /* ---------- Suspension and deletion (slice 8, §6.9) ---------- */

  /** Every active member is told of the org's state change (sockets and sessions reconsider; rights are read on every call anyway). */
  #tellMembers(id: OrgId, why: 'org_suspended' | 'org_membership_ended'): void {
    const rows = this.#read().prepare("SELECT user_id FROM org_members WHERE org_id = ? AND state = 'active'").all(id) as { user_id: string }[];
    for (const r of rows) if (isUserId(r.user_id)) emitAccessChange({ userId: r.user_id, ref: orgRef(id), why });
  }

  /** An owner of the org, as a person (suspend, resume, delete). Anyone else: the org's 404, or 403 for a member who sees it. */
  #requireOwner(actor: Actor, id: OrgId): void {
    if (actor.kind !== 'user') throw notFound();
    requireCan(actor, 'view', orgRef(id));
    if (this.#myRole(actor, id) !== 'owner') throw new AppError('FORBIDDEN', 'Only an owner does that.');
  }

  #requirePlatform(actor: Actor, id: OrgId): void {
    requireInstanceAdmin(actor);
    const state = this.stateOf(id);
    if (!state || state === 'deleting') throw notFound();
  }

  /**
   * Suspends an org: every right that comes from it is none (the org resolver, org-owned objects and org grants read the state on every
   * call); its owners still see it, to resume or delete. `by: 'platform'` is the Admin console (an instance admin as a person); only the
   * console resumes what it suspended.
   */
  suspend(actor: Actor, id: OrgId, opts: { by: 'owner' | 'platform'; reason?: unknown }): void {
    if (opts.by === 'platform') this.#requirePlatform(actor, id);
    else this.#requireOwner(actor, id);
    const reason = typeof opts.reason === 'string' ? clean(opts.reason).slice(0, 300) : '';
    const r = this.#write().prepare("UPDATE orgs SET state = 'suspended', suspended_by = ? WHERE id = ? AND state = 'active'").run(opts.by, id);
    if (Number(r.changes) === 0) throw new AppError('CONFLICT', 'The organization is not active.');
    this.#record('org.suspended', actor, id, actorUserId(actor), { by: opts.by, ...(reason ? { reason } : {}) }, 'medium');
    this.#tellMembers(id, 'org_suspended');
  }

  /** Resumes a suspended org. An owner resumes only what an owner suspended; the platform admin resumes either. */
  resume(actor: Actor, id: OrgId, opts: { by: 'owner' | 'platform' }): void {
    if (opts.by === 'platform') this.#requirePlatform(actor, id);
    else this.#requireOwner(actor, id);
    const row = this.#read().prepare('SELECT state, suspended_by FROM orgs WHERE id = ?').get(id) as { state: OrgState; suspended_by: string | null } | undefined;
    if (row?.state !== 'suspended') throw new AppError('CONFLICT', 'The organization is not suspended.');
    if (opts.by === 'owner' && row.suspended_by === 'platform')
      throw new AppError('FORBIDDEN', 'The portal’s admin suspended this organization. Ask them to resume it.', { details: { reason: ORGS_ERROR_CODES.ORG_SUSPENDED_BY_PLATFORM } });
    this.#write().prepare("UPDATE orgs SET state = 'active', suspended_by = NULL WHERE id = ? AND state = 'suspended'").run(id);
    this.#record('org.resumed', actor, id, actorUserId(actor), { by: opts.by }, 'medium');
  }

  /** How many objects the org still owns (deleting is refused while any). */
  ownedCount(id: OrgId): number {
    const db = this.#read();
    let n = 0;
    for (const t of OWNED_TABLES) n += (db.prepare(`SELECT count(*) AS n FROM ${t} WHERE owner_kind = 'org' AND owner_id = ?`).get(id) as { n: number }).n;
    return n;
  }

  /**
   * Deletes an org (an owner, as a person): only when it owns nothing (moving every object out first is §6.9's explicit transfer). It is
   * `deleting` at once (nobody sees it, every right from it is none, pending invitations are revoked) and purged after 30 days.
   */
  delete(actor: Actor, id: OrgId): void {
    this.#requireOwner(actor, id);
    const owned = this.ownedCount(id);
    if (owned > 0) throw new AppError('CONFLICT', 'The organization still owns things. Move them out first.', { details: { reason: ORGS_ERROR_CODES.ORG_OWNS_OBJECTS, owned } });
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
    this.#record('org.deleted', actor, id, actorUserId(actor), { purgeAfter: new Date(this.#now().getTime() + ORG_DELETE_GRACE_MS).toISOString() }, 'medium');
    this.#tellMembers(id, 'org_membership_ended');
  }

  /** Purges orgs deleted more than 30 days ago: the org (memberships, invitations, break-glass entries cascade) and the grants to it. */
  purgeDeleted(): number {
    const db = this.#w();
    if (!db) return 0;
    const cutoff = new Date(this.#now().getTime() - ORG_DELETE_GRACE_MS).toISOString();
    const ids = (db.prepare("SELECT id FROM orgs WHERE state = 'deleting' AND deleted_at IS NOT NULL AND deleted_at <= ?").all(cutoff) as { id: string }[]).map((r) => r.id);
    let purged = 0;
    for (const id of ids) {
      db.exec('BEGIN IMMEDIATE');
      try {
        // Children first and by name (not only through the cascade), so the purge does not depend on the foreign-key pragma.
        for (const sql of [
          "DELETE FROM grants WHERE subject_kind = 'org' AND subject_id = ?",
          'DELETE FROM org_invitations WHERE org_id = ?',
          'DELETE FROM org_break_glass WHERE org_id = ?',
          'DELETE FROM org_members WHERE org_id = ?',
          'DELETE FROM orgs WHERE id = ?',
        ])
          db.prepare(sql).run(id);
        db.exec('COMMIT');
        purged++;
      } catch (e) {
        db.exec('ROLLBACK');
        console.error(`[orgs] purging a deleted organization failed: ${(e as Error).message}`);
        continue;
      }
      this.#audit({ kind: 'org.purged', severity: 'info', actor: 'system:orgs-purge', userId: null, subject: `org:${id}`, detail: { orgId: id } });
    }
    return purged;
  }

  /** The org's audit rows (§6.10): owners and admins (manage), newest first. */
  audit(actor: Actor, id: OrgId, q: { before?: unknown; limit?: unknown } = {}): PlatformAuditEntry[] {
    requireCan(actor, 'manage', orgRef(id));
    const before = Number(q.before);
    const paged = Number.isInteger(before) && before > 0;
    const limit = Math.max(1, Math.min(200, Math.floor(Number(q.limit) || 100)));
    const rows = this.#read()
      .prepare(`SELECT id, at, severity, kind, actor, user_id, subject, detail FROM platform_audit WHERE org_id = ? ${paged ? 'AND id < ?' : ''} ORDER BY id DESC LIMIT ${limit}`)
      .all(...(paged ? [id, before] : [id])) as {
      id: number;
      at: string;
      severity: PlatformAuditEntry['severity'];
      kind: string;
      actor: string;
      user_id: string | null;
      subject: string | null;
      detail: string;
    }[];
    return rows.map((r) => ({ id: r.id, at: r.at, severity: r.severity, kind: r.kind, actor: r.actor, userId: r.user_id, subject: r.subject, detail: JSON.parse(r.detail) as Record<string, unknown> }));
  }

  /**
   * Puts a person in an org with a role, or brings a removed member back. NO authorization here: the caller has already decided (an accepted
   * invitation (./invitations.ts), the three-org migration, SSO JIT; slices 6, 8 and 10). The account must exist and be active.
   */
  admit(orgId: OrgId, userId: UserId, role: OrgRole, via: Exclude<OrgMembershipVia, 'recovered'>, by: string): void {
    if (!isOrgRole(role)) throw new AppError('VALIDATION_FAILED', 'Unknown role.');
    if (!this.stateOf(orgId)) throw notFound();
    if (!this.#accountActive(userId)) throw new AppError('NOT_FOUND', 'No such account.');
    const db = this.#write();
    if (!this.roleOf(orgId, userId) && this.#activeMembers(orgId) >= ORG_LIMITS.maxMembers) throw new AppError('CONFLICT', 'The organization is full.');
    this.#keepingAnOwner(db, orgId, userId, () => {
      db.prepare(
        `INSERT INTO org_members (org_id, user_id, role, state, via, added_by, added_at) VALUES (?, ?, ?, 'active', ?, ?, ?)
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role, state = 'active', via = excluded.via, added_by = excluded.added_by,
           added_at = CASE WHEN org_members.state = 'active' THEN org_members.added_at ELSE excluded.added_at END, ended_at = NULL`,
      ).run(orgId, userId, role, via, by, this.#now().toISOString());
    });
  }

  #accountActive(userId: UserId): boolean {
    if (userId === FOUNDING_USER_ID) return true;
    if (!isUserId(userId)) return false;
    return (this.#read().prepare('SELECT state FROM users WHERE id = ?').get(userId) as { state: string } | undefined)?.state === 'active';
  }

  /* ---------- The platform admin (the Admin console, slice 4) ---------- */

  /** Every organization with its state, member count and owners (names, never content). Instance admins only, as a person. */
  listAll(actor: Actor): AdminOrgSummary[] {
    requireInstanceAdmin(actor);
    const db = this.#read();
    const orgs = db.prepare('SELECT id, slug, name, state, policies, created_by, created_at FROM orgs ORDER BY name COLLATE NOCASE, id').all() as unknown as OrgRow[];
    const owners = db
      .prepare(
        `SELECT m.org_id, m.user_id, u.email, CASE WHEN m.user_id = '${FOUNDING_USER_ID}' THEN 1 WHEN u.state = 'active' THEN 1 ELSE 0 END AS active
         FROM org_members m LEFT JOIN users u ON u.id = m.user_id OR (m.user_id = '${FOUNDING_USER_ID}' AND u.founder = 1)
         WHERE m.role = 'owner' AND m.state = 'active' ORDER BY m.added_at, m.user_id`,
      )
      .all() as { org_id: string; user_id: string; email: string | null; active: number }[];
    const counts = new Map(
      (db.prepare("SELECT org_id, count(*) AS n FROM org_members WHERE state = 'active' GROUP BY org_id").all() as { org_id: string; n: number }[]).map((r) => [r.org_id, r.n]),
    );
    return orgs.map((o) => {
      const own = owners.filter((r) => r.org_id === o.id).map((r) => ({ userId: r.user_id, email: r.email, active: r.active === 1 }));
      return {
        id: o.id,
        slug: o.slug,
        name: o.name,
        state: o.state,
        members: counts.get(o.id) ?? 0,
        owners: own,
        needsOwner: !own.some((r) => r.active),
        createdBy: o.created_by,
        createdAt: o.created_at,
      };
    });
  }

  /**
   * Recovers an org whose owners' accounts are all gone or disabled (§6.7, OS8): makes an active account its owner. Instance admins only, as a
   * person, with a reason (at least 10 characters); refused while the org has an owner whose account is active. Writes a `medium` audit row.
   * The Admin console adds the fresh re-auth and the notification to the org's admins (slice 4).
   */
  recoverOwner(actor: Actor, id: OrgId, userId: UserId, reason: string): void {
    requireInstanceAdmin(actor);
    const why = typeof reason === 'string' ? clean(reason) : '';
    if (why.length < 10) throw new AppError('VALIDATION_FAILED', 'Say why, in at least 10 characters.', { details: { reason: 'Too short.' } });
    const state = this.stateOf(id);
    if (!state || state === 'deleting') throw notFound();
    const summary = this.listAll(actor).find((o) => o.id === id);
    if (!summary?.needsOwner) throw new AppError('CONFLICT', 'The organization has an active owner.');
    if (!this.#accountActive(userId)) throw new AppError('NOT_FOUND', 'No such account.');
    const by = actorString(actor);
    const db = this.#write();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        `INSERT INTO org_members (org_id, user_id, role, state, via, added_by, added_at) VALUES (?, ?, 'owner', 'active', 'recovered', ?, ?)
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = 'owner', state = 'active', via = 'recovered', added_by = excluded.added_by, ended_at = NULL`,
      ).run(id, userId, by, this.#now().toISOString());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    this.#record('org.ownership_recovered', actor, id, userId, { owner: userId, reason: why }, 'medium');
  }

  #record(kind: string, actor: Actor, orgId: OrgId, userId: UserId | null, detail: Record<string, unknown>, severity: AuditInput['severity'] = 'info'): void {
    this.#audit({ kind, severity, actor: actorString(actor), userId, subject: `org:${orgId}`, detail: { orgId, ...detail } });
  }
}
