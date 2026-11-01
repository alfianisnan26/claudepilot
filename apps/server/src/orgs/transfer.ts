// Move to organization (docs/prd/organizations.md §6.4 "Share vs transfer", §13.2 row 5): a workspace, a ticket bucket (its tickets follow
// it), a vault or a set (D-111 D2: any multi-pool type) changes owner to an org. Read this before calling it.
//
// - Who: a PERSON (not a token, not an agent) holding `manage` on the object (the route's declared check, asked again here) and an active
//   role of member or up in the target org (a guest, a non-member, a suspended or missing org: the org's 404). Moving an object that is
//   ALREADY another org's needs owner or admin in that org by role (§6.4 "moving back out of an org needs org admin"; a creator grant or a
//   break-glass entry is not enough).
// - Credentials (workspaces): the credential sets (Secrets & env) assigned to it are re-shown on a consent screen (Sharing D19). The first call
//   without `keepCredentials` answers 409 CREDENTIALS_CONSENT_REQUIRED with their names; the second sends the ones to keep (off by default:
//   none), and every set not kept is unassigned through the pools service (its removal records and the reconciler) BEFORE the owner changes. Keeping one needs
//   `manage` on that set: an org workspace never carries a set its mover does not own.
// - Credentials (sets, D-111 D2): a Secrets & env set moved into an org can be read by the org's owners and admins (they manage what the org
//   owns), people who could not read it before. The first call without `acknowledgeExposure: true` answers 409 SHARE_EXPOSES_CREDENTIALS with
//   its name (the acknowledgement an org share of a workspace asks for, orgs/sharing.ts). Its assignments are not touched: the workspaces it
//   is delivered to keep it (delivery follows the assignments, not the owner).
// - The owner columns change in one transaction with the CREATOR grant (`manage`, share 'creator'): the previous personal owner keeps running
//   what they made while they are a member of the org (authz/grants.ts), else the mover holds it. Earlier creator grants on it are replaced.
// - Audit `object.transferred` (medium) with the previous owner, the org and the credentials kept and removed; an access change
//   (`owner_changed`) for the previous owner.

import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import {
  ORGS_ERROR_CODES,
  actorString,
  isOrgId,
  objectRef,
  type Actor,
  type MoveToOrgCredential,
  type MoveToOrgKind,
  type MoveToOrgRequest,
  type MoveToOrgResult,
  type ObjectRef,
  type Owner,
  type OrgId,
  type UserId,
} from '@portal/contracts';
import { CREATOR_SHARE, type Grants } from '../authz/grants.js';
import { can, emitAccessChange, requireCan, resolve } from '../authz/seam.js';
import type { AuditInput } from '../platform/audit.js';
import type { OrgsService } from './service.js';

/** The credential sets of a workspace and how to unassign some (app.ts wires the pools service). */
export interface WorkspaceCredentials {
  list(workspaceKey: string): MoveToOrgCredential[];
  /** Unassigns these sets from the workspace (removal records, the reconciler). */
  remove(workspaceKey: string, poolIds: string[]): void;
}

export interface TransferDeps {
  db: () => DatabaseSync | null;
  writable?: () => DatabaseSync | null;
  orgs: OrgsService;
  grants: Grants;
  audit: (e: AuditInput) => void;
  credentials?: WorkspaceCredentials | null;
  now?: () => Date;
}

const notFound = () => new AppError('NOT_FOUND', 'Not found.');
/** The set types whose content is a credential (values sealed in the portal): moving one asks for the exposure acknowledgement. */
export const CREDENTIAL_POOL_TYPES: readonly string[] = ['secrets'];
const ownerString = (o: Owner | null): string => (!o ? 'none' : o.kind === 'platform' ? 'platform' : `${o.kind}:${o.id}`);

export class OrgTransfers {
  readonly #w: () => DatabaseSync | null;
  readonly #orgs: OrgsService;
  readonly #grants: Grants;
  readonly #audit: (e: AuditInput) => void;
  readonly #credentials: WorkspaceCredentials | null;
  readonly #now: () => Date;

  constructor(deps: TransferDeps) {
    this.#w = deps.writable ?? deps.db;
    this.#orgs = deps.orgs;
    this.#grants = deps.grants;
    this.#audit = deps.audit;
    this.#credentials = deps.credentials ?? null;
    this.#now = deps.now ?? (() => new Date());
  }

