// Usage spend: the per-ticket figures, in ONE function (T-449). The attribution report (by=ticket), the Portal MCP tools and the lab (lab/index.ts)
// all call this: a ticket's own dollars, the part of leads' dollars apportioned to it (ticketCost.ts), its type, status and done time.

import type { SessionInfo, UsageRow } from './model.js';
import { attribute, type Attribution } from './attribution.js';
import type { SpendStore } from './store.js';

export interface TicketReportInput {
  rows: UsageRow[];
  /** The sessions of `rows` and their known ancestors (`SpendStore.sessions`). */
  sessions: ReadonlyMap<string, SessionInfo>;
  fromMs: number;
  toMs: number;
  limit: number;
  /** Only tickets closed as done inside the window. */
  doneOnly?: boolean;
  /**
   * T-2945: whether the caller may see a ticket (its bucket's `view`). A ticket it may not see has no facts, exactly like one that does not
   * exist: no type, status or done time on its row, out of `doneOnly` and of the done-by-type figures. Absent: the portal's own view (all).
   */
  ticketVisible?: (ticketId: string) => boolean;
}

export function ticketReport(store: SpendStore, i: TicketReportInput): Attribution {
  const ids = new Set<string>();
  for (const s of i.sessions.values()) if (s.ticketId && (!i.ticketVisible || i.ticketVisible(s.ticketId))) ids.add(s.ticketId);
  const facts = store.ticketFacts(ids);
  return attribute({
    by: 'ticket',
    rows: i.rows,
    sessions: i.sessions,
    personas: new Map(),
    limit: i.limit,
    claudeName: (id) => id,
    personaName: (_p, rec) => rec ?? 'Persona',
    ticketFacts: (id) => (ids.has(id) ? (facts.get(id) ?? null) : null),
    window: { fromMs: i.fromMs, toMs: i.toMs },
    ...(i.doneOnly ? { doneOnly: true } : {}),
  });
}
