// Organizations (docs/prd/organizations.md): a tenant above teams. Slice 3 (§13.2 row 3) is the core: the organization, its memberships and
// roles, the "always one active owner" invariant (service and trigger), and the per-user ABILITY `orgs.create` an instance admin grants
// (off by default, OD-2). Slice 5: org-owned objects, Move to organization, break-glass. Slice 8: invitations, suspension, deletion and
// the org's audit (below). Teams in orgs, sharing to an org and SSO come in later slices.
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

/* ---------- Org-owned objects, Move to organization, break-glass (slice 5, §6.3-§6.5, §6.7) ---------- */

/** What can be moved into an org in slice 5 (the rest of §6.3 follows): a workspace, a ticket bucket (its tickets follow it), a vault. */
export type OrgTransferKind = 'workspace' | 'ticket_bucket' | 'vault';

export interface MoveToOrgRequest {
  orgId: OrgId;
  /**
   * The consent screen (Sharing D19), workspaces only: the credential sets (Secrets & env) assigned to the workspace that stay assigned
   * after the move. Required when it has any (else 409 CREDENTIALS_CONSENT_REQUIRED lists them in `details.credentials`); every set not
   * listed is unassigned. Off by default: an empty list keeps none. Keeping one needs `manage` on that set.
   */
  keepCredentials?: string[];
}

/** One credential set assigned to a workspace, as the consent screen lists it (a name, never a value). */
export interface MoveToOrgCredential {
  poolId: string;
  name: string;
}

export interface MoveToOrgResult {
  kind: OrgTransferKind;
  /** The object's id as the seam knows it (a workspace's `<target>/<name>`, a bucket's key, a vault's id). */
  id: string;
  owner: { kind: 'org'; id: OrgId };
  /** Who holds the automatic creator grant (`manage`) while they are a member of the org: the previous personal owner, else the mover. */
  creatorGrant: UserId;
  credentialsKept: string[];
  credentialsRemoved: string[];
}

export const BREAK_GLASS_LIMITS = {
  reasonMin: 10,
  reasonMax: 500,
  /** Time-boxed to one hour; renewable only by a new entry with a new reason. */
  durationMs: 60 * 60_000,
} as const;

/** One break-glass entry (§6.7, OD-4): the instance owner's recorded, time-boxed access to one org's content. */
export interface BreakGlassEntry {
  id: string;
  orgId: OrgId;
  orgName: string;
  adminUserId: UserId;
  reason: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  /** `ended` early (by the admin or an org owner), `expired` at its hour, `replaced` by a new entry of the same admin. */
  endKind: 'ended' | 'expired' | 'replaced' | null;
  endedBy: string | null;
  /** Open now: not ended and not past `expiresAt`. */
  open: boolean;
}

export interface StartBreakGlassRequest {
  /** At least 10 characters. */
  reason: string;
}

/** A mutation (or, later, a transcript view) made under a break-glass entry: one audit row each. */
export interface BreakGlassAccessRow {
  at: string;
  entryId: string;
  actor: string;
  /** `<type>:<id>` */
  object: string;
  verb: string;
}

export interface OrgBreakGlassView {
  entries: BreakGlassEntry[];
  access: BreakGlassAccessRow[];
}

/* ---------- Invitations, suspension, deletion, the org's audit (slice 8, §6.8-§6.10) ---------- */

export const ORG_INVITATION_LIMITS = {
  /** An invitation is good for 7 days, once. */
  ttlMs: 7 * 24 * 60 * 60_000,
  /** Accept attempts per person per window (`auth_throttle` scope `invitation`); a wrong code counts like a right one. */
  acceptPerWindow: 10,
  acceptWindowMs: 15 * 60_000,
  /** Pending invitations one org may hold at once. */
  pendingMax: 200,
  /** The code's length bounds (it is 43 base64url characters; anything else is not a code). */
  codeMin: 20,
  codeMax: 100,
} as const;

/** An org that is deleted stays `deleting` this long (it can be seen by nobody), then it is purged. */
export const ORG_DELETE_GRACE_MS = 30 * 24 * 60 * 60_000;

/** The web page that accepts an invitation; the code is in the link's FRAGMENT (`/admin/org-invite#<code>`), so it is never sent in a request line. */
export const ORG_INVITE_PATH = '/admin/org-invite';

/** Never `owner`: ownership is transferred, not invited (§6.8). */
export type OrgInvitationRole = Exclude<OrgRole, 'owner'>;
export type OrgInvitationState = 'pending' | 'expired';

export interface CreateOrgInvitationRequest {
  email: string;
  role: OrgInvitationRole;
}

/** A pending (or expired, not yet used or revoked) invitation as the org's owners and admins see it. Never the code. */
export interface OrgInvitation {
  id: string;
  /** Normalized (lower case). */
  email: string;
  role: OrgInvitationRole;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  state: OrgInvitationState;
}

/** The answer to creating one: the code, shown ONCE (only its hash is kept). The inviter copies the link `ORG_INVITE_PATH#code`. */
export interface CreatedOrgInvitation extends OrgInvitation {
  code: string;
}

export interface AcceptOrgInvitationRequest {
  code: string;
}

export interface AcceptedOrgInvitation {
  orgId: OrgId;
  orgName: string;
  role: OrgInvitationRole;
}

export interface SuspendOrgRequest {
  reason?: string;
}

/** `GET /api/orgs/abilities`: the abilities the signed-in person may use (an instance admin: every one; a token or an agent: none). */
export interface MyAbilities {
  abilities: Ability[];
}

