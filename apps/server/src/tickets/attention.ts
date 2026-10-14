// Tickets waiting on a person's decision (Needs you, docs/prd/attention.md): open tickets of type `approval` assigned to a person (an
// agent asked a person to decide; agents never claim approvals). Class: a question. Read only, next to the tickets module and without
// touching its service: one query on the tickets table. Who decides: a person with operate on the ticket.

import { objectRef, ticketIdOf, type AttentionItem, type TicketPriority } from '@portal/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { can } from '../authz/seam.js';
import { clip, present, readsPersonOnly, verbFor, type AttentionSource } from '../attention/registry.js';

interface Row {
  number: number;
  priority: TicketPriority;
  summary: string;
  reporter_kind: string;
  reporter_label: string;
  workspace_id: string | null;
  created_at: string;
}

export function ticketAttentionSource(db: () => DatabaseSync | null): AttentionSource {
  return {
    kind: 'ticket_approval',
    list(actor, _now, scope) {
      const d = db();
      if (!d) throw new Error('the database is not available');
      if (!readsPersonOnly(actor, scope)) return [];
      const rows = d
        .prepare(
          `SELECT number, priority, summary, reporter_kind, reporter_label, workspace_id, created_at FROM tickets
           WHERE type = 'approval' AND assignee_kind = 'user' AND closed_at IS NULL AND status NOT IN ('done', 'wont_do')
           ORDER BY created_at, number LIMIT 500`,
        )
        .all() as unknown as Row[];
      return rows
        .map((r) => ({ r, id: ticketIdOf(r.number) }))
        .filter(({ id }) => can(actor, verbFor(scope, 'operate'), objectRef('ticket', id)).allow)
        .map(
          ({ r, id }): AttentionItem => ({
            kind: 'ticket_approval',
            id,
            title: clip(r.summary, 120),
            who: present([r.reporter_kind === 'ui' ? null : { label: clip(r.reporter_label, 60) || 'An agent', link: null }]),
            why: 'question',
            risk: [`${r.priority} priority`, r.workspace_id ? clip(r.workspace_id, 60) : 'no workspace'].join(' · '),
            since: r.created_at,
            link: `/admin/tickets/${id}`,
            action: { label: 'Decide', method: 'POST', path: `/api/tickets/${id}/comments` },
          }),
        );
    },
  };
}
