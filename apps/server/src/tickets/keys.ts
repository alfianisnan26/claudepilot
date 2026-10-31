// T-1098: a ticket's bucket key (`KONF-12`) for the tool results of other modules (CI runs, trigger runs, the lab, usage), which store the stable
// `T-<n>`. The tickets module installs the lookup when it registers its routes or tools; until then (and in another module's tests) there is no
// key and a result carries the stable id only. A primary-key read, never a list.
//
// T-1993: the key names a bucket and its number, so it is shown only to a caller who may view that bucket: every call passes the caller's seam
// actor, and the lookup reads through the tickets service's one visibility rule. A hidden ticket has no key, exactly like one with no lookup.

import type { Actor } from '@portal/contracts';

let lookup: ((ticketId: string, actor: Actor) => string | null) | null = null;

export function setTicketKeyLookup(fn: ((ticketId: string, actor: Actor) => string | null) | null): void {
  lookup = fn;
}

/** The key of a stored ticket id as `actor` may see it, or null (none, no lookup installed, no such ticket, a bucket it may not view, or the database is away). */
export function ticketKeyOf(ticketId: string | null | undefined, actor: Actor): string | null {
  if (!ticketId || !lookup) return null;
  try {
    return lookup(ticketId, actor);
  } catch {
    return null;
  }
}

/** `{ ticket_key }` for a tool row beside its `ticket_id`, or nothing when there is no key (or `actor` may not view its bucket). */
export const ticketKeyField = (ticketId: string | null | undefined, actor: Actor): { ticket_key?: string } => {
  const key = ticketKeyOf(ticketId, actor);
  return key ? { ticket_key: key } : {};
};
