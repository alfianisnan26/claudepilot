// What the web shows to whom in organizations (docs/prd/organizations.md §6.2, §7). The server decides every right; these only keep a control
// off the screen when the server would refuse it, so they mirror OrgsService (setRole, removeMember, leave, members) and are tested apart.

import {
  ORG_INVITE_PATH,
  ORG_ROLE_RANK,
  ORG_ROLES,
  ORGS_ERROR_CODES,
  type Ability,
  type MoveToOrgCredential,
  type Org,
  type OrgDomain,
  type OrgDomainState,
  type OrgGroupRule,
  type OrgInvitationRole,
  type OrgMember,
  type OrgRole,
  type OrgTeamRole,
  type OrgTransferKind,
  type PlatformAuditEntry,
} from '@portal/contracts';

/** "New organization": an instance admin or someone holding `orgs.create` (GET /api/orgs/abilities says which). */
export const canCreateOrg = (abilities: readonly Ability[] | null) => !!abilities?.includes('orgs.create');

/** Owners and admins manage the org: rename, roles, removing people. */
export const canManageOrg = (role: OrgRole) => role === 'owner' || role === 'admin';

/** The member directory: members and up; a guest sees the name only. */
export const canSeeMembers = (role: OrgRole) => role !== 'guest';

/** The roles `mine` may give someone who is `theirs` now (the current one included, for the picker). Empty: no picker. */
export function roleChoices(mine: OrgRole, theirs: OrgRole): OrgRole[] {
  if (mine === 'owner') return [...ORG_ROLES];
  if (mine === 'admin') return theirs === 'owner' ? [] : ORG_ROLES.filter((r) => r !== 'owner');
  return [];
}

/** Whether `mine` may remove a member who is `theirs`. Yourself: leave instead. */
export function canRemoveMember(mine: OrgRole, theirs: OrgRole, self: boolean): boolean {
  if (self) return false;
  if (mine === 'owner') return true;
  return mine === 'admin' && theirs !== 'owner';
}

/**
 * The roles `mine` may invite someone to (slice 8, OrgInvitations.create): never owner, never above your own; a guest invites nobody, and a
 * member only when the org lets members invite (the server decides; the page shows the form to owners and admins).
 */
export function inviteRoleChoices(mine: OrgRole): OrgInvitationRole[] {
  const all: OrgInvitationRole[] = ['admin', 'member', 'guest'];
  if (mine === 'guest') return [];
  return all.filter((r) => ORG_ROLE_RANK[r] <= ORG_ROLE_RANK[mine]);
}

/** The link the inviter copies: the code in the FRAGMENT, so it never reaches a server log or a request line. */
export const inviteLink = (origin: string, code: string) => `${origin.replace(/\/+$/, '')}${ORG_INVITE_PATH}#${encodeURIComponent(code)}`;

/** The code from the accept page's fragment (`#<code>`), or '' when there is none. */
export function inviteCodeFrom(hash: string): string {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return '';
  }
}

export const ROLE_LABEL: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' };

export const ROLE_ABOUT: Record<OrgRole, string> = {
  owner: 'Owner: everything, including who the owners are.',
  admin: 'Admin: manages people (up to admin) and the org’s objects.',
  member: 'Member: sees the org and its people; uses what is shared with them.',
  guest: 'Guest: sees the org’s name and only what is shared with them.',
};

/** The words for a refused change; the last-owner rule in plain terms. */
export function orgErrorText(e: unknown, fallback: string): string {
  const details = (e as { details?: unknown } | null)?.details;
  const reason = details && typeof details === 'object' ? (details as { reason?: unknown }).reason : undefined;
  if (reason === ORGS_ERROR_CODES.ORG_NEEDS_OWNER) return 'An organization needs an owner. Make someone else an owner first.';
  if (reason === ORGS_ERROR_CODES.ORG_SLUG_TAKEN) return 'That slug is taken.';
  if (reason === ORGS_ERROR_CODES.ORG_CREATE_NOT_ALLOWED) return 'Your account can’t create organizations. An admin can allow it.';
  if (reason === ORGS_ERROR_CODES.SSO_LOCKOUT_GUARD) return 'Connect your own sign-in through the provider first (an owner), so nobody is locked out.';
  if (reason === ORGS_ERROR_CODES.DOMAIN_TAKEN) return 'Another organization, or the portal’s own sign-in, already has that domain.';
  if (reason === ORGS_ERROR_CODES.INVITATION_INVALID) return 'This invitation is not valid. Ask for a new one.';
  if (reason === ORGS_ERROR_CODES.INVITATION_EXPIRED) return 'This invitation has expired. Ask for a new one.';
  if (reason === ORGS_ERROR_CODES.INVITATION_EMAIL_MISMATCH) return 'This invitation is for another email address. Sign in with that one.';
  if (reason === ORGS_ERROR_CODES.INVITATION_OTHER_ORG_DOMAIN) return 'Another organization has verified that email’s domain.';
  if (reason === ORGS_ERROR_CODES.ALREADY_MEMBER) return 'They are already a member.';
  if (reason === ORGS_ERROR_CODES.ORG_OWNS_OBJECTS) return 'It still owns things. Move them out first (Objects).';
  if (reason === ORGS_ERROR_CODES.ORG_SUSPENDED_BY_PLATFORM) return 'The portal’s admin suspended it. Ask them to resume it.';
  if (reason === ORGS_ERROR_CODES.ORG_ALREADY_OWNER) return 'The organization already owns it.';
  if (reason === ORGS_ERROR_CODES.TEAM_NOT_ORG_MEMBER) return 'Only members of the organization can be in its teams.';
  if (reason === ORGS_ERROR_CODES.ACCESS_ABOVE_OWN) return 'You can’t give more than you have: a lower level or an earlier end.';
  if (reason === ORGS_ERROR_CODES.ACCESS_SHARING_OWNERS_ONLY) return 'Only the owners share here (a policy).';
  if (reason === ORGS_ERROR_CODES.ACCESS_ALREADY_HELD) return 'You already have that.';
  if (reason === ORGS_ERROR_CODES.ACCESS_REQUEST_OPEN) return 'You already asked. Cancel that request to ask again.';
  if (reason === ORGS_ERROR_CODES.SHARE_EXPOSES_CREDENTIALS) return 'Confirm the credentials warning first.';
  return e instanceof Error && e.message ? e.message : fallback;
}

