import type { GlanceSession, GlanceSnapshot } from '@portal/contracts';
import { workspaceLabel } from '@portal/contracts';
import type { GlanceLevel } from '../../types';
import { ciMeta, ciRunHref, ciTitle, deployMeta, deployTitle, sessionHref, ticketHref, ticketMeta } from './model';

// The Home page's "Needs you" card (docs/prd/glance-widgets.md §18): everything that waits on a person, in one list, the most
// blocking first, one tap to each. Pure over the glance snapshot, so the order is tested.

export type NeedKind = 'approval' | 'deploy' | 'interrupted' | 'ci' | 'ticket';

export interface NeedItem {
  /** Unique in the list. */
  key: string;
  kind: NeedKind;
  title: string;
  meta: string;
  href: string;
  /** When it started waiting (for "5m"); null when not known. */
  at: string | null;
  level: GlanceLevel;
}

/**
 * The order, most blocking first:
 * 1. approvals: a session is stopped on each (the one waiting longest first);
 * 2. deploys held for approval: a pipeline is stopped on each (the oldest run first);
 * 3. interrupted sessions: their process was lost, a person resumes or ends them (the latest activity first);
 * 4. failed CI runs that still stand (newest first, as the portal lists them);
 * 5. tickets assigned to a person (as the portal lists them).
 */
export const NEED_ORDER: readonly NeedKind[] = ['approval', 'deploy', 'interrupted', 'ci', 'ticket'];

const time = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** The interrupted sessions the snapshot carries (in its by-need list and in Home's recent list), each once, the latest first. */
export function interruptedSessions(s: GlanceSnapshot['sessions']): GlanceSession[] {
  const seen = new Map<string, GlanceSession>();
  for (const x of [...s.items, ...s.recent]) if (x.state === 'interrupted' && !seen.has(x.id)) seen.set(x.id, x);
  return [...seen.values()].sort((a, b) => time(b.lastActivityAt) - time(a.lastActivityAt));
}

export interface Needs {
  items: NeedItem[];
  /** Everything that waits, counted whole (the lists carry only the top few of each kind). */
  total: number;
  /** Listed here, out of `total`. */
  listed: number;
  /** Sources the portal could not read: said, never counted as zero. */
  unread: string[];
}

/** Everything that waits on a person, in `NEED_ORDER`, at most `max` listed. */
export function needsYou(data: GlanceSnapshot, max = 6): Needs {
  const a = data.attention;
  const out: NeedItem[] = [];
  for (const r of [...a.approvals.items].sort((x, y) => time(x.createdAt) - time(y.createdAt)))
    out.push({ key: `a:${r.requestId}`, kind: 'approval', title: r.sessionTitle, meta: `${r.title}${r.detail ? `: ${r.detail}` : ''}`, href: sessionHref(r.sessionId), at: r.createdAt, level: 'critical' });
  for (const d of [...a.deploys.items].sort((x, y) => time(x.startedAt) - time(y.startedAt)))
    out.push({ key: `d:${d.id}`, kind: 'deploy', title: deployTitle(d), meta: deployMeta(d), href: ciRunHref(d.id), at: d.startedAt, level: 'critical' });
  const lost = data.sessions.ok ? interruptedSessions(data.sessions) : [];
  for (const s of lost)
    out.push({ key: `s:${s.id}`, kind: 'interrupted', title: s.title, meta: ['Interrupted', s.claudeName, workspaceLabel(s.workspaceId)].filter(Boolean).join(' · '), href: sessionHref(s.id), at: s.lastActivityAt, level: 'warn' });
  for (const r of a.ci.items) out.push({ key: `c:${r.id}`, kind: 'ci', title: ciTitle(r), meta: ciMeta(r), href: ciRunHref(r.id), at: r.finishedAt, level: 'warn' });
  for (const t of a.tickets.items) out.push({ key: `t:${t.id}`, kind: 'ticket', title: t.summary, meta: ticketMeta(t), href: ticketHref(t.id), at: t.updatedAt, level: 'warn' });
  const interrupted = data.sessions.ok ? Math.max(data.sessions.interrupted, lost.length) : 0;
  const total = a.approvals.count + a.deploys.count + interrupted + a.ci.count + a.tickets.count;
  const unread = [
    !a.approvals.ok && 'requests',
    !a.deploys.ok && 'deploys',
    !data.sessions.ok && 'sessions',
    !a.ci.ok && 'CI',
    !a.tickets.ok && 'tickets',
  ].filter((x): x is string => !!x);
  const items = out.slice(0, max);
  return { items, total, listed: items.length, unread };
}
