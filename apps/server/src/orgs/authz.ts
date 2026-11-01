// Organizations: the `org` resolver and the route declarations (docs/prd/organizations.md §6.5, §10; slice 3). The level on an org comes
// from MEMBERSHIP, read on every decision (`levelFor`): owner and admin `manage`, member and guest `view`, anyone else none, which the seam
// answers as a missing org (404). A platform admin holds nothing on an org by being an admin (the Admin console reads `OrgsService.listAll`).
// `org` is in the seam's RESOLVER_REQUIRED: without this resolver every org is not found (fail closed).

import { orgRef, type Level, type OrgRole, type OrgState, type RouteAccess, type RoutePolicies, type UserId, type Verb } from '@portal/contracts';
import { declarePolicies, registerResolver, type ObjectResolver } from '../authz/seam.js';

/** The level a role gives on the org itself, by the org's state (§6.5, §6.9: a suspended org gives nothing, but its owners still see it). */
export function orgLevel(state: unknown, role: OrgRole | null): Level {
  if (!role) return 'none';
  if (state === 'active') return role === 'owner' || role === 'admin' ? 'manage' : 'view';
  if (state === 'suspended') return role === 'owner' ? 'view' : 'none';
  return 'none';
}

export interface OrgLookup {
  stateOf(id: string): OrgState | null;
  roleOf(id: string, userId: UserId): OrgRole | null;
}

export function orgResolver(orgs: OrgLookup): ObjectResolver {
  return {
    type: 'org',
    resolve(id) {
      const state = orgs.stateOf(id);
      return state ? { ref: orgRef(id), owner: { kind: 'platform' }, attrs: { state } } : null;
    },
    levelFor: (found, userId) => orgLevel(found.attrs?.state, orgs.roleOf(found.ref.id, userId)),
  };
}

export const registerOrgResolver = (orgs: OrgLookup): void => registerResolver(orgResolver(orgs));

const org = (verb: Verb): Extract<RouteAccess, { kind: 'objects' }> => ({ kind: 'objects', checks: [{ type: 'org', verb, from: 'path', param: 'id' }] });

/**
 * Every route of the module (ORGS_API; app.ts mounts it at /api/orgs behind `requireSession`). Owner-only rules (changing owners, removing an owner) and
 * "guests do not see the directory" are the service's, on top of the declared level; creating needs the ability `orgs.create` or an
 * instance admin, also the service's. No route takes a bearer token: cookie only.
 */
export const ORG_ROUTE_POLICIES: RoutePolicies = {
  'GET /api/orgs': { kind: 'signed-in', filter: 'org' },
  'POST /api/orgs': { kind: 'signed-in', creates: 'org', audit: 'org.created' },
  'GET /api/orgs/:id': org('view'),
  'PATCH /api/orgs/:id': { ...org('manage'), audit: 'org.updated' },
  'GET /api/orgs/:id/members': org('view'),
  'PATCH /api/orgs/:id/members/:uid': { ...org('manage'), audit: 'org.member_role_changed' },
  'DELETE /api/orgs/:id/members/:uid': { ...org('manage'), audit: 'org.member_removed' },
  'POST /api/orgs/:id/leave': { ...org('view'), audit: 'org.member_left' },
  // Slice 5, break-glass (§6.7): the banner reads the signed-in person's own open entries (none for anyone but an instance admin); the org's
  // entries and access rows, and ending one early, are its OWNERS' (the service checks the role on top of the declared manage).
  'GET /api/orgs/break-glass': { kind: 'self' },
  'GET /api/orgs/:id/break-glass': org('manage'),
  'POST /api/orgs/:id/break-glass/:entryId/end': { ...org('manage'), audit: 'org.break_glass_ended' },
};

/**
 * Slice 5, Move to organization (§6.4): `manage` on the object, declared here and asked again by the service, which also needs an active
 * role of member or up in the org named in the body (not declared: the body's org is a service check, so a missing org and one the person
 * is not in answer the same 404). Each route is mounted on its object's router (workspaces, tickets, knowledge) by app.ts.
 */
export const ORG_TRANSFER_POLICIES: RoutePolicies = {
  'POST /api/workspaces/:ref/move-to-org': { kind: 'objects', checks: [{ type: 'workspace', verb: 'manage', from: 'path', param: 'ref' }], audit: 'object.transferred' },
  'POST /api/tickets/buckets/:key/move-to-org': { kind: 'objects', checks: [{ type: 'ticket_bucket', verb: 'manage', from: 'path', param: 'key' }], audit: 'object.transferred' },
  'POST /api/knowledge/vaults/:id/move-to-org': { kind: 'objects', checks: [{ type: 'vault', verb: 'manage', from: 'path', param: 'id' }], audit: 'object.transferred' },
};

export function declareOrgPolicies(): void {
  declarePolicies('orgs', ORG_ROUTE_POLICIES);
  declarePolicies('orgs', ORG_TRANSFER_POLICIES);
}
