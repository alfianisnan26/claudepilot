// What the web shows to whom in organizations (docs/prd/organizations.md §6.2, §7). The server decides every right; these only keep a control
// off the screen when the server would refuse it, so they mirror OrgsService (setRole, removeMember, leave, members) and are tested apart.

import {
  ORG_INVITE_PATH,
  ORG_ROLE_RANK,
  ORG_ROLES,
  ORGS_ERROR_CODES,
  type Ability,
  type OrgDomain,
  type OrgDomainState,
  type OrgGroupRule,
  type OrgInvitationRole,
  type OrgMember,
  type OrgRole,
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
