// Organizations slice 7 (docs/prd/organizations.md §6.1, §6.4, §6.5, §13.2 row 7): teams of an org, shares to an org or its teams, and the
// audit of org owners and admins reading members' sessions (OD-3). Read this before calling it.
//
// TEAMS (`teams.org_id`, migration 475). Members and up see the org's teams, a guest only the teams they are in. Creating one: an org owner or
// admin, or a member while the policy `membersCreateTeams` is on (the default); the creator is its first owner. Adding or removing people, or
// deleting the team: an org owner or admin, or an owner of the team (anyone may take themselves out). Only an ACTIVE member of the org may be
// put in a team (service and trigger); leaving the org leaves its teams (trigger). A deleted team ends its shares (trigger, migration 476).
//
// SHARES (`org_shares` + `grants`, migration 476). A PERSON holding `manage` on a workspace, a ticket bucket or a vault, who is a member or up
// of the org, shares it to the org (view or operate; never manage: §6.4) or to one of the org's teams (view, operate, or manage when they own
// it: the object's personal owner, or an org owner or admin for an org object). An org-owned object is shared only inside its own org (the
// policy `externalShares` is not built: no share to another org's subjects). An operate share of a workspace with credential sets assigned
// needs `acknowledgeExposure` (409 SHARE_EXPOSES_CREDENTIALS lists them): anyone who can operate it can read them. The grant is a `grants`
// row whose share id is the `org_shares` id, read on every decision (authz/grants.ts: guests never receive the org's grants; a team's grants
// count only while the user is an active member of the team's org). A share of the sharer's OWN object ends when the sharer leaves the org
// (trigger). Revoking: the sharer, a manager of the object, or an org owner or admin; every member who held it gets an access change
// (`share_ended`), so their sockets drop what they may no longer view and their sessions in a workspace they may no longer operate stop
// (chat/accessStop.ts). Audit: `org.share_created|ended`, `org.team_created|removed|member_set|member_removed`.
//
// FINE-GRAINED ACCESS (docs/prd/access.md, owner request 2026-11-01). A share may also go to ONE PERSON who is an active member of the org (a
// guest too), may END by itself (`expiresAt`: the grant's own `expires_at` is what every decision reads, so access stops at that instant;
// `sweepExpired` only closes the record, writes `org.share_expired` and tells the receivers' sockets) and carries a note. Who may grant
// (`ceiling`): a person holding `manage` on the object, never above their own level and never past their own end: the object's personal
// owner; for an org object its org's owners, its admins while the policy `adminsMayShare` is on (the default), or anyone holding manage on
// it through a grant (delegation: a creator grant, a manage share to them or their team). A guest never grants.
//
// TRANSCRIPT READS (OD-3). The seam gives an org owner or admin `view` on a member's session in an org-owned workspace and calls
// `transcriptRead` (authz/seam.ts `orgReadOfSession`); this writes `org.transcript_viewed` (no content: viewer, session, member, workspace)
// with `user_id` = the member, so the member reads it in their own platform audit (`GET /api/platform/audit?kind=org.transcript_viewed`) and
// the org's owners read the org's rows (`transcriptViews`). De-duplicated per viewer and session for a minute.

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import {
  ACCESS_LIMITS,
  LEVEL_RANK,
  ORG_POLICY_DEFAULTS,
  ORGS_ERROR_CODES,
  actorString,
  actorUserId,
  isUserId,
  objectRef,
  orgRef,
  type Actor,
  type AccessLevel,
  type CreateOrgShareRequest,
  type CreateOrgTeamRequest,
  type ObjectRef,
  type OrgId,
  type OrgRole,
  type OrgShare,
  type OrgTeam,
  type OrgTeamMember,
  type OrgTeamRole,
  type OrgTranscriptView,
  type OrgTransferKind,
  type UserId,
} from '@portal/contracts';
import type { Grants } from '../authz/grants.js';
import { can, emitAccessChange, levelOf, requireCan, resolve, type ResolvedObject } from '../authz/seam.js';
import type { AuditInput } from '../platform/audit.js';
import type { OrgsService } from './service.js';
import type { WorkspaceCredentials } from './transfer.js';

const KINDS: readonly OrgTransferKind[] = ['workspace', 'ticket_bucket', 'vault'];
const LEVELS = ['view', 'operate', 'manage'] as const;
const READ_DEDUPE_MS = 60_000;
const TEAM_NAME_MAX = 40;
const TEAM_DESCRIPTION_MAX = 200;

