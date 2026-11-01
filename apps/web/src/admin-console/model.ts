// Pure helpers of the Admin console (tested in model.test.ts).

export const TABS = ['users', 'orgs', 'sso', 'audit'] as const;
export type Tab = (typeof TABS)[number];

/** The section a URL hash names (`#orgs`), or Users. */
export function tabFromHash(hash: string): Tab {
  const t = hash.replace(/^#/, '');
  return (TABS as readonly string[]).includes(t) ? (t as Tab) : 'users';
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
