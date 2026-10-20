// T-1098: a ticket's bucket key (`KONF-12`) for the tool results of other modules (CI runs, trigger runs, the lab, usage), which store the stable
// `T-<n>`. The tickets module installs the lookup when it registers its routes or tools; until then (and in another module's tests) there is no
// key and a result carries the stable id only. A primary-key read, never a list.

let lookup: ((ticketId: string) => string | null) | null = null;

export function setTicketKeyLookup(fn: ((ticketId: string) => string | null) | null): void {
  lookup = fn;
}

/** The key of a stored ticket id, or null (none, no lookup installed, no such ticket, or the database is away). */
export function ticketKeyOf(ticketId: string | null | undefined): string | null {
  if (!ticketId || !lookup) return null;
  try {
    return lookup(ticketId);
  } catch {
    return null;
  }
}

/** `{ ticket_key }` for a tool row beside its `ticket_id`, or nothing when there is no key. */
export const ticketKeyField = (ticketId: string | null | undefined): { ticket_key?: string } => {
  const key = ticketKeyOf(ticketId);
  return key ? { ticket_key: key } : {};
};
