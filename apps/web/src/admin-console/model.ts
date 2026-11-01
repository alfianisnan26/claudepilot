// Pure helpers of the Admin console (tested in model.test.ts).

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
