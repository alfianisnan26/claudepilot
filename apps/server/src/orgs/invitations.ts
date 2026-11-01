// Organizations slice 8: invitations (docs/prd/organizations.md §6.8, §13.2 row 8). Read this header before calling it.
//
// - An invitation names an email (normalized) and a role (never `owner`: ownership is transferred, not invited). No mail is sent: the
//   inviter copies a link whose FRAGMENT carries the code (`/admin/org-invite#<code>`, Identity D7), so the code never travels in a request line or
//   a log. Only the code's sha256 is stored; the code is answered once, on create.
// - Who invites: the org's owners and admins (manage), and members when the policy `membersMayInvite` is on; never a guest, never a token
//   or an agent, never into a suspended org. Nobody invites to a role above their own.
// - Accepting needs a signed-in PERSON whose account email equals the invitation's, within 7 days, once (the claim is one conditional UPDATE,
//   so two accepts of one code cannot both win), into an ACTIVE org. Attempts are throttled per person (`auth_throttle` scope `invitation`),
//   wrong codes included. An email on a domain ANOTHER org has verified is refused (that org's IdP vouches for it; domains are slice 10).
// - The org's owners and admins list pending and expired invitations and revoke one at once.
// Audit: `org.member_invited`, `org.invitation_revoked`, `org.member_joined` (subject `org:<id>`; the email, never the code).

import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import {
  EMAIL,
  FOUNDING_USER_ID,
  ORG_INVITATION_LIMITS,
  ORG_ROLE_RANK,
  ORGS_ERROR_CODES,
  actorString,
  isOrgRole,
  normalizeEmail,
  orgRef,
  type AcceptedOrgInvitation,
  type Actor,
  type CreatedOrgInvitation,
  type OrgId,
  type OrgInvitation,
  type OrgInvitationRole,
  type UserId,
} from '@portal/contracts';
import { requireCan } from '../authz/seam.js';
import { fingerprint, Throttle } from '../identity/throttle.js';
import type { AuditInput } from '../platform/audit.js';
import type { OrgsService } from './service.js';

interface Row {
  id: string;
  org_id: string;
  email_key: string;
  role: OrgInvitationRole;
  invited_by: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

export const hashInvitationCode = (code: string): string => createHash('sha256').update(code).digest('hex');

const notFound = () => new AppError('NOT_FOUND', 'Not found.');
const invalid = () => new AppError('NOT_FOUND', 'This invitation is not valid. Ask for a new one.', { details: { reason: ORGS_ERROR_CODES.INVITATION_INVALID } });

export class OrgInvitations {
  readonly #db: () => DatabaseSync | null;
  readonly #w: () => DatabaseSync | null;
  readonly #orgs: OrgsService;
  readonly #audit: (e: AuditInput) => void;
  readonly #now: () => Date;
  readonly throttle: Throttle;

  constructor(deps: { db: () => DatabaseSync | null; writable?: () => DatabaseSync | null; orgs: OrgsService; audit: (e: AuditInput) => void; now?: () => Date }) {
    this.#db = deps.db;
    this.#w = deps.writable ?? deps.db;
    this.#orgs = deps.orgs;
    this.#audit = deps.audit;
    this.#now = deps.now ?? (() => new Date());
    this.throttle = new Throttle(this.#w, () => this.#now().getTime());
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

  #view(r: Row): OrgInvitation {
    return {
      id: r.id,
      email: r.email_key,
      role: r.role,
      invitedBy: r.invited_by,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      state: Date.parse(r.expires_at) <= this.#now().getTime() ? 'expired' : 'pending',
    };
  }

  /** The account's normalized email and whether it is active (`u_owner` is the founder row). */
  #account(userId: UserId): { email: string; active: boolean } | null {
    const r = this.#read()
      .prepare(`SELECT email_key, state FROM users WHERE id = ? OR (? = '${FOUNDING_USER_ID}' AND founder = 1) ORDER BY founder DESC LIMIT 1`)
      .get(userId, userId) as { email_key: string; state: string } | undefined;
    return r ? { email: r.email_key, active: r.state === 'active' } : null;
  }

