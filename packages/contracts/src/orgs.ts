// Organizations (docs/prd/organizations.md): a tenant above teams. Slice 3 (§13.2 row 3) is the core: the organization, its memberships and
// roles, the "always one active owner" invariant (service and trigger), and the per-user ABILITY `orgs.create` an instance admin grants
// (off by default, OD-2). Invitations, teams in orgs, org-owned objects, sharing to an org, SSO and the Admin console come in later slices.
//
// Rights (authz.ts, object type `org`): owner and admin hold `manage` on the org, member and guest `view`, anyone else nothing, answered as a
// missing org (404). Owner-only acts (changing owners, deleting) are checked by role in the service. Membership is read on every decision.

import type { OrgId, UserId } from './authz.js';

export type OrgRole = 'owner' | 'admin' | 'member' | 'guest';
/** Highest first: `owner` > `admin` > `member` > `guest`. */
export const ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member', 'guest'];
export const ORG_ROLE_RANK: Record<OrgRole, number> = { guest: 1, member: 2, admin: 3, owner: 4 };
export const isOrgRole = (v: unknown): v is OrgRole => typeof v === 'string' && (ORG_ROLES as readonly string[]).includes(v);

export type OrgState = 'active' | 'suspended' | 'deleting';
/** How a person came to be in the org. */
export type OrgMembershipVia = 'created' | 'invite' | 'sso_jit' | 'domain_join' | 'migration' | 'recovered';

/** §6.6. Stored as JSON on the org; a key that is absent takes its default. Changing them comes with Org settings (a later slice). */
export interface OrgPolicies {
  membersMayInvite: boolean;
  membersCreateTeams: boolean;
  externalShares: boolean;
  requireSso: boolean;
  /** Days, or null for off. */
  ssoFreshnessDays: number | null;
  defaultJoinRole: Exclude<OrgRole, 'owner'>;
  domainJoin: boolean;
}
export const ORG_POLICY_DEFAULTS: OrgPolicies = {
  membersMayInvite: false,
  membersCreateTeams: true,
  externalShares: false,
  requireSso: false,
  ssoFreshnessDays: null,
  defaultJoinRole: 'member',
  domainJoin: false,
};

export const ORG_LIMITS = {
  nameMax: 60,
  slugMin: 2,
  slugMax: 40,
  /** Organizations one person may create (a guard against a flood, not a product limit). */
  createdPerUser: 20,
  maxMembers: 1000,
} as const;
/** Lower-case letters, digits and single hyphens; starts with a letter or a digit (used in URLs and the switcher). */
export const ORG_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,39}$/;

/** An organization as a member sees it. */
export interface Org {
  id: OrgId;
  slug: string;
  name: string;
  state: OrgState;
  /** The signed-in person's role in it. */
  myRole: OrgRole;
  /** Active members; shown to members and up, 0 for a guest (no directory). */
  members: number;
  createdAt: string;
  /** Only for owners and admins. */
  policies?: OrgPolicies;
}

export interface OrgMember {
  userId: UserId;
  email: string;
  displayName: string;
  role: OrgRole;
  via: OrgMembershipVia;
  joinedAt: string;
}

export interface CreateOrgRequest {
  name: string;
  slug: string;
}
export interface UpdateOrgRequest {
  name?: string;
}
export interface ChangeOrgMemberRoleRequest {
  role: OrgRole;
}

/** A row of the platform admin's organization list (the Admin console, §6.11, slice 4): names, counts and owners, never content. */
export interface AdminOrgSummary {
  id: OrgId;
  slug: string;
  name: string;
  state: OrgState;
  members: number;
  owners: { userId: UserId; email: string | null; active: boolean }[];
  /** No owner whose account is active: the instance admin may recover it (§6.7). */
  needsOwner: boolean;
  createdBy: string;
  createdAt: string;
}

/* ---------- Abilities (OD-2) ---------- */

/** What an instance admin may grant a user, one by one. Off by default; an instance admin (role = admin) holds every one without a row. */
export const ABILITIES = ['orgs.create'] as const;
export type Ability = (typeof ABILITIES)[number];
export const isAbility = (v: unknown): v is Ability => typeof v === 'string' && (ABILITIES as readonly string[]).includes(v);

export interface UserAbility {
  userId: UserId;
  ability: Ability;
  grantedBy: string;
  grantedAt: string;
}

export const ORGS_API = {
  /** GET: my organizations; POST: CreateOrgRequest -> Org (needs the ability `orgs.create` or an instance admin; the creator is its first owner). */
  orgs: '/api/orgs',
  /** GET (view), PATCH (manage): UpdateOrgRequest. */
  org: (id: OrgId) => `/api/orgs/${id}`,
  /** GET: members and up (guests are refused). */
  members: (id: OrgId) => `/api/orgs/${id}/members`,
  /** PATCH: ChangeOrgMemberRoleRequest (admins up to admin, owners anything); DELETE: remove (an owner only by an owner). */
  member: (id: OrgId, userId: UserId) => `/api/orgs/${id}/members/${userId}`,
  /** POST: leave (refused for the last owner). */
  leave: (id: OrgId) => `/api/orgs/${id}/leave`,
} as const;

export const ORGS_ERROR_CODES = {
  /** The change would leave the org with no active owner: make someone else an owner first (409). */
  ORG_NEEDS_OWNER: 'ORG_NEEDS_OWNER',
  /** The slug is taken (409). */
  ORG_SLUG_TAKEN: 'ORG_SLUG_TAKEN',
  /** Creating an org needs the ability `orgs.create` (403). */
  ORG_CREATE_NOT_ALLOWED: 'ORG_CREATE_NOT_ALLOWED',
} as const;
export type OrgsErrorCode = (typeof ORGS_ERROR_CODES)[keyof typeof ORGS_ERROR_CODES];
