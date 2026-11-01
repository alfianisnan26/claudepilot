// Fine-grained org access (docs/prd/access.md; owner request 2026-11-01). Read this before calling it.
//
// One model, no second system: a grant is a `grants` row made by an org share (orgs/sharing.ts `share`, which now also takes ONE PERSON, an
// end and a note, and enforces the level ceiling). This service answers the questions around it and runs access requests:
//
//   - `catalog`: the org's objects a member may ask for, with what they hold now (members and up; a guest sees none: no directory).
//   - `object`: who can reach one object and WHY (its owner or the org's owners and admins, creator grants, every open share in this org),
//     what the caller may grant there (`OrgSharing.ceiling`: level and end), its credential sets (operate exposes them), and the caller's own
//     reasons and open request. Needs `view` on the object (else the same 404); the full list only for someone who may grant or an org
//     owner or admin.
//   - `person`: what one member reaches in the org and why, each item's level the SEAM's answer (`levelOf`, so a suspended org, a guest's
//     exclusion from org shares and SSO all count) and its reasons from the same grant query (`Grants.sourcesFor`). Org owners and admins,
//     or anyone for themselves.
//   - Requests: a member (not a guest) asks for a level on an ORG-OWNED object they hold less on, with a note. Whoever may grant it (the
//     ceiling) sees it and approves with a level and an end (a person share is made through `share`, so the ceiling, the credential consent
//     and the audit apply) or denies; the requester may cancel. One open request per person and object. The org's owners, its admins while
//     `adminsMayShare`, and the object's managers by grant are told (notify, kind `attention`); the requester is told the decision.
//
// Audit (the org's): `org.access_requested`, `org.access_request_approved|denied|cancelled`; grants and revokes write `org.share_created|ended`
// and the sweep `org.share_expired` (sharing.ts). Every route is declared `org` view (orgs/authz.ts); this decides the rest.

import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import {
  ACCESS_LEVELS,
  LEVEL_RANK,
  ORGS_ERROR_CODES,
  actorString,
  actorUserId,
  isUserId,
  levelAtLeast,
  objectRef,
  orgRef,
  type AccessCatalogItem,
  type AccessEntry,
  type AccessLevel,
  type AccessObjectType,
  type AccessReason,
  type AccessRequest,
  type AccessRequestState,
  type Actor,
  type CreateAccessRequest,
  type DecideAccessRequest,
  type Level,
  type ObjectAccess,
  type ObjectRef,
  type OrgId,
  type OrgRole,
  type OrgShare,
  type PersonAccess,
  type PersonAccessItem,
  type UserId,
} from '@portal/contracts';
import { CREATOR_SHARE, type Grants } from '../authz/grants.js';
import { asUser, can, levelOf, orgRoleIn, requireCan, resolve, type ResolvedObject } from '../authz/seam.js';
import type { AuditInput } from '../platform/audit.js';
import type { OrgsService } from './service.js';
import type { OrgSharing } from './sharing.js';
import type { WorkspaceCredentials } from './transfer.js';

const KINDS: readonly AccessObjectType[] = ['workspace', 'ticket_bucket', 'vault'];
const DECIDED_SHOWN = 50;

const notFound = (text = 'Not found.') => new AppError('NOT_FOUND', text);
const isManager = (role: OrgRole | null) => role === 'owner' || role === 'admin';

/** What the portal is told about a request (app.ts turns it into a notification to each user; delivery checks each recipient again). */
export interface AccessNotice {
  what: 'requested' | 'approved' | 'denied';
  orgId: OrgId;
  orgName: string;
  requestId: string;
  objectName: string;
}

interface RequestRow {
  id: string;
  org_id: string;
  object_type: AccessObjectType;
  object_id: string;
  requester: string;
  level: AccessLevel;
  note: string | null;
  state: AccessRequestState;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  granted_level: AccessLevel | null;
  expires_at: string | null;
  share_id: string | null;
  requester_name: string | null;
}

export interface OrgAccessDeps {
  db: () => DatabaseSync | null;
  writable?: () => DatabaseSync | null;
  orgs: OrgsService;
  sharing: OrgSharing;
  grants: Grants;
  audit: (e: AuditInput) => void;
  credentials?: WorkspaceCredentials | null;
  notify?: (to: UserId[], n: AccessNotice) => void;
  now?: () => Date;
}