  /** The active account with this email, if any (`u_owner` for the founder row). */
  #userByEmail(email: string): UserId | null {
    const r = this.#read().prepare('SELECT id, founder FROM users WHERE email_key = ?').get(email) as { id: string; founder?: number } | undefined;
    if (!r) return null;
    return (r.founder === 1 ? FOUNDING_USER_ID : r.id) as UserId;
  }

  /** An email on a domain verified by ANOTHER org (slice 10's `org_domains`) (migration 471): refused. */
  #otherOrgsDomain(orgId: OrgId, email: string): boolean {
    const domain = email.slice(email.lastIndexOf('@') + 1);
    try {
      return !!this.#read().prepare("SELECT 1 FROM org_domains WHERE domain = ? AND state = 'verified' AND org_id != ?").get(domain, orgId);
    } catch {
      return false;
    }
  }

  /** Creates an invitation and answers its code ONCE. See the header for who may. */
  create(actor: Actor, orgId: OrgId, req: { email?: unknown; role?: unknown }): CreatedOrgInvitation {
    if (actor.kind !== 'user') throw notFound();
    requireCan(actor, 'view', orgRef(orgId));
    const mine = this.#orgs.roleOf(orgId, actor.userId);
    if (!mine) throw notFound();
    if (this.#orgs.stateOf(orgId) !== 'active') throw new AppError('FORBIDDEN', 'The organization is suspended.');
    const manage = mine === 'owner' || mine === 'admin';
    if (!manage && !(mine === 'member' && this.#orgs.policiesOf(orgId).membersMayInvite)) throw new AppError('FORBIDDEN', 'Only owners and admins invite people here.');
    const role = req.role;
    if (!isOrgRole(role) || role === 'owner')
      throw new AppError('VALIDATION_FAILED', 'Pick admin, member or guest. Ownership is transferred, not invited.', { details: { role: 'One of admin, member, guest.' } });
    if (ORG_ROLE_RANK[role] > ORG_ROLE_RANK[mine]) throw new AppError('FORBIDDEN', 'You can’t invite someone to a role above your own.');
    const email = typeof req.email === 'string' ? normalizeEmail(req.email) : '';
    if (!EMAIL.test(email) || email.length > 254) throw new AppError('VALIDATION_FAILED', 'Give a valid email address.', { details: { email: 'An email address.' } });
    if (this.#otherOrgsDomain(orgId, email))
      throw new AppError('CONFLICT', 'That email belongs to another organization’s domain.', { details: { reason: ORGS_ERROR_CODES.INVITATION_OTHER_ORG_DOMAIN } });
    const existing = this.#userByEmail(email);
    if (existing && this.#orgs.roleOf(orgId, existing)) throw new AppError('CONFLICT', 'They are already a member.', { details: { reason: ORGS_ERROR_CODES.ALREADY_MEMBER } });

    const code = randomBytes(32).toString('base64url');
    const id = `oinv_${randomBytes(9).toString('base64url')}`;
    const now = this.#now();
    const at = now.toISOString();
    const expires = new Date(now.getTime() + ORG_INVITATION_LIMITS.ttlMs).toISOString();
    const by = actorString(actor);
    const db = this.#write();
    db.exec('BEGIN IMMEDIATE');
    try {
      // One live invitation per email: a new one replaces (revokes) the earlier one.
      db.prepare('UPDATE org_invitations SET revoked_at = ? WHERE org_id = ? AND email_key = ? AND used_at IS NULL AND revoked_at IS NULL').run(at, orgId, email);
      const pending = (db.prepare('SELECT count(*) AS n FROM org_invitations WHERE org_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?').get(orgId, at) as { n: number }).n;
      if (pending >= ORG_INVITATION_LIMITS.pendingMax) throw new AppError('CONFLICT', 'Too many open invitations. Revoke some first.');
      db.prepare('INSERT INTO org_invitations (id, org_id, email_key, role, code_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        id,
        orgId,
        email,
        role,
        hashInvitationCode(code),
        by,
        at,
        expires,
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    this.#record('org.member_invited', actor, orgId, actor.userId, { invitation: id, email, role });
    return { ...this.#view({ id, org_id: orgId, email_key: email, role, invited_by: by, created_at: at, expires_at: expires, used_at: null, revoked_at: null }), code };
  }

  /** Pending and expired invitations (not used, not revoked), newest first: owners and admins. */
  list(actor: Actor, orgId: OrgId): OrgInvitation[] {
    requireCan(actor, 'manage', orgRef(orgId));
    const rows = this.#read()
      .prepare('SELECT * FROM org_invitations WHERE org_id = ? AND used_at IS NULL AND revoked_at IS NULL ORDER BY created_at DESC, id LIMIT 500')
      .all(orgId) as unknown as Row[];
    return rows.map((r) => this.#view(r));
  }

  /** Revokes one at once (owners and admins). A used, revoked or unknown one is the 404. */
  revoke(actor: Actor, orgId: OrgId, invitationId: string): void {
    requireCan(actor, 'manage', orgRef(orgId));
    const r = this.#write()
      .prepare('UPDATE org_invitations SET revoked_at = ? WHERE id = ? AND org_id = ? AND used_at IS NULL AND revoked_at IS NULL')
      .run(this.#now().toISOString(), invitationId, orgId);
    if (Number(r.changes) === 0) throw notFound();
    this.#record('org.invitation_revoked', actor, orgId, null, { invitation: invitationId });
  }

  /** Accepts an invitation as the signed-in person. See the header for every rule; each refusal says why without naming other accounts. */
  accept(actor: Actor, req: { code?: unknown }): AcceptedOrgInvitation {
    if (actor.kind !== 'user') throw new AppError('FORBIDDEN', 'Sign in to accept an invitation.');
    const userId = actor.userId;
    this.throttle.assertQuota('invitation', fingerprint(userId), ORG_INVITATION_LIMITS.acceptPerWindow, ORG_INVITATION_LIMITS.acceptWindowMs);
    const code = typeof req.code === 'string' ? req.code.trim() : '';
    if (code.length < ORG_INVITATION_LIMITS.codeMin || code.length > ORG_INVITATION_LIMITS.codeMax) throw invalid();
    const row = this.#read().prepare('SELECT * FROM org_invitations WHERE code_hash = ?').get(hashInvitationCode(code)) as Row | undefined;
    if (!row || row.used_at || row.revoked_at || this.#orgs.stateOf(row.org_id) !== 'active') throw invalid();
    const nowMs = this.#now().getTime();
    if (Date.parse(row.expires_at) <= nowMs)
      throw new AppError('CONFLICT', 'This invitation has expired. Ask for a new one.', { details: { reason: ORGS_ERROR_CODES.INVITATION_EXPIRED } });
    const me = this.#account(userId);
    if (!me?.active || me.email !== row.email_key)
      throw new AppError('FORBIDDEN', 'This invitation is for another email address. Sign in with that one.', { details: { reason: ORGS_ERROR_CODES.INVITATION_EMAIL_MISMATCH } });
    if (this.#orgs.roleOf(row.org_id, userId)) throw new AppError('CONFLICT', 'You are already a member.', { details: { reason: ORGS_ERROR_CODES.ALREADY_MEMBER } });

    // Single use: one conditional UPDATE claims it; a second accept (another tab, a replay) finds nothing to claim.
    const at = new Date(nowMs).toISOString();
    const db = this.#write();
    const claimed = db
      .prepare('UPDATE org_invitations SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?')
      .run(at, userId, row.id, at);
    if (Number(claimed.changes) === 0) throw invalid();
    try {
      this.#orgs.admit(row.org_id, userId, row.role, 'invite', row.invited_by);
    } catch (e) {
      db.prepare('UPDATE org_invitations SET used_at = NULL, used_by = NULL WHERE id = ? AND used_by = ?').run(row.id, userId);
      throw e;
    }
    this.#record('org.member_joined', actor, row.org_id, userId, { invitation: row.id, email: row.email_key, role: row.role, via: 'invite', invitedBy: row.invited_by });
    const name = (this.#read().prepare('SELECT name FROM orgs WHERE id = ?').get(row.org_id) as { name: string } | undefined)?.name ?? '';
    return { orgId: row.org_id, orgName: name, role: row.role };
  }

  #record(kind: string, actor: Actor, orgId: OrgId, userId: UserId | null, detail: Record<string, unknown>): void {
    this.#audit({ kind, severity: 'info', actor: actorString(actor), userId, subject: `org:${orgId}`, detail: { orgId, ...detail } });
  }
}