  /** `poolType`: for a set, the type its URL names (the set's own type, else it is not found). */
  moveToOrg(actor: Actor, kind: MoveToOrgKind, rawId: string, req: Partial<MoveToOrgRequest>, poolType?: string): MoveToOrgResult {
    if (actor.kind !== 'user') throw new AppError('FORBIDDEN', 'A person moves objects into an organization.');
    const userId = actor.userId;
    if (kind === 'pool' && !poolType) throw notFound();
    const found = typeof rawId === 'string' && rawId ? resolve(objectRef(kind, rawId, poolType as never)) : null;
    if (!found) throw notFound();
    const ref: ObjectRef = found.ref;
    requireCan(actor, 'manage', ref);

    const orgId = req.orgId;
    if (!isOrgId(orgId) || this.#orgs.stateOf(orgId) !== 'active') throw notFound();
    const role = this.#orgs.roleOf(orgId, userId);
    if (!role || role === 'guest') throw notFound();

    const from = found.owner;
    if (from?.kind === 'org') {
      if (from.id === orgId) throw new AppError('CONFLICT', 'The organization already owns it.', { details: { reason: ORGS_ERROR_CODES.ORG_ALREADY_OWNER } });
      const there = this.#orgs.roleOf(from.id, userId);
      if (there !== 'owner' && there !== 'admin') throw new AppError('FORBIDDEN', 'Moving it out of its organization needs an owner or an admin of that organization.');
    }

    // The consent screen (workspaces): which credential sets stay.
    let kept: string[] = [];
    let removed: string[] = [];
    if (kind === 'workspace' && this.#credentials) {
      const assigned = this.#credentials.list(ref.id);
      if (assigned.length) {
        if (!Array.isArray(req.keepCredentials))
          throw new AppError('CONFLICT', 'Choose which credentials stay with the workspace.', {
            details: { reason: ORGS_ERROR_CODES.CREDENTIALS_CONSENT_REQUIRED, credentials: assigned },
          });
        const ids = new Set(assigned.map((c) => c.poolId));
        const want = [...new Set(req.keepCredentials.filter((v): v is string => typeof v === 'string'))];
        const unknown = want.filter((p) => !ids.has(p));
        if (unknown.length) throw new AppError('VALIDATION_FAILED', 'One of the credentials is not assigned to this workspace.', { details: { keepCredentials: 'Unknown set.' } });
        for (const p of want)
          if (!can(actor, 'manage', objectRef('pool', p, 'secrets')).allow)
            throw new AppError('FORBIDDEN', 'You can keep only credentials you manage.', { details: { keepCredentials: p } });
        kept = want;
        removed = [...ids].filter((p) => !want.includes(p));
      }
    }

    // The exposure acknowledgement (sets): the org's owners and admins can read a credential set the org owns.
    if (kind === 'pool' && poolType && CREDENTIAL_POOL_TYPES.includes(poolType) && req.acknowledgeExposure !== true) {
      const name = (this.#w()?.prepare('SELECT name FROM pools WHERE id = ?').get(ref.id) as { name?: string } | undefined)?.name ?? ref.id;
      throw new AppError('CONFLICT', 'The organization’s owners and admins will be able to read these credentials.', {
        details: { reason: ORGS_ERROR_CODES.SHARE_EXPOSES_CREDENTIALS, credentials: [{ poolId: ref.id, name } satisfies MoveToOrgCredential] },
      });
    }

    const grantee: UserId = from?.kind === 'user' ? from.id : userId;
    const db = this.#w();
    if (!db) throw new AppError('SERVICE_UNAVAILABLE', 'The portal’s database is read-only right now.');
    const at = this.#now().toISOString();
    const by = actorString(actor);
    let uid: string | null = null;
    if (kind === 'workspace') {
      uid = (db.prepare('SELECT id FROM workspace_identities WHERE legacy_id = ? AND removed_at IS NULL').get(ref.id) as { id: string } | undefined)?.id ?? null;
      if (!uid) throw notFound();
    }
    // BEFORE the owner changes: the sets the mover did not keep leave the workspace (their removal records and the reconciler). If that
    // fails nothing moves, so an org workspace never carries a set nobody consented to.
    if (removed.length && this.#credentials) this.#credentials.remove(ref.id, removed);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (kind === 'workspace') {
        db.prepare(
          `INSERT INTO workspace_owners (workspace_id, uid, owner_kind, owner_id, created_by, created_at, origin) VALUES (?, ?, 'org', ?, ?, ?, 'claimed')
           ON CONFLICT (workspace_id) DO UPDATE SET uid = excluded.uid, owner_kind = 'org', owner_id = excluded.owner_id,
             origin = CASE WHEN workspace_owners.uid = excluded.uid THEN workspace_owners.origin ELSE 'claimed' END`,
        ).run(ref.id, uid, orgId, grantee, at);
      } else if (kind === 'pool') {
        if (!Number(db.prepare("UPDATE pools SET owner_kind = 'org', owner_id = ?, updated_at = ? WHERE id = ? AND type != 'account'").run(orgId, at, ref.id).changes)) throw notFound();
      } else if (kind === 'ticket_bucket') {
        if (!Number(db.prepare("UPDATE ticket_buckets SET owner_kind = 'org', owner_id = ?, updated_at = ? WHERE key = ?").run(orgId, at, ref.id).changes)) throw notFound();
      } else {
        if (!Number(db.prepare("UPDATE kg_vaults SET owner_kind = 'org', owner_id = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(orgId, at, ref.id).changes)) throw notFound();
      }
      this.#grants.removeFor(db, ref, CREATOR_SHARE);
      this.#grants.add(db, { ref, uid, subject: { kind: 'user', id: grantee }, level: 'manage', shareId: CREATOR_SHARE, by });
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    this.#audit({
      kind: 'object.transferred',
      severity: 'medium',
      actor: by,
      userId,
      subject: `${kind}:${ref.id}`,
      // The org's row too (its Audit section reads rows by org_id; the subject is the object).
      orgId,
      detail: {
        orgId,
        type: kind,
        id: ref.id,
        ...(kind === 'pool' ? { poolType, exposureAcknowledged: req.acknowledgeExposure === true } : {}),
        from: ownerString(from),
        creatorGrant: grantee,
        credentialsKept: kept,
        credentialsRemoved: removed,
      },
    });
    if (from?.kind === 'user') emitAccessChange({ userId: from.id, ref, why: 'owner_changed' });
    return { kind, id: ref.id, owner: { kind: 'org', id: orgId as OrgId }, creatorGrant: grantee, credentialsKept: kept, credentialsRemoved: removed };
  }
}