/* ---------- Sign-in tab (slice 10, §9) ---------- */

/** The Sign-in tab: owners and admins (the server declares `manage`). */
export const canSeeSignIn = (role: OrgRole) => canManageOrg(role);
/** requireSso, freshness and exceptions: owners only (OrgSso.setPolicy). */
export const canSetSsoPolicy = (role: OrgRole) => role === 'owner';

export const DOMAIN_STATE: Record<OrgDomainState, { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  pending: { label: 'Pending', tone: 'warning' },
  verified: { label: 'Verified', tone: 'success' },
  lost: { label: 'Lost', tone: 'danger' },
};

/** The freshness field: empty is off (null), else whole days 1-365; anything else is invalid. */
export function parseFreshness(raw: string): number | null | 'invalid' {
  const v = raw.trim();
  if (!v) return null;
  if (!/^\d{1,3}$/.test(v)) return 'invalid';
  const n = Number(v);
  return n >= 1 && n <= 365 ? n : 'invalid';
}

/** Members whose email is outside the org's VERIFIED domains (they count as guests under requireSso unless excepted); owners never are. */
export function outsideMembers(members: readonly OrgMember[], domains: readonly OrgDomain[]): OrgMember[] {
  const verified = new Set(domains.filter((d) => d.state === 'verified').map((d) => d.domain));
  return members.filter((m) => m.role !== 'owner' && !verified.has(m.email.slice(m.email.lastIndexOf('@') + 1).toLowerCase()));
}

/** Group rules as edited (rows may be blank while typing): blank groups are dropped, a role is required (teams come with org teams). */
export function cleanRules(rows: readonly { group: string; role: Exclude<OrgRole, 'owner'> }[]): OrgGroupRule[] {
  return rows.map((r) => ({ group: r.group.trim(), role: r.role })).filter((r) => r.group);
}