export class OrgAccess {
  readonly #db: () => DatabaseSync | null;
  readonly #w: () => DatabaseSync | null;
  readonly #orgs: OrgsService;
  readonly #sharing: OrgSharing;
  readonly #grants: Grants;
  readonly #audit: (e: AuditInput) => void;
  readonly #credentials: WorkspaceCredentials | null;
  readonly #notify: (to: UserId[], n: AccessNotice) => void;
  readonly #now: () => Date;

  constructor(deps: OrgAccessDeps) {
    this.#db = deps.db;
    this.#w = deps.writable ?? deps.db;
    this.#orgs = deps.orgs;
    this.#sharing = deps.sharing;
    this.#grants = deps.grants;
    this.#audit = deps.audit;
    this.#credentials = deps.credentials ?? null;
    this.#notify = deps.notify ?? (() => undefined);
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

  #record(kind: string, actor: Actor, orgId: OrgId, subject: string, detail: Record<string, unknown>): void {
    this.#audit({ kind, severity: 'info', actor: actorString(actor), userId: actorUserId(actor), subject, orgId, detail: { orgId, ...detail } });
  }

  #userName(userId: string): string {
    const r = this.#read().prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as { display_name: string | null } | undefined;
    return r?.display_name ?? userId;
  }

  #orgName(orgId: string): string {
    return (this.#read().prepare('SELECT name FROM orgs WHERE id = ?').get(orgId) as { name: string } | undefined)?.name ?? orgId;
  }

  /** An object's name for people: a workspace's name, a bucket's name, a vault's name; its id when none is known. */
  nameOf(ref: { type: string; id: string }): string {
    const db = this.#read();
    try {
      if (ref.type === 'workspace') return (db.prepare('SELECT name FROM workspace_identities WHERE legacy_id = ? AND removed_at IS NULL').get(ref.id) as { name: string } | undefined)?.name ?? ref.id;
      if (ref.type === 'ticket_bucket') return (db.prepare('SELECT name FROM ticket_buckets WHERE key = ?').get(ref.id) as { name: string } | undefined)?.name ?? ref.id;
      if (ref.type === 'vault') return (db.prepare('SELECT name FROM kg_vaults WHERE id = ?').get(ref.id) as { name: string } | undefined)?.name ?? ref.id;
    } catch {
      // the id
    }
    return ref.id;
  }

  /** The org's own objects, then the personal objects shared into it (open shares), each once. */
  #objects(orgId: OrgId, withShared: boolean): { ref: ObjectRef; name: string }[] {
    const db = this.#read();
    const out: { ref: ObjectRef; name: string }[] = [];
    const seen = new Set<string>();
    const push = (type: AccessObjectType, id: string, name: string) => {
      const key = `${type}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ ref: objectRef(type, id), name });
    };
    for (const r of db
      .prepare(
        `SELECT w.workspace_id AS id, i.name FROM workspace_owners w JOIN workspace_identities i ON i.id = w.uid AND i.removed_at IS NULL
         WHERE w.owner_kind = 'org' AND w.owner_id = ? ORDER BY i.name`,
      )
      .all(orgId) as { id: string; name: string }[])
      push('workspace', r.id, r.name);
    for (const r of db.prepare("SELECT key AS id, name FROM ticket_buckets WHERE owner_kind = 'org' AND owner_id = ? ORDER BY name").all(orgId) as { id: string; name: string }[])
      push('ticket_bucket', r.id, r.name);
    for (const r of db.prepare("SELECT id, name FROM kg_vaults WHERE owner_kind = 'org' AND owner_id = ? AND deleted_at IS NULL ORDER BY name").all(orgId) as { id: string; name: string }[])
      push('vault', r.id, r.name);
    if (withShared)
      for (const r of db.prepare('SELECT DISTINCT object_type, object_id FROM org_shares WHERE org_id = ? AND ended_at IS NULL AND personal = 1').all(orgId) as {
        object_type: AccessObjectType;
        object_id: string;
      }[])
        push(r.object_type, r.object_id, this.nameOf({ type: r.object_type, id: r.object_id }));
    return out;
  }

  /** The target of a request body or a query, resolved; the same 404 for a bad type, a missing object and one the caller may not see. */
  #target(actor: Actor, type: unknown, id: unknown, verb: 'view' | null = 'view'): ResolvedObject {
    if (typeof type !== 'string' || !(KINDS as readonly string[]).includes(type) || typeof id !== 'string' || !id || id.length > 200) throw notFound();
    const found = resolve(objectRef(type as AccessObjectType, id));
    if (!found) throw notFound();
    if (verb) requireCan(actor, verb, found.ref);
    return found;
  }

  /** Whether `actor` (role `role`) may end a share: who made it, an org owner or admin, or a manager of the object (sharing.ts `revoke`). */
  #mayRevoke(actor: Actor, role: OrgRole, share: OrgShare): boolean {
    return share.createdBy === actorUserId(actor) || isManager(role) || can(actor, 'manage', objectRef(share.target.type, share.target.id)).allow;
  }

  /**
   * Why `userId` reaches a resolved object (the reasons only; the level is the seam's): owning it, an org role on an org-owned object, a
   * creator grant, and each counting share (`Grants.sourcesFor`, the same arms the decision reads). `viewer` decides `revocable`.
   */
  #reasons(userId: UserId, found: ResolvedObject, viewer: { actor: Actor; role: OrgRole } | null): AccessReason[] {
    const out: AccessReason[] = [];
    const owner = found.owner;
    if (owner?.kind === 'user' && owner.id === userId) out.push({ kind: 'owner', level: 'manage' });
    if (owner?.kind === 'org') {
      const role = orgRoleIn(owner.id, userId);
      if (isManager(role)) out.push({ kind: 'org_role', level: 'manage', role: role! });
    }
    for (const g of this.#grants.sourcesFor(found.ref, userId, found)) {
      if (g.shareId === CREATOR_SHARE) {
        out.push({ kind: 'creator', level: g.level });
        continue;
      }
      const share = this.#sharing.shareById(g.shareId);
      if (!share) continue; // a grant some other share made (not an org share): its level still counts in the seam's answer
      out.push({ kind: 'share', level: g.level, share, revocable: viewer ? this.#mayRevoke(viewer.actor, viewer.role, share) : false });
    }
    return out.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  }

  /** The level the seam gives `userId` on it now: the caller's own as they act, anyone else's as a job acting for them. */
  #levelOf(actor: Actor, userId: UserId, ref: ObjectRef): Level {
    return levelOf(actorUserId(actor) === userId ? actor : asUser(userId, 'access-explain'), ref);
  }

  /* ---------- Reading ---------- */

  catalog(actor: Actor, orgId: OrgId): AccessCatalogItem[] {
    const { userId, role } = this.#role(actor, orgId);
    if (role === 'guest') return [];
    const open = new Map(
      (this.#read().prepare("SELECT id, object_type, object_id FROM access_requests WHERE org_id = ? AND requester = ? AND state = 'open'").all(orgId, userId) as {
        id: string;
        object_type: string;
        object_id: string;
      }[]).map((r) => [`${r.object_type}:${r.object_id}`, r.id]),
    );
    return this.#objects(orgId, false).map((o) => ({
      target: { type: o.ref.type as AccessObjectType, id: o.ref.id },
      name: o.name,
      myLevel: levelOf(actor, o.ref),
      openRequest: open.get(`${o.ref.type}:${o.ref.id}`) ?? null,
    }));
  }

  object(actor: Actor, orgId: OrgId, type: unknown, id: unknown): ObjectAccess {
    const { userId, role } = this.#role(actor, orgId);
    const found = this.#target(actor, type, id);
    const ref = found.ref;
    const owner = found.owner;
    if (owner?.kind === 'org' && owner.id !== orgId) throw notFound();
    if (owner?.kind !== 'org' && owner?.kind !== 'user') throw notFound();
    const cap = this.#sharing.ceiling(actor, orgId, role, found);
    const mayGrant: AccessLevel[] = cap.max ? ACCESS_LEVELS.filter((l) => LEVEL_RANK[l] <= LEVEL_RANK[cap.max!]) : [];
    const full = mayGrant.length > 0 || isManager(role);
    const viewer = { actor, role };

    const entries: AccessEntry[] = [];
    if (full) {
      if (owner.kind === 'org')
        entries.push({ subject: { kind: 'org_managers', id: orgId, name: 'Owners and admins' }, level: 'manage', reason: { kind: 'org_role', level: 'manage', role: 'admin' } });
      else entries.push({ subject: { kind: 'user', id: owner.id, name: this.#userName(owner.id) }, level: 'manage', reason: { kind: 'owner', level: 'manage' } });
      for (const g of this.#grants.on(ref))
        if (g.shareId === CREATOR_SHARE && g.subjectKind === 'user' && isUserId(g.subjectId) && owner.kind === 'org' && this.#orgs.roleOf(orgId, g.subjectId))
          entries.push({ subject: { kind: 'user', id: g.subjectId, name: this.#userName(g.subjectId) }, level: 'manage', reason: { kind: 'creator', level: 'manage' } });
      for (const s of this.#sharing.sharesOf(orgId, ref)) {
        const subject: AccessEntry['subject'] =
          s.subject.kind === 'org'
            ? { kind: 'org', id: orgId, name: 'Everyone' }
            : s.subject.kind === 'team'
              ? { kind: 'team', id: s.subject.teamId, name: s.subject.name }
              : { kind: 'user', id: s.subject.userId, name: s.subject.name };
        entries.push({ subject, level: s.level, reason: { kind: 'share', level: s.level, share: s, revocable: this.#mayRevoke(actor, role, s) } });
      }
      entries.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
    }
    const openRow = this.#read()
      .prepare(`${REQUEST_SELECT} WHERE r.org_id = ? AND r.object_type = ? AND r.object_id = ? AND r.requester = ? AND r.state = 'open'`)
      .get(orgId, ref.type, ref.id, userId) as RequestRow | undefined;
    return {
      target: { type: ref.type as AccessObjectType, id: ref.id },
      name: this.nameOf(ref),
      owner: owner.kind === 'org' ? { kind: 'org', id: orgId, name: this.#orgName(orgId) } : { kind: 'user', id: owner.id, name: this.#userName(owner.id) },
      myLevel: levelOf(actor, ref),
      mayGrant,
      maxUntil: cap.until,
      entries,
      mine: this.#reasons(userId, found, viewer),
      credentials: mayGrant.length && ref.type === 'workspace' && this.#credentials ? this.#credentials.list(ref.id) : [],
      openRequest: openRow ? this.#requestView(openRow, actor, role) : null,
    };
  }

  person(actor: Actor, orgId: OrgId, memberId: string): PersonAccess {
    const { userId, role } = this.#role(actor, orgId);
    if (memberId !== userId && !isManager(role)) throw notFound();
    const theirs = isUserId(memberId) ? this.#orgs.roleOf(orgId, memberId) : null;
    if (!theirs || !isUserId(memberId)) throw notFound('No such member.');
    const items: PersonAccessItem[] = [];
    for (const o of this.#objects(orgId, true)) {
      const found = resolve(o.ref);
      if (!found) continue;
      const level = this.#levelOf(actor, memberId, o.ref);
      const reasons = this.#reasons(memberId, found, { actor, role });
      if (level === 'none' && reasons.length === 0) continue;
      items.push({ target: { type: o.ref.type as AccessObjectType, id: o.ref.id }, name: o.name, level, reasons });
    }
    items.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.name.localeCompare(b.name));
    return { userId: memberId, name: this.#userName(memberId), role: theirs, items };
  }

  /* ---------- Requests ---------- */

  #requestView(r: RequestRow, actor: Actor, role: OrgRole): AccessRequest {
    return {
      id: r.id,
      orgId: r.org_id as OrgId,
      target: { type: r.object_type, id: r.object_id },
      name: this.nameOf({ type: r.object_type, id: r.object_id }),
      requester: r.requester as UserId,
      requesterName: r.requester_name ?? r.requester,
      level: r.level,
      note: r.note,
      state: r.state,
      createdAt: r.created_at,
      decidedBy: (r.decided_by as UserId | null) ?? null,
      decidedAt: r.decided_at,
      decisionNote: r.decision_note,
      grantedLevel: r.granted_level,
      expiresAt: r.expires_at,
      mayDecide: r.state === 'open' && this.#mayDecide(actor, role, r),
    };
  }

  #mayDecide(actor: Actor, role: OrgRole, r: Pick<RequestRow, 'org_id' | 'object_type' | 'object_id' | 'requester'>): boolean {
    if (r.requester === actorUserId(actor)) return false;
    const found = resolve(objectRef(r.object_type, r.object_id));
    return !!found && !!this.#sharing.ceiling(actor, r.org_id as OrgId, role, found).max;
  }

  /** Who is told of a new request: the org's owners, its admins while `adminsMayShare`, and whoever manages the object through a grant. */
  #deciders(orgId: OrgId, ref: ObjectRef, requester: UserId): UserId[] {
    const policy = this.#orgs.policiesOf(orgId);
    const out = new Set<UserId>(
      (this.#read().prepare("SELECT user_id, role FROM org_members WHERE org_id = ? AND state = 'active' AND role IN ('owner', 'admin')").all(orgId) as { user_id: UserId; role: OrgRole }[])
        .filter((m) => m.role === 'owner' || policy.adminsMayShare)
        .map((m) => m.user_id),
    );
    for (const g of this.#grants.on(ref)) if (g.level === 'manage' && g.subjectKind === 'user' && isUserId(g.subjectId) && this.#orgs.roleOf(orgId, g.subjectId)) out.add(g.subjectId);
    out.delete(requester);
    return [...out];
  }

  requests(actor: Actor, orgId: OrgId): AccessRequest[] {
    const { userId, role } = this.#role(actor, orgId);
    const db = this.#read();
    const open = db.prepare(`${REQUEST_SELECT} WHERE r.org_id = ? AND r.state = 'open' ORDER BY r.created_at, r.id`).all(orgId) as unknown as RequestRow[];
    const decided = db.prepare(`${REQUEST_SELECT} WHERE r.org_id = ? AND r.state != 'open' ORDER BY r.decided_at DESC, r.id LIMIT ?`).all(orgId, DECIDED_SHOWN * 4) as unknown as RequestRow[];
    const out: AccessRequest[] = [];
    for (const r of open) if (r.requester === userId || this.#mayDecide(actor, role, r)) out.push(this.#requestView(r, actor, role));
    let shown = 0;
    for (const r of decided) {
      if (shown >= DECIDED_SHOWN) break;
      if (r.requester === userId || r.decided_by === userId || isManager(role)) {
        out.push(this.#requestView(r, actor, role));
        shown++;
      }
    }
    return out;
  }

  request(actor: Actor, orgId: OrgId, req: Partial<CreateAccessRequest>): AccessRequest {
    this.#person(actor);
    const { userId, role } = this.#role(actor, orgId);
    if (role === 'guest') throw new AppError('FORBIDDEN', 'A guest can’t ask for access here. Ask an admin.');
    // An org-owned object of THIS org only: a person's own object is theirs to share (no request flow there).
    const found = this.#target(actor, req.target?.type, req.target?.id, null);
    if (found.owner?.kind !== 'org' || found.owner.id !== orgId) throw notFound();
    const level = req.level;
    if (!level || !(ACCESS_LEVELS as readonly string[]).includes(level)) throw new AppError('VALIDATION_FAILED', 'Choose view, operate or manage.', { details: { level: 'Unknown level.' } });
    const note = this.#sharing.note(req.note);
    const ref = found.ref;
    if (levelAtLeast(levelOf(actor, ref), level)) throw new AppError('CONFLICT', 'You already have that.', { details: { reason: ORGS_ERROR_CODES.ACCESS_ALREADY_HELD } });
    const db = this.#write();
    if (db.prepare("SELECT 1 FROM access_requests WHERE object_type = ? AND object_id = ? AND requester = ? AND state = 'open'").get(ref.type, ref.id, userId))
      throw new AppError('CONFLICT', 'You already asked. Cancel that request to ask again.', { details: { reason: ORGS_ERROR_CODES.ACCESS_REQUEST_OPEN } });
    const id = `arq_${randomBytes(9).toString('base64url')}`;
    db.prepare('INSERT INTO access_requests (id, org_id, object_type, object_id, requester, level, note, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      id,
      orgId,
      ref.type,
      ref.id,
      userId,
      level,
      note,
      'open',
      this.#now().toISOString(),
    );
    this.#record('org.access_requested', actor, orgId, `${ref.type}:${ref.id}`, { requestId: id, level, ...(note ? { note } : {}) });
    const name = this.nameOf(ref);
    this.#notify(this.#deciders(orgId, ref, userId), { what: 'requested', orgId, orgName: this.#orgName(orgId), requestId: id, objectName: name });
    return this.#requestView(this.#row(orgId, id), actor, role);
  }

  #row(orgId: OrgId, id: string): RequestRow {
    const r = this.#read().prepare(`${REQUEST_SELECT} WHERE r.id = ? AND r.org_id = ?`).get(id, orgId) as RequestRow | undefined;
    if (!r) throw notFound('No such request.');
    return r;
  }

  /** An open request the caller may decide; anyone else gets the same 404 as a missing one (a request names a person and an object). */
  #decidable(actor: Actor, orgId: OrgId, id: string): { r: RequestRow; role: OrgRole } {
    this.#person(actor);
    const { userId, role } = this.#role(actor, orgId);
    const r = this.#row(orgId, id);
    const may = this.#mayDecide(actor, role, r);
    if (!may && r.requester !== userId && !isManager(role)) throw notFound('No such request.');
    if (r.state !== 'open') throw new AppError('CONFLICT', 'This request was already decided.');
    if (!may) throw new AppError('FORBIDDEN', r.requester === userId ? 'Someone else decides your request.' : 'You can’t give this access.');
    return { r, role };
  }

  approve(actor: Actor, orgId: OrgId, id: string, body: Partial<DecideAccessRequest>): AccessRequest {
    const { r, role } = this.#decidable(actor, orgId, id);
    const level = body.level ?? r.level;
    const share = this.#sharing.share(
      actor,
      orgId,
      {
        target: { type: r.object_type, id: r.object_id },
        subject: { kind: 'user', userId: r.requester as UserId },
        level,
        expiresAt: body.expiresAt ?? null,
        note: body.note !== undefined ? body.note : r.note,
        acknowledgeExposure: body.acknowledgeExposure === true,
      },
      { audit: { requestId: r.id } },
    );
    const decisionNote = this.#sharing.note(body.note);
    const at = this.#now().toISOString();
    this.#write()
      .prepare("UPDATE access_requests SET state = 'approved', decided_by = ?, decided_at = ?, decision_note = ?, granted_level = ?, expires_at = ?, share_id = ? WHERE id = ? AND state = 'open'")
      .run(actorUserId(actor), at, decisionNote, share.level, share.expiresAt ?? null, share.id, r.id);
    this.#record('org.access_request_approved', actor, orgId, `${r.object_type}:${r.object_id}`, {
      requestId: r.id,
      requester: r.requester,
      asked: r.level,
      level: share.level,
      expiresAt: share.expiresAt ?? null,
      shareId: share.id,
    });
    this.#notify([r.requester as UserId], { what: 'approved', orgId, orgName: this.#orgName(orgId), requestId: r.id, objectName: this.nameOf({ type: r.object_type, id: r.object_id }) });
    return this.#requestView(this.#row(orgId, id), actor, role);
  }

  deny(actor: Actor, orgId: OrgId, id: string, body: Partial<DecideAccessRequest>): AccessRequest {
    const { r, role } = this.#decidable(actor, orgId, id);
    const note = this.#sharing.note(body.note);
    this.#write()
      .prepare("UPDATE access_requests SET state = 'denied', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND state = 'open'")
      .run(actorUserId(actor), this.#now().toISOString(), note, r.id);
    this.#record('org.access_request_denied', actor, orgId, `${r.object_type}:${r.object_id}`, { requestId: r.id, requester: r.requester, asked: r.level, ...(note ? { note } : {}) });
    this.#notify([r.requester as UserId], { what: 'denied', orgId, orgName: this.#orgName(orgId), requestId: r.id, objectName: this.nameOf({ type: r.object_type, id: r.object_id }) });
    return this.#requestView(this.#row(orgId, id), actor, role);
  }

  cancel(actor: Actor, orgId: OrgId, id: string): void {
    this.#person(actor);
    const { userId } = this.#role(actor, orgId);
    const r = this.#row(orgId, id);
    if (r.requester !== userId) throw notFound('No such request.');
    if (r.state !== 'open') throw new AppError('CONFLICT', 'This request was already decided.');
    this.#write().prepare("UPDATE access_requests SET state = 'cancelled', decided_by = ?, decided_at = ? WHERE id = ? AND state = 'open'").run(userId, this.#now().toISOString(), r.id);
    this.#record('org.access_request_cancelled', actor, orgId, `${r.object_type}:${r.object_id}`, { requestId: r.id });
  }
}

const REQUEST_SELECT = 'SELECT r.*, u.display_name AS requester_name FROM access_requests r LEFT JOIN users u ON u.id = r.requester';
