// Pure helpers of the Admin console (tested in model.test.ts).
import {
  ADMIN_MEMBER_ROLES,
  ADMIN_TOKEN_DAYS,
  PORTAL_TOKEN_LABEL_MAX,
  type AdminAddMemberRequest,
  type AdminMemberRole,
  type AdminMintTokenRequest,
  type AdminUserRow,
  type OrgMember,
} from '@portal/contracts';

export const TABS = ['users', 'orgs', 'workspaces', 'signin', 'settings', 'audit'] as const;
export type Tab = (typeof TABS)[number];

/** The section a URL hash names (`#orgs`), or Users. `#sso` (the section before Sign-in held it) opens Sign-in. */
export function tabFromHash(hash: string): Tab {
  const t = hash.replace(/^#/, '');
  if (t === 'sso') return 'signin';
  return (TABS as readonly string[]).includes(t) ? (t as Tab) : 'users';
}

/** A slug from an org name: lower case letters, digits and single hyphens, 2 to 40 characters (what ORG_SLUG_PATTERN accepts), or ''. */
export function slugOf(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s.length >= 2 ? s : '';
}

/** What a setting's text field holds, as the value to send: a number for a number setting (or null when it is not one), else the text. */
export function settingInput(type: 'boolean' | 'string' | 'number', raw: string): string | number | null {
  if (type !== 'number') return raw;
  const n = Number(raw.trim());
  return raw.trim() !== '' && Number.isFinite(n) ? n : null;
}

/** The audit's date filters from the page's date fields (`YYYY-MM-DD`): passed as they are, an empty one dropped. */
export function auditDates(from: string, to: string): { from?: string; to?: string } {
  const ok = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
  return { ...(ok(from) ? { from } : {}), ...(ok(to) ? { to } : {}) };
}

/** A short "how long ago" for a timestamp; an unreadable one is shown as unknown, never guessed. */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** What the page was opened with after an OIDC sign-in or step-up came back without success (`?oidc=refused`), or null. */
export function oidcOutcome(search: string): 'refused' | 'unavailable' | null {
  const v = new URLSearchParams(search).get('oidc');
  return v === 'refused' || v === 'unavailable' ? v : null;
}

/** The link that starts OIDC sign-in (or, with `stepUp`, re-authentication), coming back to `next`. A full navigation, not a fetch. */
export function oidcStartHref(start: string, o: { stepUp?: boolean; next?: Tab } = {}): string {
  const p = new URLSearchParams();
  if (o.stepUp) p.set('for', 'step-up');
  if (o.next) p.set('next', o.next);
  const s = p.toString();
  return s ? `${start}?${s}` : start;
}

/** Audit kinds offered as filters (the field still takes any kind or prefix). */
export const AUDIT_KINDS = ['admin.signin_refused', 'admin.signin', 'admin.step_up', 'admin', 'account', 'ability', 'org', 'workspace', 'sso', 'portal', 'setting'] as const;

/** The second line of a refused sign-in's audit row: who tried, how and why (the email, else the provider's subject). */
export function auditWho(kind: string, detail: Record<string, unknown> | undefined): string | null {
  if (kind !== 'admin.signin_refused' || !detail) return null;
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const subject = s(detail.subject);
  const who = s(detail.email) ?? (subject ? `subject ${subject}` : null);
  const parts = [who, s(detail.method), s(detail.reason)?.replace(/_/g, ' ')].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

/** Users' tabs (owner, 2026-11-01: pill tabs inside each section): All, Admins, Members, Disabled. */
export const USER_FILTERS = ['all', 'admins', 'members', 'disabled'] as const;
export type UserFilter = (typeof USER_FILTERS)[number];
export const USER_FILTER_LABEL: Record<UserFilter, string> = { all: 'All', admins: 'Admins', members: 'Members', disabled: 'Disabled' };

/** Whether a user row shows under a tab: Admins and Members list the active ones of that role; Disabled lists every disabled account. */
export function userShows(u: { role: 'admin' | 'member'; state: 'active' | 'disabled' }, f: UserFilter): boolean {
  if (f === 'all') return true;
  if (f === 'disabled') return u.state === 'disabled';
  return u.state === 'active' && u.role === (f === 'admins' ? 'admin' : 'member');
}

/* ---------- Owner need 2026-11-01: an account's Portal MCP token, and an org's members, from the console ---------- */

export type TokenScope = AdminMintTokenRequest['scope'];
/** The scopes offered for an account's token: admin only for an admin account (the server refuses it for anyone else too). */
export function tokenScopes(role: 'admin' | 'member'): TokenScope[] {
  return role === 'admin' ? ['read', 'operate', 'admin'] : ['read', 'operate'];
}

export interface TokenForm {
  label: string;
  scope: TokenScope;
  days: number;
  /** '' for none. */
  workspace: string;
}

/** The request the New token sheet sends, or what is wrong with the form (the server checks every one of these again). */
export function mintRequest(f: TokenForm, role: 'admin' | 'member'): { req: AdminMintTokenRequest } | { error: string } {
  const label = f.label.trim();
  if (!label) return { error: 'Give it a label.' };
  if (label.length > PORTAL_TOKEN_LABEL_MAX) return { error: `At most ${PORTAL_TOKEN_LABEL_MAX} characters.` };
  if (!tokenScopes(role).includes(f.scope)) return { error: 'Admin scope is for admin accounts only.' };
  if (!(ADMIN_TOKEN_DAYS as readonly number[]).includes(f.days)) return { error: 'Pick a lifetime.' };
  if (f.workspace && f.scope === 'read') return { error: 'A read token makes no tickets.' };
  return { req: { label, scope: f.scope, expiresInDays: f.days, ...(f.workspace ? { defaultWorkspaceId: f.workspace } : {}) } };
}

export const MEMBER_ROLES: readonly AdminMemberRole[] = ADMIN_MEMBER_ROLES;

export interface MemberForm {
  /** An existing account, or a new one (no password: SSO or a token only). */
  mode: 'existing' | 'new';
  userId: string;
  email: string;
  name: string;
  role: AdminMemberRole;
}

/** The request the Add member sheet sends, or what is missing. Never an owner (the role list has none; the server refuses it too). */
export function memberRequest(f: MemberForm): { req: AdminAddMemberRequest } | { error: string } {
  if (!MEMBER_ROLES.includes(f.role)) return { error: 'Pick admin, member or guest.' };
  if (f.mode === 'existing') return f.userId ? { req: { userId: f.userId, role: f.role } } : { error: 'Pick an account.' };
  const email = f.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Give an email address.' };
  return { req: { email, ...(f.name.trim() ? { displayName: f.name.trim() } : {}), role: f.role } };
}

/** The accounts the Add member sheet offers: active ones that are not in the org yet. */
export function addableAccounts(users: readonly AdminUserRow[], members: readonly OrgMember[]): AdminUserRow[] {
  const inOrg = new Set(members.map((m) => m.userId as string));
  return users.filter((u) => u.state === 'active' && !inOrg.has(u.id));
}
