// Organizations (docs/prd/organizations.md): a tenant above teams. Slice 3 (§13.2 row 3) is the core: the organization, its memberships and
// roles, the "always one active owner" invariant (service and trigger), and the per-user ABILITY `orgs.create` an instance admin grants
// (off by default, OD-2). Slice 5: org-owned objects, Move to organization, break-glass (below). Slice 7: teams in orgs, shares to an org or
// its teams, org owners and admins reading members' sessions in org workspaces (OD-3). Slice 8: invitations, suspension, deletion and the
// org's audit. SSO comes in a later slice.
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

/** §6.6. Stored as JSON on the org; a key that is absent takes its default. Owners set ORG_SETTABLE_POLICIES in Org settings (PATCH the org); requireSso has its own route. */
export interface OrgPolicies {
  membersMayInvite: boolean;
  membersCreateTeams: boolean;
  externalShares: boolean;
  requireSso: boolean;
  /** Days, or null for off. */
  ssoFreshnessDays: number | null;
  defaultJoinRole: Exclude<OrgRole, 'owner'>;
  domainJoin: boolean;
  /**
   * Fine-grained access (owner request 2026-11-01): whether the org's ADMINS may grant access to the org's objects by their role (owners
   * always may; anyone holding `manage` on one object through a grant may grant on that object, up to their own level). Owners set it.
   */
  adminsMayShare: boolean;
}
export const ORG_POLICY_DEFAULTS: OrgPolicies = {
  membersMayInvite: false,
  membersCreateTeams: true,
  externalShares: false,
  requireSso: false,
  ssoFreshnessDays: null,
  defaultJoinRole: 'member',
  domainJoin: false,
  adminsMayShare: true,
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
  /**
   * What the signed-in person may start here that depends on a policy they cannot read (Org settings, owner request 2026-11-01): `invite`
   * (owners and admins; a member while `membersMayInvite`), `createTeam` (owners and admins; a member while `membersCreateTeams`). The server
   * still decides each request.
   */
  may?: { invite: boolean; createTeam: boolean };
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
/** The policies an owner sets in Org settings' Policies (requireSso has its own route, `ssoPolicy`, with the lockout guard). */
export const ORG_SETTABLE_POLICIES = ['membersMayInvite', 'membersCreateTeams', 'externalShares', 'adminsMayShare'] as const;
export type OrgSettablePolicy = (typeof ORG_SETTABLE_POLICIES)[number];

export interface UpdateOrgRequest {
  /** Owners and admins. */
  name?: string;
  /** Owners only; booleans for the keys of ORG_SETTABLE_POLICIES (any other key is refused). Keys left out keep their value. */
  policies?: Partial<Pick<OrgPolicies, OrgSettablePolicy>>;
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

/* ---------- Organization SSO (slice 10, §9) ---------- */

export type OrgDomainState = 'pending' | 'verified' | 'lost';

/** An email domain of the org (§9.2). The challenge is not a secret: it is what the org publishes in DNS. */
export interface OrgDomain {
  domain: string;
  state: OrgDomainState;
  /** The TXT record to publish: `name` (`_claudepilot-challenge.example.com`) and `value` (`cp-verify=<challenge>`). */
  record: { name: string; value: string };
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  /** Failed checks in a row (7 make a verified domain `lost`). */
  failures: number;
}

/** One group rule (§9.6): a value of the ID token's groups claim, the org role it gives and/or a team it joins. Never `owner`. */
export interface OrgGroupRule {
  group: string;
  role?: Exclude<OrgRole, 'owner'>;
  team?: string;
}

/** The org's OIDC provider as its owners and admins see it (§9.1). It serves every verified domain of the org. No secret, ever. */
export interface OrgSsoProvider {
  id: string;
  name: string;
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  scopes: string;
  groupsClaim: string | null;
  groupRules: OrgGroupRule[];
  /** Make an account at the first sign-in (JIT). */
  autoCreate: boolean;
  enabled: boolean;
  /** What to register at the provider as the redirect URL. */
  redirectUri: string;
  updatedAt: string;
}

export interface OrgSsoProviderRequest {
  name?: string;
  issuer?: string;
  clientId?: string;
  /** Write-only: a string sets it, null clears it, absent keeps it. */
  clientSecret?: string | null;
  scopes?: string;
  groupsClaim?: string | null;
  groupRules?: OrgGroupRule[];
  autoCreate?: boolean;
  enabled?: boolean;
}

/** `GET ORGS_API.signIn(id)`: the Sign-in tab (owners and admins). */
export interface OrgSignInSettings {
  domains: OrgDomain[];
  provider: OrgSsoProvider | null;
  requireSso: boolean;
  ssoFreshnessDays: number | null;
  /** Members outside the verified domains an owner keeps above guest while SSO is required. */
  exceptions: UserId[];
  /** At least one owner has signed in through the org's provider (needed before requireSso can be turned on). */
  ownerSignedIn: boolean;
  /** This browser session went through the org's provider (sign-in or step-up). */
  thisSession: boolean;
  /** Where the browser goes for a step-up (adds the org's provider to this session; links the identity to this account when it is free). */
  stepUp: string | null;
}

/** `PUT ORGS_API.ssoPolicy(id)`: owners only (they decide who reaches the org). */
export interface OrgSsoPolicyRequest {
  requireSso?: boolean;
  /** Days (1-365) or null (off: a token then needs at least one sign-in through the provider, ever). */
  ssoFreshnessDays?: number | null;
  exceptions?: UserId[];
}

export const ORG_SSO_LIMITS = {
  domainsPerOrg: 20,
  groupRulesMax: 50,
  /** Groups read from the claim at most; the rest are ignored. */
  groupsRead: 200,
  /** Failed checks in a row that make a verified domain `lost`. */
  lostAfter: 7,
  txtRecords: 20,
  txtBytes: 1024,
} as const;

export const ORG_DOMAIN_CHALLENGE_PREFIX = '_claudepilot-challenge.';
export const ORG_DOMAIN_TXT_PREFIX = 'cp-verify=';
/* ---------- Teams in an org, shares to an org or its teams, transcript reads (slice 7, §6.1, §6.4, §6.5 invariant 2) ---------- */

export type OrgTeamRole = 'owner' | 'member';

/** A team of an org (`teams.org_id`): names unique per org; only active members of the org may be in it. */
export interface OrgTeam {
  id: string;
  orgId: OrgId;
  name: string;
  description: string | null;
  members: number;
  /** The signed-in person's role in the team, when they are in it. */
  myRole?: OrgTeamRole;
  createdAt: string;
}

export interface OrgTeamMember {
  userId: UserId;
  displayName: string;
  role: OrgTeamRole;
  addedAt: string;
}

export interface CreateOrgTeamRequest {
  name: string;
  description?: string | null;
}

export interface SetOrgTeamMemberRequest {
  role: OrgTeamRole;
}

/**
 * Who an org share goes to: the whole org (its active members that are not guests), one of its teams, or one person who is an active member
 * (a guest too). Fine-grained access (owner request 2026-11-01) added the person.
 */
export type OrgShareSubject = { kind: 'org' } | { kind: 'team'; teamId: string } | { kind: 'user'; userId: UserId };

export interface CreateOrgShareRequest {
  target: { type: OrgTransferKind; id: string };
  subject: OrgShareSubject;
  /** view or operate to the org; view, operate or manage to a team or a person; never above the sharer's own level (docs/prd/access.md §4). */
  level: 'view' | 'operate' | 'manage';
  /** When it ends by itself (ISO, at least a minute ahead, at most a year); null or absent: no end. Never past the sharer's own end. */
  expiresAt?: string | null;
  /** Why (shown to managers, kept in the audit). At most ACCESS_LIMITS.noteMax characters. */
  note?: string | null;
  /**
   * The person saw that a workspace shared at operate exposes the credential sets assigned to it (anyone who can operate it can read them).
   * Required when it has any: else 409 SHARE_EXPOSES_CREDENTIALS lists them in `details.credentials`.
   */
  acknowledgeExposure?: boolean;
}

export interface OrgShare {
  id: string;
  orgId: OrgId;
  target: { type: OrgTransferKind; id: string };
  subject: { kind: 'org' } | { kind: 'team'; teamId: string; name: string } | { kind: 'user'; userId: UserId; name: string };
  level: 'view' | 'operate' | 'manage';
  /** A share of the sharer's own object: it ends when the sharer leaves the org. */
  personal: boolean;
  createdBy: UserId;
  createdAt: string;
  /** When it ends by itself; null: no end. */
  expiresAt?: string | null;
  note?: string | null;
}

/** One read of a member's session by an org owner or admin (OD-3): `GET /api/orgs/:id/transcript-views` (org owners); the member reads their own rows at `GET /api/platform/audit?kind=org.transcript_viewed`. */
export interface OrgTranscriptView {
  at: string;
  viewer: UserId;
  member: UserId;
  sessionId: string;
  workspaceId: string | null;
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
  moveWorkspace: (ref: string) => `/api/workspaces/${ref.split('/').map(encodeURIComponent).join('/')}/move-to-org`,
  moveBucket: (key: string) => `/api/tickets/buckets/${encodeURIComponent(key)}/move-to-org`,
  moveVault: (id: string) => `/api/knowledge/vaults/${encodeURIComponent(id)}/move-to-org`,
  /** Slice 10. GET -> OrgSignInSettings (manage). */
  signIn: (id: OrgId) => `/api/orgs/${id}/sign-in`,
  /** Slice 10. POST { domain } -> OrgDomain (manage). */
  domains: (id: OrgId) => `/api/orgs/${id}/domains`,
  /** Slice 10. DELETE (manage). */
  domain: (id: OrgId, domain: string) => `/api/orgs/${id}/domains/${encodeURIComponent(domain)}`,
  /** Slice 10. POST: look the TXT record up now (rate limited per org) -> OrgDomain. */
  checkDomain: (id: OrgId, domain: string) => `/api/orgs/${id}/domains/${encodeURIComponent(domain)}/check`,
  /** Slice 10. PUT OrgSsoProviderRequest -> OrgSsoProvider (creates or changes the org's provider); DELETE removes it. */
  sso: (id: OrgId) => `/api/orgs/${id}/sso`,
  /** Slice 10. POST: read the issuer's discovery document now (rate limited per org). */
  ssoTest: (id: OrgId) => `/api/orgs/${id}/sso/test`,
  /** Slice 10. PUT OrgSsoPolicyRequest -> OrgSignInSettings (owners only). */
  ssoPolicy: (id: OrgId) => `/api/orgs/${id}/sso/policy`,
  /** Slice 7. GET -> OrgTeam[] (members and up: every team; a guest: the teams they are in); POST CreateOrgTeamRequest -> OrgTeam. */
  teams: (id: OrgId) => `/api/orgs/${id}/teams`,
  /** Slice 7. DELETE: an org owner or admin, or a team owner (its shares end). */
  team: (id: OrgId, teamId: string) => `/api/orgs/${id}/teams/${encodeURIComponent(teamId)}`,
  /** Slice 7. GET -> OrgTeamMember[]. */
  teamMembers: (id: OrgId, teamId: string) => `/api/orgs/${id}/teams/${encodeURIComponent(teamId)}/members`,
  /** Slice 7. PUT SetOrgTeamMemberRequest (an active member of the org only); DELETE. */
  teamMember: (id: OrgId, teamId: string, userId: UserId) => `/api/orgs/${id}/teams/${encodeURIComponent(teamId)}/members/${userId}`,
  /** Slice 7. GET -> OrgShare[]; POST CreateOrgShareRequest -> OrgShare. */
  shares: (id: OrgId) => `/api/orgs/${id}/shares`,
  /** Slice 7. DELETE: revoke (the sharer, a manager of the object, or an org owner or admin). */
  share: (id: OrgId, shareId: string) => `/api/orgs/${id}/shares/${encodeURIComponent(shareId)}`,
  /** Slice 7. GET -> OrgTranscriptView[] (org owners). */
  transcriptViews: (id: OrgId) => `/api/orgs/${id}/transcript-views`,
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
  /** Slice 8. GET ?before&limit&kind (manage) -> PlatformAuditEntry[]: the org's audit rows, newest first; `kind` is a prefix (`org.member`). */
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
  /** Slice 10: the domain is verified by another org or served by an instance provider (409). */
  DOMAIN_TAKEN: 'DOMAIN_TAKEN',
  /** Slice 10: a public mail or hosting domain, or a public suffix (422). */
  DOMAIN_REFUSED: 'DOMAIN_REFUSED',
  /** Slice 10: requireSso needs an owner who has signed in through the org's provider first (409). */
  SSO_LOCKOUT_GUARD: 'SSO_LOCKOUT_GUARD',
  /** Org share: an operate share of a workspace with credential sets assigned, without `acknowledgeExposure` (409, details.credentials). */
  SHARE_EXPOSES_CREDENTIALS: 'SHARE_EXPOSES_CREDENTIALS',
  /** Org teams: only an active member of the org may be in its teams (422). */
  TEAM_NOT_ORG_MEMBER: 'TEAM_NOT_ORG_MEMBER',
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
  /** Access: the level or the end asked for is above what the granter holds (403, details.max, details.maxUntil). */
  ACCESS_ABOVE_OWN: 'ACCESS_ABOVE_OWN',
  /** Access: the org's owners have not let admins share by role (policy adminsMayShare off) (403). */
  ACCESS_SHARING_OWNERS_ONLY: 'ACCESS_SHARING_OWNERS_ONLY',
  /** Access request: they already hold that level (409). */
  ACCESS_ALREADY_HELD: 'ACCESS_ALREADY_HELD',
  /** Access request: an open request for the same object exists (409). */
  ACCESS_REQUEST_OPEN: 'ACCESS_REQUEST_OPEN',
} as const;
export type OrgsErrorCode = (typeof ORGS_ERROR_CODES)[keyof typeof ORGS_ERROR_CODES];
