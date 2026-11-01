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
  // The signed-in person's own abilities (slice 9: the switcher's "New organization"); it names nothing about anyone else.
  'GET /api/orgs/abilities': { kind: 'signed-in' },
  'GET /api/orgs/:id': org('view'),
  'PATCH /api/orgs/:id': { ...org('manage'), audit: 'org.updated' },
  'GET /api/orgs/:id/members': org('view'),
  'PATCH /api/orgs/:id/members/:uid': { ...org('manage'), audit: 'org.member_role_changed' },
  'DELETE /api/orgs/:id/members/:uid': { ...org('manage'), audit: 'org.member_removed' },
  'POST /api/orgs/:id/leave': { ...org('view'), audit: 'org.member_left' },
};

export function declareOrgPolicies(): void {
  declarePolicies('orgs', ORG_ROUTE_POLICIES);
}
