// What the account menu and the Profile say about who is signed in (owner request 2026-11-01: the menu always said "Admin · Signed in with
// server code", even for an account). Pure, so its states are tested without a browser.

import type { CurrentSignIn, MyWebSession, OrgRole, SignedInAs } from '@portal/contracts';

/** One or two letters for an avatar without a picture: the first letters of the first two words, else of the email. */
export function initialsOf(name: string | null | undefined, email?: string | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? [words[0]!, words[1]!].map((w) => [...w][0]) : words.length === 1 ? [[...words[0]!][0]] : [[...(email ?? '').trim()][0]];
  return letters.filter(Boolean).join('').toUpperCase() || '?';
}

export const ORG_ROLE_LABEL: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' };

/** "Signed in with Konfersi Team", "Signed in with a password", "Signed in with the server code"; null when not known. */
export function signInLine(s: CurrentSignIn | undefined): string | null {
  if (!s) return null;
  if (s.method === 'sso') return s.provider ? `Signed in with ${s.provider}` : 'Signed in with SSO';
  if (s.method === 'password') return 'Signed in with a password';
  if (s.method === 'code') return 'Signed in with the server code';
  return null;
}

export interface AccountView {
  /** The line in bold: the person's name, or "Owner (server code)". */
  title: string;
  /** Under it: the email (or @username), or the founder's name for the server code. */
  subtitle: string | null;
  avatar: string | null;
  initials: string;
  /** The platform role chip, or null while unknown. */
  role: 'Admin' | 'Member' | null;
  /** "Konfersi · Owner" in an org context, else null. */
  org: string | null;
  /** A server-code session: the break-glass sign-in (an InfoTip says so). */
  serverCode: boolean;
  signIn: string | null;
}

/** The account area's content for one answer of `GET /api/me` (null: still loading or unreachable) and the current org context. */
export function accountView(me: SignedInAs | null, org: { name: string; myRole: OrgRole } | null): AccountView {
  const orgLine = org ? `${org.name} · ${ORG_ROLE_LABEL[org.myRole]}` : null;
  if (!me) return { title: 'Account', subtitle: null, avatar: null, initials: '?', role: null, org: orgLine, serverCode: false, signIn: null };
  if (me.kind === 'code') {
    const f = me.founder ?? null;
    return {
      title: 'Owner (server code)',
      subtitle: f ? f.displayName : null,
      avatar: f?.avatar ?? null,
      initials: f ? initialsOf(f.displayName, f.email) : 'SC',
      role: 'Admin',
      org: orgLine,
      serverCode: true,
      signIn: signInLine(me.session) ?? 'Signed in with the server code',
    };
  }
  const p = me.profile;
  const name = p?.displayName ?? me.user.displayName;
  const email = p?.email ?? me.user.email;
  return {
    title: name,
    subtitle: email || (p?.username ? `@${p.username}` : null),
    avatar: p?.avatar ?? null,
    initials: initialsOf(name, email),
    role: (p?.role ?? me.user.role) === 'admin' ? 'Admin' : 'Member',
    org: orgLine,
    serverCode: false,
    signIn: signInLine(me.session),
  };
}

/** A device row's words: "Safari on iPhone" (or "Unknown browser") and how it signed in. */
export function deviceLine(s: Pick<MyWebSession, 'device' | 'method' | 'provider'>): { name: string; how: string | null } {
  const how = s.method === 'sso' ? (s.provider ?? 'SSO') : s.method === 'password' ? 'Password' : s.method === 'code' ? 'Server code' : null;
  return { name: s.device ?? 'Unknown browser', how };
}

/** The Profile's sections for this session: a server-code session gets only the pointer to accounts. */
export function profileSections(me: SignedInAs | null): ('identity' | 'password' | 'signIns' | 'devices' | 'orgs' | 'tokens' | 'preferences' | 'serverCode')[] {
  if (!me) return [];
  if (me.kind === 'code') return ['serverCode', 'preferences'];
  const out: ReturnType<typeof profileSections> = ['identity'];
  if (me.profile?.passwordSet !== false) out.push('password');
  if (me.profile?.signIns.length || me.profile?.linkable?.length) out.push('signIns');
  out.push('devices', 'orgs', 'tokens', 'preferences');
  return out;
}

export type ProfileSection = ReturnType<typeof profileSections>[number];
export type ProfileTabId = 'account' | 'sign-in' | 'orgs' | 'tokens' | 'preferences';

export const PROFILE_TAB_LABEL: Record<ProfileTabId, string> = {
  account: 'Account',
  'sign-in': 'Sign-in',
  orgs: 'Orgs',
  tokens: 'Tokens',
  preferences: 'Preferences',
};

/** Which tab holds a section: how you appear first, then how and where you sign in (linked sign-ins go here too), orgs, tokens, preferences. */
const SECTION_TAB: Record<ProfileSection, ProfileTabId> = {
  serverCode: 'account',
  identity: 'account',
  password: 'sign-in',
  signIns: 'sign-in',
  devices: 'sign-in',
  orgs: 'orgs',
  tokens: 'tokens',
  preferences: 'preferences',
};

/**
 * The Profile's tabs for this session (owner request 2026-11-01: tabs, each its own path under /admin/profile), each with its sections in
 * order; a tab with no section for this session is left out (a server-code session: Account and Preferences).
 */
export function profileTabs(me: SignedInAs | null): { id: ProfileTabId; label: string; sections: ProfileSection[] }[] {
  const out: { id: ProfileTabId; label: string; sections: ProfileSection[] }[] = [];
  for (const s of profileSections(me)) {
    const id = SECTION_TAB[s];
    const tab = out.find((t) => t.id === id);
    if (tab) tab.sections.push(s);
    else out.push({ id, label: PROFILE_TAB_LABEL[id], sections: [s] });
  }
  return out;
}

/** Owner request 2026-11-01: what a link from Profile came back with (`?linked=1`, `?link_error=<code>`), or null. */
export function linkResult(search: string): { ok: true } | { ok: false; message: string } | null {
  const q = new URLSearchParams(search);
  if (q.get('linked') === '1') return { ok: true };
  const code = q.get('link_error');
  if (!code) return null;
  const why: Record<string, string> = {
    no_account: 'That sign-in is for another email, or another account holds it.',
    email: 'The provider did not vouch for your email address.',
    domain: 'Your email’s domain does not sign in through that provider.',
    state: 'That link expired or was started in another browser. Try again.',
    disabled: 'This account is disabled.',
  };
  return { ok: false, message: why[code] ?? 'Couldn’t link it. Try again.' };
}

/** Where `/profile?…` (the server's return from a link) opens: the Sign-in tab, which holds Linked sign-ins, for a link's outcome; else Account. */
export function profileReturnPath(search: string): string {
  const q = new URLSearchParams(search);
  return q.has('linked') || q.has('link_error') ? '/admin/profile/sign-in' : '/admin/profile';
}
