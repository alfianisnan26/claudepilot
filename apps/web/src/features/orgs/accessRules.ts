// What the Access screens show to whom (docs/prd/access.md). The server decides every grant (the ceiling, the policy, who may decide); these
// only keep a choice off the screen when the server would refuse it, and put the answers into words. Tested in accessRules.test.ts.

import {
  ACCESS_LEVELS,
  ACCESS_LIMITS,
  LEVEL_RANK,
  type ObjectAccessEntry,
  type AccessLevel,
  type AccessObjectType,
  type AccessReason,
  type AccessRequest,
  type Level,
  type OrgRole,
} from '@portal/contracts';

export type AccessTab = 'objects' | 'people' | 'mine' | 'requests';

export const ACCESS_TAB_LABEL: Record<AccessTab, string> = { objects: 'Objects', people: 'People', mine: 'Mine', requests: 'Requests' };

/** Owners and admins: every object, every person, the requests inbox. Members: the catalog (ask), their own access, their requests. Guests: none. */
export function accessTabs(role: OrgRole): AccessTab[] {
  if (role === 'owner' || role === 'admin') return ['objects', 'people', 'requests'];
  if (role === 'member') return ['objects', 'mine', 'requests'];
  return [];
}

export type SubjectKind = 'org' | 'team' | 'user';

export const LEVEL_LABEL: Record<Level, string> = { none: 'None', view: 'View', operate: 'Operate', manage: 'Manage' };

/** The level cards: every level, each allowed or not (above the granter's ceiling, or manage to a whole org: never). */
export function levelChoices(mayGrant: readonly AccessLevel[], subject: SubjectKind | null): { level: AccessLevel; allowed: boolean; why: string | null }[] {
  return ACCESS_LEVELS.map((level) => {
    if (!mayGrant.includes(level)) return { level, allowed: false, why: 'Above your own access' };
    if (subject === 'org' && level === 'manage') return { level, allowed: false, why: 'Not to everyone' };
    return { level, allowed: true, why: null };
  });
}

/** Operating (or managing) a workspace reads the credential sets delivered into it: the card warns, the grant needs a tick. */
export const exposesCredentials = (type: AccessObjectType, level: AccessLevel | null, credentials: number) => type === 'workspace' && !!level && level !== 'view' && credentials > 0;

export type UntilKey = 'none' | '7d' | '30d' | 'date';
const DAY = 86_400_000;

/** The "Until" choices; each one past the granter's own end (`maxUntil`) is not allowed, and "No end" is not when there is such an end. */
export function untilChoices(maxUntil: string | null, now: number): { key: UntilKey; label: string; allowed: boolean }[] {
  const max = maxUntil ? Date.parse(maxUntil) : Number.POSITIVE_INFINITY;
  return [
    { key: 'none', label: 'No end', allowed: !maxUntil },
    { key: '7d', label: '7 days', allowed: now + 7 * DAY <= max },
    { key: '30d', label: '30 days', allowed: now + 30 * DAY <= max },
    { key: 'date', label: 'Date', allowed: true },
  ];
}

/** The end to send: null for none; a preset from now; a picked day (YYYY-MM-DD) at the END of that local day, capped at `maxUntil`. */
export function untilValue(key: UntilKey, date: string, now: number, maxUntil: string | null = null): string | null | 'invalid' {
  let t: number;
  if (key === 'none') return maxUntil ? 'invalid' : null;
  if (key === '7d') t = now + 7 * DAY;
  else if (key === '30d') t = now + 30 * DAY;
  else {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!m) return 'invalid';
    t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 0, 0).getTime();
  }
  if (!Number.isFinite(t) || t < now + ACCESS_LIMITS.minAheadMs || t > now + ACCESS_LIMITS.maxDays * DAY) return 'invalid';
  if (maxUntil && t > Date.parse(maxUntil)) return 'invalid';
  return new Date(t).toISOString();
}

/** A local day as YYYY-MM-DD. */
export function dayString(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The latest day a date may be picked (YYYY-MM-DD, local): the granter's end or a year out. */
export function maxDate(maxUntil: string | null, now: number): string {
  return dayString(maxUntil ? Math.min(Date.parse(maxUntil), now + ACCESS_LIMITS.maxDays * DAY) : now + ACCESS_LIMITS.maxDays * DAY);
}

/** `ends in 3 d`, `ends today`, `ended`; null without an end. */
export function endText(expiresAt: string | null | undefined, now: number): string | null {
  if (!expiresAt) return null;
  const left = Date.parse(expiresAt) - now;
  if (!Number.isFinite(left)) return null;
  if (left <= 0) return 'ended';
  if (left < DAY) return 'ends today';
  return `ends in ${Math.ceil(left / DAY)} d`;
}

const ROLE_WORD: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' };

/** One reason in a few words: "Owner", "Admin role", "Creator", "Everyone", "Team Ops", "Shared to them". */
export function reasonText(r: AccessReason): string {
  switch (r.kind) {
    case 'owner':
      return 'Owner';
    case 'org_role':
      return `${ROLE_WORD[r.role]} role`;
    case 'creator':
      return 'Creator';
    case 'share':
      return r.share.subject.kind === 'org' ? 'Everyone' : r.share.subject.kind === 'team' ? `Team ${r.share.subject.name}` : 'Shared to them';
  }
}

/** Who an entry is, in words: the org's managers, everyone, a team, a person. */
export function subjectText(s: ObjectAccessEntry['subject']): string {
  if (s.kind === 'org_managers') return 'Owners and admins';
  if (s.kind === 'org') return 'Everyone';
  if (s.kind === 'team') return `Team ${s.name}`;
  return s.name;
}

/** The highest of the reasons' levels (what the screen expects the server's level to be). */
export const topLevel = (reasons: readonly { level: AccessLevel }[]): Level =>
  reasons.reduce<Level>((a, r) => (LEVEL_RANK[r.level] > LEVEL_RANK[a] ? r.level : a), 'none');

/** The levels a member may still ask for on an object (above what they hold). */
export const askableLevels = (have: Level): AccessLevel[] => ACCESS_LEVELS.filter((l) => LEVEL_RANK[l] > LEVEL_RANK[have]);

/** The requests the inbox shows first: the open ones the caller may decide, then their own open ones, then the decided. */
export function sortRequests(rows: readonly AccessRequest[]): AccessRequest[] {
  const rank = (r: AccessRequest) => (r.state === 'open' ? (r.mayDecide ? 0 : 1) : 2);
  return [...rows].sort((a, b) => rank(a) - rank(b) || (a.state === 'open' ? a.createdAt.localeCompare(b.createdAt) : (b.decidedAt ?? '').localeCompare(a.decidedAt ?? '')));
}

/** How many open requests wait for the caller (the tab's count). */
export const waitingCount = (rows: readonly AccessRequest[]) => rows.filter((r) => r.state === 'open' && r.mayDecide).length;

export const REQUEST_STATE_LABEL: Record<AccessRequest['state'], string> = { open: 'Open', approved: 'Approved', denied: 'Denied', cancelled: 'Cancelled' };
