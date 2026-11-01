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
  // Slice 5, break-glass (§6.7): the banner reads the signed-in person's own open entries (none for anyone but an instance admin); the org's
  // entries and access rows, and ending one early, are its OWNERS' (the service checks the role on top of the declared manage).
  'GET /api/orgs/break-glass': { kind: 'self' },
  'GET /api/orgs/:id/break-glass': org('manage'),
  'POST /api/orgs/:id/break-glass/:entryId/end': { ...org('manage'), audit: 'org.break_glass_ended' },
  // Slice 7 (./sharing.ts): view on the org (members and guests); the service asks the role on top (who may create or change a team, share,
  // revoke), and a share's object (`manage` on it, asked through can()). Transcript reads are the org OWNERS' (manage declared, owner checked).
  'GET /api/orgs/:id/teams': org('view'),
  'POST /api/orgs/:id/teams': { ...org('view'), audit: 'org.team_created' },
  'DELETE /api/orgs/:id/teams/:teamId': { ...org('view'), audit: 'org.team_removed' },
  'GET /api/orgs/:id/teams/:teamId/members': org('view'),
  'PUT /api/orgs/:id/teams/:teamId/members/:uid': { ...org('view'), audit: 'org.team_member_set' },
  'DELETE /api/orgs/:id/teams/:teamId/members/:uid': { ...org('view'), audit: 'org.team_member_removed' },
  'GET /api/orgs/:id/shares': org('view'),
  'POST /api/orgs/:id/shares': { ...org('view'), audit: 'org.share_created' },
  'DELETE /api/orgs/:id/shares/:shareId': { ...org('view'), audit: 'org.share_ended' },
  'GET /api/orgs/:id/transcript-views': org('manage'),
  // Slice 8 (§6.8-§6.10). Accepting names no org in the path: a signed-in person, the code and an email match, throttled (the service).
  'POST /api/orgs/invitations/accept': { kind: 'signed-in', audit: 'org.member_joined' },
  'GET /api/orgs/:id/invitations': org('manage'),
  // view: a member may invite when the org's `membersMayInvite` is on; the service checks the role, the policy and the role ceiling.
  'POST /api/orgs/:id/invitations': { ...org('view'), audit: 'org.member_invited' },
  'DELETE /api/orgs/:id/invitations/:invitationId': { ...org('manage'), audit: 'org.invitation_revoked' },
  // Owner-only acts, by role in the service on top of the declared level. Resume and delete are `view`: in a SUSPENDED org its owners hold
  // only view (§6.9: they still see it, to resume or delete). Deleting is soft for 30 days (nobody sees the org meanwhile).
  'POST /api/orgs/:id/suspend': { ...org('manage'), audit: 'org.suspended' },
  'POST /api/orgs/:id/resume': { ...org('view'), audit: 'org.resumed' },
  'DELETE /api/orgs/:id': { ...org('view'), audit: 'org.deleted' },
  'GET /api/orgs/:id/audit': org('manage'),
};

/**
 * Slice 5, Move to organization (§6.4): `manage` on the object, declared here and asked again by the service, which also needs an active
 * role of member or up in the org named in the body (not declared: the body's org is a service check, so a missing org and one the person
 * is not in answer the same 404). Each route is mounted on its object's router (workspaces, tickets, knowledge) by app.ts.
 */
export const ORG_TRANSFER_POLICIES: RoutePolicies = {
  'POST /api/workspaces/:target/:name/move-to-org': { kind: 'objects', checks: [{ type: 'workspace', verb: 'manage', from: 'path', param: 'target+name' }], audit: 'object.transferred' },
  'POST /api/tickets/buckets/:key/move-to-org': { kind: 'objects', checks: [{ type: 'ticket_bucket', verb: 'manage', from: 'path', param: 'key' }], audit: 'object.transferred' },
  'POST /api/knowledge/vaults/:id/move-to-org': { kind: 'objects', checks: [{ type: 'vault', verb: 'manage', from: 'path', param: 'id' }], audit: 'object.transferred' },
};

/**
 * Slice 10, org SSO (§9): owners and admins (`manage`); the service adds owner-only for the policy (requireSso, freshness, exceptions).
 * app.ts mounts them (orgs/ssoRoutes.ts) on the /api/orgs router.
 */
export const ORG_SSO_POLICIES: RoutePolicies = {
  'GET /api/orgs/:id/sign-in': org('manage'),
  'POST /api/orgs/:id/domains': { ...org('manage'), audit: 'org.domain_added' },
  'DELETE /api/orgs/:id/domains/:domain': { ...org('manage'), audit: 'org.domain_removed' },
  'POST /api/orgs/:id/domains/:domain/check': { ...org('manage'), audit: 'org.domain_verified' },
  'PUT /api/orgs/:id/sso': { ...org('manage'), audit: 'org.sso_provider_saved' },
  'DELETE /api/orgs/:id/sso': { ...org('manage'), audit: 'org.sso_provider_removed' },
  'POST /api/orgs/:id/sso/test': org('manage'),
  'PUT /api/orgs/:id/sso/policy': { ...org('manage'), audit: 'org.sso_policy_changed' },
};

export function declareOrgPolicies(): void {
  declarePolicies('orgs', ORG_ROUTE_POLICIES);
  declarePolicies('orgs', ORG_TRANSFER_POLICIES);
  declarePolicies('orgs', ORG_SSO_POLICIES);
}
