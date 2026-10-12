import type { ConnectEnrollment, ConnectLink, ConnectNodeView, ConnectScannedView, ConnectTargetRow, ConnectTargetView } from '@portal/contracts';
import { timeAgo } from '@/lib/format';
import { kindWord } from './kinds';

export type Dot = 'connected' | 'partial' | 'offline' | 'pending' | 'scanned-up' | 'scanned-down';

export const LINK_LABEL: Record<ConnectLink, string> = { connected: 'Connected', partial: 'Partial', offline: 'Offline', pending: 'Waiting' };

export const isEnrolled = (r: ConnectTargetRow): r is ConnectTargetView => r.source === 'enrolled';

export function dotOf(r: ConnectTargetRow): Dot {
  if (!isEnrolled(r)) return r.available ? 'scanned-up' : 'scanned-down';
  return r.link;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The most recent time any node of the target was seen, or null. */
export function lastSeen(nodes: ConnectNodeView[]): string | null {
  const times = nodes.map((n) => n.lastSeenAt).filter((t): t is string => !!t);
  return times.length ? times.reduce((a, b) => (a > b ? a : b)) : null;
}

/** The row's one muted line (PRD §16.1). */
export function rowLine(r: ConnectTargetRow, now = Date.now()): string {
  if (!isEnrolled(r)) return r.available ? `Scanned · ${r.where}` : `Scanned · ${r.problem ?? 'unreachable'}`;
  if (r.link === 'pending') return 'Waiting for the connector';
  const word = kindWord(r.kind);
  if (r.link === 'offline') {
    const seen = lastSeen(r.nodes);
    return seen ? `Offline · ${timeAgo(seen, now)}` : 'Offline';
  }
  if (r.role === 'single') return `${word} · ${plural(r.workspaces, 'workspace')}`;
  const nodes = r.link === 'partial' ? `${r.nodes.filter((n) => n.link === 'connected').length} of ${plural(r.nodes.length, 'node')}` : plural(r.nodes.length, 'node');
  return `${word} · ${nodes} · ${plural(r.workspaces, 'workspace')}`;
}

/** What the page's Workspaces card says: `3 of 4 reachable`. */
export function reachableLine(rows: ConnectTargetRow[]): string {
  const up = rows.filter((r) => (isEnrolled(r) ? r.link === 'connected' || r.link === 'partial' : r.available)).length;
  return `${up} of ${rows.length} reachable`;
}

/** Waiting, connected, expired or revoked: what the wizard's live line says about one enrollment. */
export type EnrollmentLive =
  | { state: 'waiting'; enrolled: boolean }
  | { state: 'connected'; node: ConnectNodeView }
  | { state: 'expired' }
  | { state: 'revoked' }
  | { state: 'removed' };

/**
 * The wizard's live line, from the registry's view of the target and the enrollment's own state.
 * `baseline` is the node ids the target had when this command was made, so "Add node" waits for a NEW node.
 */
export function enrollmentLive(target: ConnectTargetView | null, enrollment: ConnectEnrollment | null, baseline: readonly string[], now = Date.now()): EnrollmentLive {
  if (!target) return { state: 'removed' };
  const node = target.nodes.find((n) => n.state === 'enrolled' && n.link === 'connected' && !baseline.includes(n.id));
  if (node) return { state: 'connected', node };
  if (enrollment?.state === 'revoked') return { state: 'revoked' };
  if (enrollment && (enrollment.state === 'expired' || (enrollment.state === 'waiting' && Date.parse(enrollment.expiresAt) <= now))) return { state: 'expired' };
  // `enrolled`: the token was used but the tunnel is not up yet.
  return { state: 'waiting', enrolled: enrollment?.state === 'used' };
}

export type ScannedRow = ConnectScannedView;
