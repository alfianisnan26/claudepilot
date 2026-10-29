// The tickets adapter: `human_request` when a ticket is ASSIGNED TO A PERSON by an agent, a trigger or the portal (not by the person in the
// portal) and is open (tickets PRD FR12, FR25). Fed by the tickets hook (`Tickets.onEvent`, after commit). The ticket's summary and
// description are never read here: the number, the type and the workspace only. A closed ticket dims its Inbox rows.

import type { TicketEventKind } from '@portal/contracts';
import type { NotifyBus } from '../bus.js';

export interface TicketEventLike {
  ticketId: string;
  kind: TicketEventKind;
  actor: string;
  fromAgent: boolean;
  data: Record<string, unknown> | null;
}

export interface TicketSource {
  onEvent?: (e: TicketEventLike) => void;
  /** T-1993: asked as the portal itself (the bucket rule is the caller's; the notifier is not a person). */
  brief?(caller: { kind: 'system' }, id: string): { id: string; status: string } | null;
}

export function adaptTickets(
  tickets: TicketSource,
  bus: NotifyBus,
  opts: { info: (id: string) => { type: string; workspaceId: string | null; open: boolean } | null; closed?: (ticketId: string) => void },
): () => void {
  const was = tickets.onEvent;
  const mine = (e: TicketEventLike) => {
    try {
      was?.(e);
    } finally {
      const to = (e.data?.to ?? null) as { kind?: string } | null;
      const byPerson = e.actor === 'ui' || e.actor.startsWith('user:');
      if (e.kind === 'assigned' && to?.kind === 'user' && !byPerson) {
        const t = opts.info(e.ticketId);
        if (t?.open) bus.emit({ kind: 'human_request', subject: { type: 'ticket', id: e.ticketId, workspaceId: t.workspaceId }, facts: { ticket: e.ticketId, type: t.type, workspace: t.workspaceId } });
      } else if (e.kind === 'closed') opts.closed?.(e.ticketId);
    }
  };
  tickets.onEvent = mine;
  return () => {
    if (tickets.onEvent === mine) tickets.onEvent = was;
  };
}
