import type { McpSetContent, PoolSummary } from '@portal/contracts';
import { SECRET_FILE_REF } from '@portal/contracts';

const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

/** A set's content, or an empty one when the summary has none yet. */
export const setContent = (p: PoolSummary): McpSetContent => (p.content as McpSetContent | null) ?? { slug: '', servers: [] };

/** The Secrets & env names a set's servers reference (FR10), sorted. */
export function secretNames(content: McpSetContent): string[] {
  const names = new Set<string>();
  for (const s of content.servers) for (const ref of Object.values(s.secrets)) {
    const name = SECRET_FILE_REF.exec(ref)?.[1];
    if (name) names.add(name);
  }
  return [...names].sort();
}

/** "cpm-team · 3 servers · 1 off" on a set's card (PRD §15). */
export function setSummary(p: PoolSummary): string {
  const c = setContent(p);
  if (c.servers.length === 0) return 'No servers yet';
  const off = c.servers.filter((s) => !s.enabled).length;
  return [c.slug && `cpm-${c.slug}`, n(c.servers.length, 'server'), off && `${off} off`].filter(Boolean).join(' · ');
}
