// Who owns a new workspace (D-111 D1, owner 2026-11-01; docs/prd/organizations.md §16.4). Read this before creating one for a person.
//
// - The request names the context it was made in (`CreateWorkspaceRequest.owner`): `personal` (or nothing) is the creator personally; an org
//   id is that org, when the creator may create there: the org's owners and admins, a member while the org's policy
//   `membersCreateWorkspaces` is on (off by default). A member without it, or a guest, is refused with a clear 403
//   (ORG_CREATE_WORKSPACE_NOT_ALLOWED): never silently made personal, so nobody finds their work in the wrong place. An org the creator is not
//   in (or a suspended or missing one, or a value that is not an org id) is the 404 of a missing org. An org's slug is taken for its id.
// - Decided BEFORE anything is created (the route asks `ownerFor` first), then written with the workspace's identity (workspaces/identity.ts
//   `allocate`). An org-owned one gets the creator grant (`manage`, share 'creator', like Move to organization): its creator keeps running
//   what they made while they are a member of the org (a member holds nothing on an org object by role). Audit `workspace.created_in_org`
//   with the org's id, so the org's Audit section shows it.
// - The requireSso gate of an org (slice 10) is the seam's, on every later use; creating does not bypass it (an org object answers through
//   the seam like any other).

import type { DatabaseSync } from 'node:sqlite';
import { AppError } from '@isnanme/core';
import { FOUNDING_USER_ID, ORGS_ERROR_CODES, actorString, actorUserId, isOrgId, workspaceRef, type Actor, type OrgId, type UserId } from '@portal/contracts';
import { CREATOR_SHARE, type Grants } from '../authz/grants.js';
import { orgIdBySlug } from '../authz/seam.js';
import type { AuditInput } from '../platform/audit.js';
import type { OrgsService } from './service.js';

export type NewOwner = { kind: 'user'; id: string } | { kind: 'org'; id: string };

export interface CreationDeps {
  writable: () => DatabaseSync | null;
  orgs: OrgsService;
  grants: Grants;
  audit: (e: AuditInput) => void;
}

const missingOrg = () => new AppError('NOT_FOUND', 'Not found.');

export class OrgCreation {
  readonly #d: CreationDeps;
  constructor(deps: CreationDeps) {
    this.#d = deps;
  }

  /** The owner of a workspace `actor` creates in context `requested` (`personal`, absent, or an org's id or slug); throws when they may not. */
  ownerFor(actor: Actor, requested: unknown): NewOwner {
    const userId = actorUserId(actor);
    if (requested === undefined || requested === null || requested === '' || requested === 'personal') return { kind: 'user', id: userId ?? FOUNDING_USER_ID };
    if (typeof requested !== 'string' || !userId) throw missingOrg();
    const orgId = isOrgId(requested) ? requested : orgIdBySlug(requested.toLowerCase());
    if (!orgId || this.#d.orgs.stateOf(orgId) !== 'active') throw missingOrg();
    const role = this.#d.orgs.effectiveRoleOf(orgId, userId as UserId);
    if (!role) throw missingOrg();
    if (role === 'owner' || role === 'admin') return { kind: 'org', id: orgId };
    if (role === 'member' && this.#d.orgs.policiesOf(orgId).membersCreateWorkspaces) return { kind: 'org', id: orgId };
    throw new AppError('FORBIDDEN', 'Only this organization’s owners and admins can create workspaces here. Pick Personal, or ask them.', {
      details: { reason: ORGS_ERROR_CODES.ORG_CREATE_WORKSPACE_NOT_ALLOWED, owner: 'Not allowed in this organization.' },
    });
  }

  /** After the workspace's identity was written with an org owner: the creator grant and the audit row. Nothing for a personal one. */
  created(actor: Actor, owner: NewOwner, workspace: { id: string; stableId?: string }): void {
    if (owner.kind !== 'org') return;
    const userId = actorUserId(actor);
    const db = this.#d.writable();
    if (db && userId) {
      this.#d.grants.removeFor(db, workspaceRef(workspace.id), CREATOR_SHARE);
      this.#d.grants.add(db, { ref: workspaceRef(workspace.id), uid: workspace.stableId ?? null, subject: { kind: 'user', id: userId }, level: 'manage', shareId: CREATOR_SHARE, by: actorString(actor) });
    }
    this.#d.audit({
      kind: 'workspace.created_in_org',
      severity: 'info',
      actor: actorString(actor),
      userId,
      subject: `workspace:${workspace.id}`,
      orgId: owner.id as OrgId,
      detail: { orgId: owner.id, workspace: workspace.id, creatorGrant: userId },
    });
  }
}