const notFound = (text = 'Not found.') => new AppError('NOT_FOUND', text);
const clean = (v: string) => v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const isManager = (role: OrgRole | null) => role === 'owner' || role === 'admin';

export interface ShareRow {
  id: string;
  org_id: string;
  object_type: OrgTransferKind;
  object_id: string;
  subject_kind: 'org' | 'team' | 'user';
  subject_id: string;
  level: (typeof LEVELS)[number];
  personal: number;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  note: string | null;
  team_name: string | null;
  user_name?: string | null;
}

/** What a person may grant on one object (docs/prd/access.md §4): the highest level (none: may not grant), and the latest end (null: none). */
export interface GrantCeiling {
  max: AccessLevel | null;
  until: string | null;
  /** Why not, in words, when `max` is null. */
  why?: string;
  reason?: string;
}

export interface OrgSharingDeps {
  db: () => DatabaseSync | null;
  writable?: () => DatabaseSync | null;
  orgs: OrgsService;
  grants: Grants;
  audit: (e: AuditInput) => void;
  credentials?: WorkspaceCredentials | null;
  now?: () => Date;
}

export class OrgSharing {
  readonly #db: () => DatabaseSync | null;
  readonly #w: () => DatabaseSync | null;
  readonly #orgs: OrgsService;
  readonly #grants: Grants;
  readonly #audit: (e: AuditInput) => void;
  readonly #credentials: WorkspaceCredentials | null;
  readonly #now: () => Date;
  readonly #recentReads = new Map<string, number>();

  constructor(deps: OrgSharingDeps) {
    this.#db = deps.db;
    this.#w = deps.writable ?? deps.db;
    this.#orgs = deps.orgs;
    this.#grants = deps.grants;
    this.#audit = deps.audit;
    this.#credentials = deps.credentials ?? null;
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

  /** The person's active role in the ACTIVE org, after the org's own 404 for anyone who may not see it. */
  #role(actor: Actor, orgId: OrgId): { userId: UserId; role: OrgRole } {
    requireCan(actor, 'view', orgRef(orgId));
    const userId = actorUserId(actor);
    const role = userId && this.#orgs.stateOf(orgId) === 'active' ? this.#orgs.roleOf(orgId, userId) : null;
    if (!userId || !role) throw notFound();
    return { userId, role };
  }

