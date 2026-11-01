// What the web shows to whom in organizations (docs/prd/organizations.md §6.2, §7). The server decides every right; these only keep a control
// off the screen when the server would refuse it, so they mirror OrgsService (setRole, removeMember, leave, members) and are tested apart.

import { ORG_ROLES, ORGS_ERROR_CODES, type Ability, type OrgRole } from '@portal/contracts';

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
  return e instanceof Error && e.message ? e.message : fallback;
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