export const ORGS_API = {
  /** GET: my organizations; POST: CreateOrgRequest -> Org (needs the ability `orgs.create` or an instance admin; the creator is its first owner). */
  orgs: '/api/orgs',
  /** GET: MyAbilities (so the web shows "New organization" only to someone who may create one; the POST still decides). */
  abilities: '/api/orgs/abilities',
  /** GET (view), PATCH (manage): UpdateOrgRequest. */
  org: (id: OrgId) => `/api/orgs/${id}`,
  /** GET: members and up (guests are refused). */
  members: (id: OrgId) => `/api/orgs/${id}/members`,
  /** PATCH: ChangeOrgMemberRoleRequest (admins up to admin, owners anything); DELETE: remove (an owner only by an owner). */
  member: (id: OrgId, userId: UserId) => `/api/orgs/${id}/members/${userId}`,
  /** POST: leave (refused for the last owner). */
  leave: (id: OrgId) => `/api/orgs/${id}/leave`,
  /** Slice 5. GET -> BreakGlassEntry[]: the signed-in instance admin's OPEN break-glass entries (the banner); empty for anyone else. */
  myBreakGlass: '/api/orgs/break-glass',
  /** Slice 5. GET -> OrgBreakGlassView: the org's break-glass entries and the access rows written under them (org owners only). */
  breakGlass: (id: OrgId) => `/api/orgs/${id}/break-glass`,
  /** Slice 5. POST: an org owner ends an open entry early. */
  endBreakGlass: (id: OrgId, entryId: string) => `/api/orgs/${id}/break-glass/${encodeURIComponent(entryId)}/end`,
  /** Slice 5. POST MoveToOrgRequest -> MoveToOrgResult: Move to organization (manage on the object, member or up in the org). */
  moveWorkspace: (ref: string) => `/api/workspaces/${encodeURIComponent(ref)}/move-to-org`,
  moveBucket: (key: string) => `/api/tickets/buckets/${encodeURIComponent(key)}/move-to-org`,
  moveVault: (id: string) => `/api/knowledge/vaults/${encodeURIComponent(id)}/move-to-org`,
  /** Slice 8. GET (manage) -> OrgInvitation[]; POST CreateOrgInvitationRequest -> CreatedOrgInvitation (owners, admins; members when membersMayInvite). */
  invitations: (id: OrgId) => `/api/orgs/${id}/invitations`,
  /** Slice 8. DELETE (manage): revoke a pending invitation at once. */
  invitation: (id: OrgId, invitationId: string) => `/api/orgs/${id}/invitations/${encodeURIComponent(invitationId)}`,
  /** Slice 8. POST AcceptOrgInvitationRequest -> AcceptedOrgInvitation: a signed-in person whose email is the invitation's; throttled. */
  acceptInvitation: '/api/orgs/invitations/accept',
  /** Slice 8. POST SuspendOrgRequest: an owner suspends the org (every right that comes from it is none until resumed). */
  suspend: (id: OrgId) => `/api/orgs/${id}/suspend`,
  /** Slice 8. POST: an owner resumes an org THEY suspended (one the platform admin suspended is resumed in the Admin console). */
  resume: (id: OrgId) => `/api/orgs/${id}/resume`,
  /** Slice 8. GET ?before&limit (manage) -> PlatformAuditEntry[]: the org's audit rows, newest first. */
  audit: (id: OrgId) => `/api/orgs/${id}/audit`,
} as const;

export const ORGS_ERROR_CODES = {
  /** The change would leave the org with no active owner: make someone else an owner first (409). */
  ORG_NEEDS_OWNER: 'ORG_NEEDS_OWNER',
  /** The slug is taken (409). */
  ORG_SLUG_TAKEN: 'ORG_SLUG_TAKEN',
  /** Creating an org needs the ability `orgs.create` (403). */
  ORG_CREATE_NOT_ALLOWED: 'ORG_CREATE_NOT_ALLOWED',
  /** Move to organization: the workspace has credential sets assigned; send keepCredentials (the consent screen) (409, details.credentials). */
  CREDENTIALS_CONSENT_REQUIRED: 'CREDENTIALS_CONSENT_REQUIRED',
  /** Move to organization: the org already owns it (409). */
  ORG_ALREADY_OWNER: 'ORG_ALREADY_OWNER',
  /** Break-glass: a reason of at least 10 characters is required (422). */
  BREAK_GLASS_REASON: 'BREAK_GLASS_REASON',
  /** Slice 8. No such invitation, or it was used or revoked, or its org is gone or suspended (404). */
  INVITATION_INVALID: 'INVITATION_INVALID',
  /** Slice 8. The invitation is past its 7 days (409). */
  INVITATION_EXPIRED: 'INVITATION_EXPIRED',
  /** Slice 8. The signed-in account's email is not the invitation's (403). */
  INVITATION_EMAIL_MISMATCH: 'INVITATION_EMAIL_MISMATCH',
  /** Slice 8. The email is on a domain another org has verified: that org's IdP vouches for it (409). */
  INVITATION_OTHER_ORG_DOMAIN: 'INVITATION_OTHER_ORG_DOMAIN',
  /** Slice 8. The person is already an active member (409). */
  ALREADY_MEMBER: 'ALREADY_MEMBER',
  /** Slice 8. The org still owns objects: move them out first (409, details.owned). */
  ORG_OWNS_OBJECTS: 'ORG_OWNS_OBJECTS',
  /** Slice 8. The platform admin suspended it: only the Admin console resumes it (403). */
  ORG_SUSPENDED_BY_PLATFORM: 'ORG_SUSPENDED_BY_PLATFORM',
} as const;
export type OrgsErrorCode = (typeof ORGS_ERROR_CODES)[keyof typeof ORGS_ERROR_CODES];
