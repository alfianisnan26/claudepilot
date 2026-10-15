// Tickets waiting on a person's decision (Needs you, docs/prd/attention.md): open tickets of type `approval` assigned to a person (an
// agent asked a person to decide; agents never claim approvals), and open tickets tagged `owner-checklist` (T-509), whatever their
// assignee, when the tag counts (T-527, D-62): the ticket also carries a tag the owner allows (`tickets.agentAssignUserTags`, default
// `production`), or a person added `owner-checklist` (the ticket's events say who: the `created` row's tags, then each `tags` row).
// Class: a question. Read only, next to the tickets module and without touching its service. Who decides: a person with operate on the ticket.

import { objectRef, ticketIdOf, type AttentionItem, type TicketPriority } from '@portal/contracts';
import type { DatabaseSync } from 'node:sqlite';
import { can } from '../authz/seam.js';
import { clip, present, readsPersonOnly, verbFor, type AttentionSource } from '../attention/registry.js';
import { AGENT_ASSIGN_USER_TAGS_DEFAULT, allowedAssignTags, OWNER_CHECKLIST_TAG } from './authz.js';

/** The only event actor that is a person: the page (`ui`). Agents, admin tokens, triggers and the portal are not (T-527). */
const PERSON_ACTOR = 'ui';

interface Row {
  number: number;
  type: string;
  assignee_kind: string | null;
  priority: TicketPriority;
  summary: string;
  reporter_kind: string;
  reporter_label: string;
  workspace_id: string | null;
  created_at: string;
}

interface EventRow {
  ticket_number: number;
  kind: 'created' | 'tags';
  actor: string;
  data: string | null;
}

const tagsIn = (v: unknown): string[] => (Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []);

/**
 * Who last added `owner-checklist` to each ticket, from its events: the `created` row when it was made with the tag, then every `tags`
 * row whose `to` has it and `from` does not. A ticket with no such event (tagged outside the service) has no adder: it does not count.
 */
function checklistAdders(d: DatabaseSync, numbers: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (!numbers.length) return out;
  const rows = d
    .prepare(`SELECT ticket_number, kind, actor, data FROM ticket_events WHERE kind IN ('created', 'tags') AND ticket_number IN (${numbers.map(() => '?').join(',')}) ORDER BY id`)
    .all(...numbers) as unknown as EventRow[];
  for (const e of rows) {
    let data: Record<string, unknown> = {};
    try {
      data = e.data ? (JSON.parse(e.data) as Record<string, unknown>) : {};
    } catch {
      continue;
    }
    const added = e.kind === 'created' ? tagsIn(data.tags).includes(OWNER_CHECKLIST_TAG) : tagsIn(data.to).includes(OWNER_CHECKLIST_TAG) && !tagsIn(data.from).includes(OWNER_CHECKLIST_TAG);
    if (added) out.set(e.ticket_number, e.actor);
  }
  return out;
}

export function ticketAttentionSource(db: () => DatabaseSync | null, agentAssignUserTags: () => unknown = () => AGENT_ASSIGN_USER_TAGS_DEFAULT): AttentionSource {
  return {
    kind: 'ticket_approval',
    list(actor, _now, scope) {
      const d = db();
      if (!d) throw new Error('the database is not available');
      if (!readsPersonOnly(actor, scope)) return [];
      let raw: unknown = AGENT_ASSIGN_USER_TAGS_DEFAULT;
      try {
        raw = agentAssignUserTags();
      } catch {
        // the setting could not be read: the built-in default holds
      }
      const allowed = allowedAssignTags(raw);
      const rows = d
        .prepare(
          `SELECT number, type, assignee_kind, priority, summary, reporter_kind, reporter_label, workspace_id, created_at FROM tickets
           WHERE ((type = 'approval' AND assignee_kind = 'user')
                  OR number IN (SELECT ticket_number FROM ticket_tags WHERE tag = ?))
             AND closed_at IS NULL AND status NOT IN ('done', 'wont_do')
           ORDER BY created_at, number LIMIT 500`,
        )
        .all(OWNER_CHECKLIST_TAG) as unknown as Row[];
      const approval = (r: Row) => r.type === 'approval' && r.assignee_kind === 'user';
      // T-527: an owner-checklist ticket that is not an approval counts only with an allowed tag or a person's tag.
      const checklistOnly = rows.filter((r) => !approval(r)).map((r) => r.number);
      const withAllowed = new Set<number>();
      if (checklistOnly.length && allowed.length) {
        const tagged = d
          .prepare(
            `SELECT DISTINCT ticket_number FROM ticket_tags WHERE ticket_number IN (${checklistOnly.map(() => '?').join(',')}) AND tag IN (${allowed.map(() => '?').join(',')})`,
          )
          .all(...checklistOnly, ...allowed) as { ticket_number: number }[];
        for (const t of tagged) withAllowed.add(t.ticket_number);
      }
      const adders = checklistAdders(d, checklistOnly.filter((n) => !withAllowed.has(n)));
      const counts = (r: Row) => approval(r) || withAllowed.has(r.number) || adders.get(r.number) === PERSON_ACTOR;
      return rows
        .filter(counts)
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
            action: { label: approval(r) ? 'Decide' : 'Reply', method: 'POST', path: `/api/tickets/${id}/comments` },
          }),
        );
    },
  };
}