  #person(actor: Actor): void {
    if (actor.kind !== 'user') throw new AppError('FORBIDDEN', 'A person does this, not a token or an agent.');
  }

  #record(kind: string, actor: Actor, orgId: OrgId, subject: string, detail: Record<string, unknown>, severity: AuditInput['severity'] = 'info'): void {
    // `orgId`: the row is the org's (its Audit section reads rows by org_id; the subject here is a team or an object, not the org).
    this.#audit({ kind, severity, actor: actorString(actor), userId: actorUserId(actor), subject, orgId, detail: { orgId, ...detail } });
  }

  /* ---------- Teams ---------- */

  #teamRow(orgId: OrgId, teamId: string): { id: string; name: string } {
    const r = this.#read().prepare('SELECT id, name FROM teams WHERE id = ? AND org_id = ?').get(teamId, orgId) as { id: string; name: string } | undefined;
    if (!r) throw notFound('No such team.');
    return r;
  }

  #teamRole(teamId: string, userId: UserId): OrgTeamRole | null {
    return (this.#read().prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get(teamId, userId) as { role: OrgTeamRole } | undefined)?.role ?? null;
  }

  #teamMemberIds(teamId: string): UserId[] {
    return (this.#read().prepare('SELECT user_id FROM team_members WHERE team_id = ?').all(teamId) as { user_id: UserId }[]).map((r) => r.user_id);
  }

  teams(actor: Actor, orgId: OrgId): OrgTeam[] {
    const { userId, role } = this.#role(actor, orgId);
    const rows = this.#read()
      .prepare(
        `SELECT t.id, t.name, t.description, t.created_at, (SELECT count(*) FROM team_members m WHERE m.team_id = t.id) AS members,
                (SELECT role FROM team_members m WHERE m.team_id = t.id AND m.user_id = ?) AS my_role
         FROM teams t WHERE t.org_id = ? ORDER BY t.name_key`,
      )
      .all(userId, orgId) as { id: string; name: string; description: string | null; created_at: string; members: number; my_role: OrgTeamRole | null }[];
    return rows
      .filter((r) => role !== 'guest' || r.my_role)
      .map((r) => ({ id: r.id, orgId, name: r.name, description: r.description, members: r.members, createdAt: r.created_at, ...(r.my_role ? { myRole: r.my_role } : {}) }));
  }

  #membersCreateTeams(orgId: OrgId): boolean {
    const raw = (this.#read().prepare('SELECT policies FROM orgs WHERE id = ?').get(orgId) as { policies?: string } | undefined)?.policies;
    try {
      const v = (JSON.parse(raw ?? '{}') as { membersCreateTeams?: unknown }).membersCreateTeams;
      return typeof v === 'boolean' ? v : ORG_POLICY_DEFAULTS.membersCreateTeams;
    } catch {
      return ORG_POLICY_DEFAULTS.membersCreateTeams;
    }
  }

  createTeam(actor: Actor, orgId: OrgId, req: Partial<CreateOrgTeamRequest>): OrgTeam {
    this.#person(actor);
    const { userId, role } = this.#role(actor, orgId);
    if (!isManager(role) && !(role === 'member' && this.#membersCreateTeams(orgId))) throw new AppError('FORBIDDEN', 'You can’t create teams in this organization.');
    const name = typeof req.name === 'string' ? clean(req.name) : '';
    if (!name || name.length > TEAM_NAME_MAX) throw new AppError('VALIDATION_FAILED', `Give it a name of at most ${TEAM_NAME_MAX} characters.`, { details: { name: 'Required.' } });
    const description = typeof req.description === 'string' ? clean(req.description) || null : null;
    if (description && description.length > TEAM_DESCRIPTION_MAX) throw new AppError('VALIDATION_FAILED', 'Keep the description short.', { details: { description: 'Too long.' } });
    const db = this.#write();
    if (db.prepare('SELECT 1 FROM teams WHERE org_id = ? AND name_key = ?').get(orgId, name.toLowerCase()))
      throw new AppError('CONFLICT', 'A team with that name exists.', { details: { name: 'Already used.' } });
    const id = `tm_${randomBytes(9).toString('base64url')}`;
    const at = this.#now().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO teams (id, name, name_key, description, created_by, created_at, org_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, name, name.toLowerCase(), description, userId, at, orgId);
      db.prepare("INSERT INTO team_members (team_id, user_id, role, added_by, added_at) VALUES (?, ?, 'owner', ?, ?)").run(id, userId, userId, at);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    this.#record('org.team_created', actor, orgId, `team:${id}`, { teamId: id, name });
    return { id, orgId, name, description, members: 1, myRole: 'owner', createdAt: at };
  }

  #requireTeamManager(teamId: string, userId: UserId, role: OrgRole): void {
    if (isManager(role) || this.#teamRole(teamId, userId) === 'owner') return;
    throw new AppError('FORBIDDEN', 'Only an owner of the team or an admin of the organization can do this.');
  }

  removeTeam(actor: Actor, orgId: OrgId, teamId: string): void {
    this.#person(actor);
    const { userId, role } = this.#role(actor, orgId);
    this.#teamRow(orgId, teamId);
    this.#requireTeamManager(teamId, userId, role);
    const members = this.#teamMemberIds(teamId);
    const shares = this.#openShares('SELECT s.*, NULL AS team_name FROM org_shares s WHERE s.subject_kind = ? AND s.subject_id = ? AND s.ended_at IS NULL', 'team', teamId);
    const db = this.#write();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM team_members WHERE team_id = ?').run(teamId); // not left to ON DELETE CASCADE: foreign keys may be off
      db.prepare('DELETE FROM teams WHERE id = ?').run(teamId); // the trigger ends its shares and their grants
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    this.#record('org.team_removed', actor, orgId, `team:${teamId}`, { teamId, sharesEnded: shares.length });
    for (const u of members) for (const s of shares) emitAccessChange({ userId: u, ref: objectRef(s.object_type, s.object_id), why: 'share_ended' });
  }

  teamMembers(actor: Actor, orgId: OrgId, teamId: string): OrgTeamMember[] {
    const { userId, role } = this.#role(actor, orgId);
    this.#teamRow(orgId, teamId);
    if (role === 'guest' && !this.#teamRole(teamId, userId)) throw notFound('No such team.');
    return (
      this.#read()
        .prepare('SELECT m.user_id, m.role, m.added_at, u.display_name FROM team_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY m.role DESC, m.added_at')
        .all(teamId) as { user_id: UserId; role: OrgTeamRole; added_at: string; display_name: string | null }[]
    ).map((r) => ({ userId: r.user_id, displayName: r.display_name ?? r.user_id, role: r.role, addedAt: r.added_at }));
  }

  setTeamMember(actor: Actor, orgId: OrgId, teamId: string, memberId: string, teamRole: unknown): OrgTeamMember[] {
    this.#person(actor);
    const { userId, role } = this.#role(actor, orgId);
    this.#teamRow(orgId, teamId);
    this.#requireTeamManager(teamId, userId, role);
    if (teamRole !== 'owner' && teamRole !== 'member') throw new AppError('VALIDATION_FAILED', 'Choose owner or member.', { details: { role: 'owner or member' } });
    if (!isUserId(memberId) || !this.#orgs.roleOf(orgId, memberId))
      throw new AppError('VALIDATION_FAILED', 'Only members of the organization can be in its teams.', { details: { reason: ORGS_ERROR_CODES.TEAM_NOT_ORG_MEMBER } });
    if (teamRole === 'member' && this.#teamRole(teamId, memberId) === 'owner') this.#keepTeamOwner(teamId, memberId);
    try {
      this.#write()
        .prepare('INSERT INTO team_members (team_id, user_id, role, added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (team_id, user_id) DO UPDATE SET role = excluded.role')
        .run(teamId, memberId, teamRole, userId, this.#now().toISOString());
    } catch (e) {
      if (String((e as Error).message).includes('TEAM_NOT_ORG_MEMBER'))
        throw new AppError('VALIDATION_FAILED', 'Only members of the organization can be in its teams.', { details: { reason: ORGS_ERROR_CODES.TEAM_NOT_ORG_MEMBER } });
      throw e;
    }
    this.#record('org.team_member_set', actor, orgId, `team:${teamId}`, { teamId, member: memberId, role: teamRole });
    return this.teamMembers(actor, orgId, teamId);
  }

  removeTeamMember(actor: Actor, orgId: OrgId, teamId: string, memberId: string): void {
    this.#person(actor);
    const { userId, role } = this.#role(actor, orgId);
    this.#teamRow(orgId, teamId);
    if (memberId !== userId) this.#requireTeamManager(teamId, userId, role);
    if (!isUserId(memberId) || !this.#teamRole(teamId, memberId)) throw notFound('No such member.');
    if (this.#teamRole(teamId, memberId) === 'owner' && !isManager(role)) this.#keepTeamOwner(teamId, memberId);
    this.#write().prepare('DELETE FROM team_members WHERE team_id = ? AND user_id = ?').run(teamId, memberId);
    this.#record('org.team_member_removed', actor, orgId, `team:${teamId}`, { teamId, member: memberId });
    for (const s of this.#openShares('SELECT s.*, NULL AS team_name FROM org_shares s WHERE s.subject_kind = ? AND s.subject_id = ? AND s.ended_at IS NULL', 'team', teamId))
      emitAccessChange({ userId: memberId, ref: objectRef(s.object_type, s.object_id), why: 'share_ended' });
  }

  #keepTeamOwner(teamId: string, leaving: string): void {
    const n = (this.#read().prepare("SELECT count(*) AS n FROM team_members WHERE team_id = ? AND role = 'owner' AND user_id != ?").get(teamId, leaving) as { n: number }).n;
    if (n === 0) throw new AppError('CONFLICT', 'A team keeps at least one owner. Make someone else an owner first.');
  }

  /* ---------- Shares ---------- */

  #openShares(sql: string, ...args: string[]): ShareRow[] {
    return this.#read().prepare(sql).all(...args) as unknown as ShareRow[];
  }

  view(r: ShareRow): OrgShare {
    return {
      id: r.id,
      orgId: r.org_id as OrgId,
      target: { type: r.object_type, id: r.object_id },
      subject:
        r.subject_kind === 'org'
          ? { kind: 'org' }
          : r.subject_kind === 'user'
            ? { kind: 'user', userId: r.subject_id as UserId, name: r.user_name ?? r.subject_id }
            : { kind: 'team', teamId: r.subject_id, name: r.team_name ?? 'a removed team' },
      level: r.level,
      personal: r.personal === 1,
      createdBy: r.created_by as UserId,
      createdAt: r.created_at,
      expiresAt: r.expires_at ?? null,
      note: r.note ?? null,
    };
  }

  static SELECT =
    "SELECT s.*, t.name AS team_name, u.display_name AS user_name FROM org_shares s LEFT JOIN teams t ON s.subject_kind = 'team' AND t.id = s.subject_id LEFT JOIN users u ON s.subject_kind = 'user' AND u.id = s.subject_id";

  /** The open shares in an org of one object (the Access sheet), oldest first; ended or expired ones are not listed. */
  sharesOf(orgId: OrgId, ref: ObjectRef): OrgShare[] {
    return this.#openShares(
      `${OrgSharing.SELECT} WHERE s.org_id = ? AND s.object_type = ? AND s.object_id = ? AND s.ended_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?) ORDER BY s.created_at, s.id`,
      orgId,
      ref.type,
      ref.id,
      this.#now().toISOString(),
    ).map((r) => this.view(r));
  }

  /** One share by id (open or not), as the API shows it, or null. */
  shareById(shareId: string): OrgShare | null {
    const r = this.#read().prepare(`${OrgSharing.SELECT} WHERE s.id = ?`).get(shareId) as ShareRow | undefined;
    return r ? this.view(r) : null;
  }

  /** One open share by id in the org, or null. */
  shareRow(orgId: OrgId, shareId: string): ShareRow | null {
    return (this.#read().prepare(`${OrgSharing.SELECT} WHERE s.id = ? AND s.org_id = ? AND s.ended_at IS NULL`).get(shareId, orgId) as ShareRow | undefined) ?? null;
  }

  /** The org's policy `adminsMayShare` (default on). */
  #adminsMayShare(orgId: OrgId): boolean {
    return this.#orgs.policiesOf(orgId).adminsMayShare;
  }

  /**
   * What `actor` may grant on a resolved object in `orgId` (docs/prd/access.md §4). Needs manage on it (read through the seam, so a suspended
   * org, SSO or a token's cap count), never above that level, never past the end of the access it comes from. A person only; a guest never.
   */
  ceiling(actor: Actor, orgId: OrgId, role: OrgRole, found: ResolvedObject): GrantCeiling {
    const userId = actorUserId(actor);
    if (actor.kind !== 'user' || !userId) return { max: null, until: null, why: 'A person grants access, not a token or an agent.' };
    if (role === 'guest') return { max: null, until: null, why: 'A guest can’t share.' };
    const owner = found.owner;
    if (owner?.kind === 'org' && owner.id !== orgId) return { max: null, until: null, why: 'An organization’s object is shared only inside its organization.' };
    const mine = levelOf(actor, found.ref);
    if (mine !== 'manage') return { max: null, until: null, why: 'Only who manages it can share it.' };
    const sources = this.#grants.sourcesFor(found.ref, userId, found).filter((g) => g.level === 'manage');
    // The end of the delegated access: the latest end among the grants that give manage (none of them ends: no limit).
    const delegatedUntil = sources.length === 0 ? null : sources.some((g) => !g.expiresAt) ? null : sources.map((g) => g.expiresAt!).sort().at(-1)!;
    if (owner?.kind === 'user' && owner.id === userId) return { max: 'manage', until: null };
    if (owner?.kind === 'org') {
      if (role === 'owner') return { max: 'manage', until: null };
      if (role === 'admin' && this.#adminsMayShare(orgId)) return { max: 'manage', until: null };
      if (sources.length) return { max: 'manage', until: delegatedUntil };
      return { max: null, until: null, why: 'The organization’s owners share its objects.', reason: ORGS_ERROR_CODES.ACCESS_SHARING_OWNERS_ONLY };
    }
    // Someone else's personal object they manage through a grant (a manage share to them or their team): up to manage, until that ends.
    if (sources.length) return { max: 'manage', until: delegatedUntil };
    return { max: null, until: null, why: 'Only who manages it can share it.' };
  }

  /** An end as given: null for none; else an ISO time at least a minute ahead and at most ACCESS_LIMITS.maxDays out. */
  #until(raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === '') return null;
    const t = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
    const now = this.#now().getTime();
    if (!Number.isFinite(t) || t < now + ACCESS_LIMITS.minAheadMs || t > now + ACCESS_LIMITS.maxDays * 86_400_000)
      throw new AppError('VALIDATION_FAILED', `Choose an end between a minute and ${ACCESS_LIMITS.maxDays} days from now.`, { details: { expiresAt: 'Out of range.' } });
    return new Date(t).toISOString();
  }

  /** A note as given: null for none; control characters folded, at most ACCESS_LIMITS.noteMax characters. */
  note(raw: unknown): string | null {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string') throw new AppError('VALIDATION_FAILED', 'A note is text.', { details: { note: 'Text.' } });
    const v = clean(raw);
    if (v.length > ACCESS_LIMITS.noteMax) throw new AppError('VALIDATION_FAILED', `Keep the note under ${ACCESS_LIMITS.noteMax} characters.`, { details: { note: 'Too long.' } });
    return v || null;
  }

  /** Members and up: the org's open shares whose object they may view; owners and admins: every one (to revoke). A guest: none. */
  shares(actor: Actor, orgId: OrgId): OrgShare[] {
    const { role } = this.#role(actor, orgId);
    if (role === 'guest') return [];
    const rows = this.#openShares(
      `${OrgSharing.SELECT} WHERE s.org_id = ? AND s.ended_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?) ORDER BY s.created_at, s.id`,
      orgId,
      this.#now().toISOString(),
    );
    return rows.filter((r) => isManager(role) || can(actor, 'view', objectRef(r.object_type, r.object_id)).allow).map((r) => this.view(r));
  }

  share(actor: Actor, orgId: OrgId, req: Partial<CreateOrgShareRequest>, opts: { audit?: Record<string, unknown> } = {}): OrgShare {
    this.#person(actor);
    const { userId, role } = this.#role(actor, orgId);
    if (role === 'guest') throw new AppError('FORBIDDEN', 'A guest can’t share to the organization.');
    const kind = req.target?.type;
    const rawId = req.target?.id;
    if (!kind || !KINDS.includes(kind) || typeof rawId !== 'string' || !rawId) throw notFound();
    const found = resolve(objectRef(kind, rawId));
    if (!found) throw notFound();
    const ref: ObjectRef = found.ref;
    requireCan(actor, 'manage', ref);

    const level = req.level;
    if (!level || !(LEVELS as readonly string[]).includes(level)) throw new AppError('VALIDATION_FAILED', 'Choose view, operate or manage.', { details: { level: 'Unknown level.' } });
    const owner = found.owner;
    if (owner?.kind === 'org' && owner.id !== orgId) throw new AppError('FORBIDDEN', 'An organization’s object is shared only inside its organization.');
    const personal = owner?.kind !== 'org';
    const expiresAt = this.#until(req.expiresAt);
    const note = this.note(req.note);

    // The ceiling (docs/prd/access.md §4): who may grant here, up to which level and until when.
    const cap = this.ceiling(actor, orgId, role, found);
    if (!cap.max) throw new AppError('FORBIDDEN', cap.why ?? 'You can’t share this.', cap.reason ? { details: { reason: cap.reason } } : undefined);
    if (LEVEL_RANK[level] > LEVEL_RANK[cap.max] || (cap.until && (!expiresAt || expiresAt > cap.until)))
      throw new AppError('FORBIDDEN', 'You can’t give more than you have.', { details: { reason: ORGS_ERROR_CODES.ACCESS_ABOVE_OWN, max: cap.max, maxUntil: cap.until } });

    const subject = req.subject;
    let subjectId: string;
    let teamName: string | null = null;
    if (subject?.kind === 'org') {
      if (level === 'manage') throw new AppError('VALIDATION_FAILED', 'A whole organization gets view or operate, never manage.', { details: { level: 'view or operate' } });
      subjectId = orgId;
    } else if (subject?.kind === 'team' && typeof subject.teamId === 'string') {
      teamName = this.#teamRow(orgId, subject.teamId).name;
      subjectId = subject.teamId;
    } else if (subject?.kind === 'user' && typeof subject.userId === 'string') {
      // One person: an active member of the org (a guest too); never yourself (you hold what you hold).
      if (!isUserId(subject.userId) || !this.#orgs.roleOf(orgId, subject.userId)) throw new AppError('VALIDATION_FAILED', 'Share with a member of the organization.', { details: { subject: 'Not a member.' } });
      if (subject.userId === userId) throw new AppError('VALIDATION_FAILED', 'You already hold your own access.', { details: { subject: 'Yourself.' } });
      subjectId = subject.userId;
    } else throw new AppError('VALIDATION_FAILED', 'Share to the organization, one of its teams or one of its members.', { details: { subject: 'org, team or user' } });

    // The consent rule (Sharing D19, §6.4 "credentials off by default"): operating a workspace reads the credential sets delivered into it.
    if (kind === 'workspace' && level !== 'view' && this.#credentials && req.acknowledgeExposure !== true) {
      const assigned = this.#credentials.list(ref.id);
      if (assigned.length)
        throw new AppError('CONFLICT', 'Anyone who can operate this workspace can read its credentials.', {
          details: { reason: ORGS_ERROR_CODES.SHARE_EXPOSES_CREDENTIALS, credentials: assigned },
        });
    }

    const db = this.#write();
    const at = this.#now().toISOString();
    const by = actorString(actor);
    let uid: string | null = null;
    if (kind === 'workspace') {
      uid = (db.prepare('SELECT id FROM workspace_identities WHERE legacy_id = ? AND removed_at IS NULL').get(ref.id) as { id: string } | undefined)?.id ?? null;
      if (!uid) throw notFound();
    }
    const existing = db
      .prepare('SELECT id, level, expires_at FROM org_shares WHERE object_type = ? AND object_id = ? AND subject_kind = ? AND subject_id = ? AND ended_at IS NULL')
      .get(kind, ref.id, subject.kind, subjectId) as { id: string; level: string; expires_at: string | null } | undefined;
    const id = existing?.id ?? `osh_${randomBytes(9).toString('base64url')}`;
    const grantSubject = subject.kind === 'org' ? ({ kind: 'org', id: orgId } as const) : subject.kind === 'team' ? ({ kind: 'team', id: subjectId } as const) : ({ kind: 'user', id: subjectId as UserId } as const);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (existing) db.prepare('UPDATE org_shares SET level = ?, expires_at = ?, note = ? WHERE id = ?').run(level, expiresAt, note, id);
      else
        db.prepare(
          'INSERT INTO org_shares (id, org_id, object_type, object_id, subject_kind, subject_id, level, personal, created_by, created_at, expires_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(id, orgId, kind, ref.id, subject.kind, subjectId, level, personal ? 1 : 0, userId, at, expiresAt, note);
      this.#grants.add(db, { ref, uid, subject: grantSubject, level, shareId: id, by, expiresAt });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    this.#record('org.share_created', actor, orgId, `${kind}:${ref.id}`, {
      shareId: id,
      subject: subject.kind,
      subjectId,
      level,
      personal,
      changedFrom: existing?.level ?? null,
      expiresAt,
      ...(note ? { note } : {}),
      ...opts.audit,
    });
    // A lowered level or an earlier end takes effect on the next call; open sockets re-check now.
    const narrowed = existing && (LEVEL_RANK[level] < LEVEL_RANK[existing.level as AccessLevel] || (expiresAt !== null && (existing.expires_at === null || expiresAt < existing.expires_at)));
    if (narrowed) for (const u of this.#receivers(orgId, subject.kind, subjectId)) emitAccessChange({ userId: u, ref, why: 'share_ended' });
    const row = db.prepare(`${OrgSharing.SELECT} WHERE s.id = ?`).get(id) as unknown as ShareRow;
    return this.view({ ...row, team_name: row.team_name ?? teamName });
  }

  /** Who held a share: the org's active members that are not guests, the team's members, or the one person. */
  #receivers(orgId: OrgId, kind: 'org' | 'team' | 'user', subjectId: string): UserId[] {
    if (kind === 'team') return this.#teamMemberIds(subjectId);
    if (kind === 'user') return isUserId(subjectId) ? [subjectId] : [];
    return (this.#read().prepare("SELECT user_id FROM org_members WHERE org_id = ? AND state = 'active' AND role != 'guest'").all(orgId) as { user_id: UserId }[]).map((r) => r.user_id);
  }

  revoke(actor: Actor, orgId: OrgId, shareId: string): void {
    this.#person(actor);
    const { userId, role } = this.#role(actor, orgId);
    const r = this.#read().prepare('SELECT * FROM org_shares WHERE id = ? AND org_id = ? AND ended_at IS NULL').get(shareId, orgId) as ShareRow | undefined;
    if (!r) throw notFound('No such share.');
    const ref = objectRef(r.object_type, r.object_id);
    if (r.created_by !== userId && !isManager(role) && !can(actor, 'manage', ref).allow) throw new AppError('FORBIDDEN', 'Only who shared it, a manager of it, or an admin of the organization can end it.');
    const receivers = this.#receivers(orgId, r.subject_kind, r.subject_id);
    const db = this.#write();
    db.exec('BEGIN IMMEDIATE');
    try {
      this.#grants.removeFor(db, ref, shareId);
      db.prepare("UPDATE org_shares SET ended_at = ?, ended_by = ?, end_reason = 'revoked' WHERE id = ?").run(this.#now().toISOString(), actorString(actor), shareId);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    this.#record('org.share_ended', actor, orgId, `${r.object_type}:${r.object_id}`, { shareId, subject: r.subject_kind, subjectId: r.subject_id, level: r.level });
    for (const u of receivers) emitAccessChange({ userId: u, ref, why: 'share_ended' });
  }

  /**
   * Closes the shares whose end has come (docs/prd/access.md §5). Access already stopped at that instant (every decision reads the grant's
   * `expires_at`); this deletes the grants, ends the record as 'expired', writes `org.share_expired` and tells the receivers' sockets.
   * Returns how many it closed. The portal runs it every minute.
   */
  sweepExpired(): number {
    const db = this.#w();
    if (!db) return 0;
    const now = this.#now().toISOString();
    const due = db.prepare('SELECT * FROM org_shares WHERE ended_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?').all(now) as unknown as ShareRow[];
    for (const r of due) {
      const ref = objectRef(r.object_type, r.object_id);
      const receivers = this.#receivers(r.org_id as OrgId, r.subject_kind, r.subject_id);
      db.exec('BEGIN IMMEDIATE');
      try {
        this.#grants.removeFor(db, ref, r.id);
        db.prepare("UPDATE org_shares SET ended_at = ?, ended_by = 'system:access-expiry', end_reason = 'expired' WHERE id = ? AND ended_at IS NULL").run(now, r.id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      this.#audit({
        kind: 'org.share_expired',
        severity: 'info',
        actor: 'system:access-expiry',
        userId: null,
        subject: `${r.object_type}:${r.object_id}`,
        orgId: r.org_id,
        detail: { orgId: r.org_id, shareId: r.id, subject: r.subject_kind, subjectId: r.subject_id, level: r.level, expiresAt: r.expires_at },
      });
      for (const u of receivers) emitAccessChange({ userId: u, ref, why: 'share_ended' });
    }
    return due.length;
  }

  /* ---------- Transcript reads (OD-3) ---------- */

  /** The seam's hook (`OrgAuthority.onTranscriptRead`): one `org.transcript_viewed` row for the member. Never throws. */
  transcriptRead(orgId: string, viewerId: UserId, sessionId: string, ownerId: UserId): void {
    try {
      const t = this.#now().getTime();
      const key = `${viewerId}|${sessionId}`;
      const last = this.#recentReads.get(key);
      if (last !== undefined && t - last < READ_DEDUPE_MS) return;
      this.#recentReads.set(key, t);
      if (this.#recentReads.size > 5000) for (const [k, v] of this.#recentReads) if (t - v >= READ_DEDUPE_MS) this.#recentReads.delete(k);
      const db = this.#db();
      const row = db?.prepare('SELECT workspace_id, started_by_account FROM chat_sessions WHERE id = ?').get(sessionId) as { workspace_id?: string; started_by_account?: string | null } | undefined;
      const starter = row?.started_by_account;
      const member = isUserId(starter) ? starter : ownerId;
      this.#audit({
        kind: 'org.transcript_viewed',
        severity: 'medium',
        actor: `user:${viewerId}`,
        userId: member,
        subject: `org:${orgId}`,
        detail: { orgId, viewer: viewerId, member, sessionId, workspaceId: row?.workspace_id ?? null },
      });
    } catch (e) {
      console.error(`[orgs] a transcript-read row could not be written: ${(e as Error).message}`);
    }
  }

  /** The org's transcript reads (org OWNERS, like the break-glass rows). */
  transcriptViews(actor: Actor, orgId: OrgId): OrgTranscriptView[] {
    const { role } = this.#role(actor, orgId);
    if (role !== 'owner' || actor.kind !== 'user') throw new AppError('FORBIDDEN', 'Only an owner of the organization sees this.');
    return (
      this.#read()
        .prepare("SELECT at, detail FROM platform_audit WHERE subject = ? AND kind = 'org.transcript_viewed' ORDER BY id DESC LIMIT 500")
        .all(`org:${orgId}`) as { at: string; detail: string }[]
    ).map((r) => {
      let d: Record<string, unknown> = {};
      try {
        d = JSON.parse(r.detail) as Record<string, unknown>;
      } catch {
        // an unreadable row shows empty fields
      }
      return {
        at: r.at,
        viewer: String(d.viewer ?? '') as UserId,
        member: String(d.member ?? '') as UserId,
        sessionId: String(d.sessionId ?? ''),
        workspaceId: typeof d.workspaceId === 'string' ? d.workspaceId : null,
      };
    });
  }
}