/** A slug from a name: lower case, letters and digits, single hyphens (the server's ORG_SLUG_PATTERN). */
export function slugFrom(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/* ---------- Org settings sections (owner request 2026-11-01) ---------- */

export type OrgSection = 'general' | 'members' | 'teams' | 'invitations' | 'objects' | 'access' | 'sign-in' | 'policies' | 'audit' | 'danger';

export const SECTION_LABEL: Record<OrgSection, string> = {
  general: 'General',
  members: 'Members',
  teams: 'Teams',
  invitations: 'Invitations',
  objects: 'Objects',
  access: 'Access',
  'sign-in': 'Sign-in',
  policies: 'Policies',
  audit: 'Audit',
  danger: 'Danger zone',
};

/**
 * The sections a role sees, in order; a section whose every action the server would refuse is not shown. A suspended org is seen by its
 * owners only (to resume or delete): General and Danger zone. `may` (Org.may) says whether a member may invite (membersMayInvite).
 */
export function orgSections(org: Pick<Org, 'myRole' | 'state' | 'may'>): OrgSection[] {
  const role = org.myRole;
  if (org.state !== 'active') return role === 'owner' ? ['general', 'danger'] : ['general'];
  const out: OrgSection[] = ['general'];
  if (canSeeMembers(role)) out.push('members');
  out.push('teams');
  if (canManageOrg(role) || org.may?.invite) out.push('invitations');
  out.push('objects');
  // Fine-grained access (docs/prd/access.md): replaces Sharing. Members and up (a guest has no catalog and no directory).
  if (role !== 'guest') out.push('access');
  if (canSeeSignIn(role)) out.push('sign-in');
  if (role === 'owner') out.push('policies');
  if (canManageOrg(role)) out.push('audit');
  if (role === 'owner') out.push('danger');
  return out;
}

/** The invitations list (and revoke) is the managers'; a member allowed to invite gets the form only. */
export const canListInvitations = (role: OrgRole) => canManageOrg(role);

/** Create a team: what the server says (Org.may.createTeam), falling back to managers for an older server. */
export const canCreateTeam = (org: Pick<Org, 'myRole' | 'may'>) => (org.may ? org.may.createTeam : canManageOrg(org.myRole));

/** Add or remove people, or delete the team: an org owner or admin, or an owner of the team (OrgSharing.#requireTeamManager). */
export const canManageTeam = (role: OrgRole, teamRole: OrgTeamRole | undefined) => canManageOrg(role) || teamRole === 'owner';

/** Move to organization: a member or up (and manage on the object, which the server checks). */
export const canMoveHere = (role: OrgRole) => role !== 'guest';

/** Transcript views and break-glass entries: the org's owners. */
export const canSeeOwnerAudit = (role: OrgRole) => role === 'owner';

/** Delete asks for the slug, typed exactly. */
export const confirmsDelete = (typed: string, slug: string) => typed.trim() === slug;

/** The credential sets a refused workspace move lists (409 CREDENTIALS_CONSENT_REQUIRED), or null for any other error. */
export function consentCredentials(e: unknown): MoveToOrgCredential[] | null {
  const details = (e as { details?: unknown } | null)?.details;
  if (!details || typeof details !== 'object') return null;
  const d = details as { reason?: unknown; credentials?: unknown };
  if (d.reason !== ORGS_ERROR_CODES.CREDENTIALS_CONSENT_REQUIRED || !Array.isArray(d.credentials)) return null;
  return d.credentials.filter((c): c is MoveToOrgCredential => !!c && typeof c === 'object' && typeof c.poolId === 'string' && typeof c.name === 'string');
}

/** The audit filter: a kind prefix the server matches (`GET /api/orgs/:id/audit?kind=`). */
export const AUDIT_FILTERS: readonly { kind: string; label: string }[] = [
  { kind: '', label: 'All' },
  { kind: 'org.member', label: 'Members' },
  { kind: 'org.team', label: 'Teams' },
  { kind: 'org.share', label: 'Sharing' },
  { kind: 'org.access', label: 'Requests' },
  { kind: 'org.invitation', label: 'Invitations' },
  { kind: 'object.transferred', label: 'Moves' },
  { kind: 'org.domain', label: 'Domains' },
  { kind: 'org.sso', label: 'SSO' },
  { kind: 'org.break_glass', label: 'Break-glass' },
  { kind: 'org.updated', label: 'Settings' },
];

/** An audit kind in words: `org.member_role_changed` -> "Member role changed". */
export function auditKindText(kind: string): string {
  const words = kind.replace(/^org\./, '').replace(/[._]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : kind;
}

/** Who did it, in words: `user:<id>` -> their name when known, else the id; `system:x` stays. */
export function auditActorText(entry: Pick<PlatformAuditEntry, 'actor'>, names: ReadonlyMap<string, string>): string {
  const m = /^user:(.+)$/.exec(entry.actor);
  return m ? (names.get(m[1]!) ?? m[1]!) : entry.actor;
}

/** One object in Objects (and the names Sharing shows): a workspace, a ticket bucket or a vault, with where it opens. */
export interface OrgObjectRow {
  kind: OrgTransferKind;
  id: string;
  name: string;
  href: string;
}

export const KIND_LABEL: Record<OrgTransferKind, string> = { workspace: 'Workspace', ticket_bucket: 'Bucket', vault: 'Vault' };

/** The lists (`?org=`) as rows, workspaces first, each by name. */
export function objectRows(o: {
  workspaces: readonly { id: string; name: string; label?: string }[];
  buckets: readonly { key: string; name: string }[];
  vaults: readonly { id: string; name: string }[];
}): OrgObjectRow[] {
  const by = (a: OrgObjectRow, b: OrgObjectRow) => a.name.localeCompare(b.name);
  return [
    ...o.workspaces.map((w) => ({ kind: 'workspace' as const, id: w.id, name: w.label || w.name, href: '/admin/workspaces' })).sort(by),
    ...o.buckets.map((b) => ({ kind: 'ticket_bucket' as const, id: b.key, name: b.name, href: `/admin/tickets?bucket=${encodeURIComponent(b.key)}` })).sort(by),
    ...o.vaults.map((v) => ({ kind: 'vault' as const, id: v.id, name: v.name, href: `/admin/knowledge/${encodeURIComponent(v.id)}` })).sort(by),
  ];
}

/** A share's object by name when a list has it, else its id (an object the person cannot list). */
export function targetName(target: { type: OrgTransferKind; id: string }, rows: readonly OrgObjectRow[]): string {
  return rows.find((r) => r.kind === target.type && r.id === target.id)?.name ?? target.id;
}
