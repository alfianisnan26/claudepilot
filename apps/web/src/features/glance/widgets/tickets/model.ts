import { TICKET_STATUS_LABEL, type TicketList, type TicketStatus } from '@portal/contracts';
import type { GlanceCompact, GlanceLevel } from '../../types';
import { chipCount, listWords } from '../shared/format';

// The Tickets widget and its Home card (docs/prd/glance-widgets.md §18): the queue by status, those waiting for a person, the newest.

/** The statuses of a ticket that is not closed, in the queue's own order. */
export const OPEN_STATUSES: readonly TicketStatus[] = ['open', 'in_progress', 'blocked', 'in_review'];

export interface TicketsView {
  /** Not closed. */
  open: number;
  byStatus: { status: TicketStatus; label: string; count: number }[];
  /** Assigned to a person and not closed. */
  needsYou: number;
  /** Open and assigned to nobody: the agents' queue. */
  unassigned: number;
}

export function ticketsView(list: Pick<TicketList, 'counts'>): TicketsView {
  const c = list.counts;
  const byStatus = OPEN_STATUSES.map((status) => ({ status, label: TICKET_STATUS_LABEL[status], count: c.byStatus[status] ?? 0 }));
  return { open: byStatus.reduce((a, b) => a + b.count, 0), byStatus, needsYou: c.needsYou, unassigned: c.unassigned };
}

/** The chip: tickets not closed; amber while some wait for a person, red while one is blocked. */
export function ticketsCompact(v: TicketsView | null, failed: boolean): GlanceCompact {
  if (!v) return failed ? { value: '-', level: 'unknown', title: 'Tickets: not available', stale: true } : { value: null, level: 'unknown', title: 'Tickets: loading', loading: true };
  const blocked = v.byStatus.find((s) => s.status === 'blocked')?.count ?? 0;
  const level: GlanceLevel = v.needsYou ? 'warn' : v.open ? 'ok' : 'idle';
  const parts = listWords([`${v.open} open`, v.needsYou ? `${v.needsYou} waiting for you` : null, blocked ? `${blocked} blocked` : null]);
  return { value: chipCount(v.open), level, title: `Tickets: ${parts}` };
}
