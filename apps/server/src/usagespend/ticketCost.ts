// Usage spend: what a ticket cost, leads included (T-449). A lead is a session with no ticket of its own that started workers on tickets
// (session_spawn with a ticket). Its requests in the window are split over those tickets in proportion to the number of its workers with
// requests in the window, per ticket: the basis is `ATTRIBUTION_LEAD_BASIS`, never a guess. A lead whose workers are on no ticket stays "No ticket".
//
// Pure, in integer millionths of a dollar so the parts add up to the lead's dollars EXACTLY: floors, then the remainder one millionth at a time
// to the largest fractions, ties to the lower ticket number. The attribution report (by ticket), the Portal MCP tools and the lab (lab/index.ts)
// all read this one function through `attribute()` / `ticketCostReport`.

import type { SessionInfo, UsageRow } from './model.js';

/** A session's ticket as `attribution.ts` reads it (`known` with the ticket id, `none`, or `unknown`). */
export interface TicketCell {
  state: 'known' | 'none' | 'unknown';
  key: string;
}

export interface LeadPart {
  ticket: string;
  /** Millionths of a dollar of leads' requests given to the ticket. */
  micro: number;
  /** Workers (chains) on the ticket behind the weight. */
  workers: number;
}

export interface LeadApportion {
  /** Per ticket, by ticket id. */
  parts: Map<string, LeadPart>;
  /** Millionths of a dollar taken out of "No ticket" (the sum of every part). */
  micro: number;
  /** Leads that had workers on tickets. */
  leads: number;
}

const toMicro = (usd: number): number => Math.round(usd * 1e6);
const ticketNumber = (id: string): number => Number(id.replace(/^T-/, '')) || 0;

/** Splits `total` over integer `weights` (all > 0), exactly: floors, then the remainder to the largest fractions, then the lower key. Deterministic. */
export function splitExact(total: number, weights: readonly { key: string; weight: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  const sum = weights.reduce((s, w) => s + w.weight, 0);
  if (!(sum > 0) || total <= 0) return out;
  const parts = weights.map((w) => {
    const exact = (total * w.weight) / sum;
    const floor = Math.floor(exact);
    return { key: w.key, floor, frac: exact - floor };
  });
  let rest = total - parts.reduce((s, p) => s + p.floor, 0);
  const order = [...parts].sort((a, b) => b.frac - a.frac || ticketNumber(a.key) - ticketNumber(b.key) || a.key.localeCompare(b.key));
  for (const p of order) {
    if (rest <= 0) break;
    p.floor += 1;
    rest -= 1;
  }
  for (const p of parts) out.set(p.key, p.floor);
  return out;
}

export interface ApportionInput {
  rows: readonly UsageRow[];
  sessions: ReadonlyMap<string, SessionInfo>;
  /** A session's ticket, as the report reads it (own, else the nearest ancestor's). */
  ticketOf(sessionId: string): TicketCell;
  chainRootOf(id: string): string;
  /** A session and each step up as far as known. */
  lineage(id: string): SessionInfo[];
}

/** The dollars of tickets' leads, per ticket (see the file's header). */
export function apportionLeads(input: ApportionInput): LeadApportion {
  const withRows = new Set(input.rows.map((r) => r.sessionId));
  // Worker chains with requests, on a ticket, whose nearest ancestor outside the chain is a session with no ticket: that is their lead.
  const workersByLead = new Map<string, Map<string, Set<string>>>(); // lead chain root -> ticket -> worker chain roots
  for (const id of [...withRows].sort()) {
    const cell = input.ticketOf(id);
    if (cell.state !== 'known') continue;
    const root = input.chainRootOf(id);
    const up = input.lineage(root).find((s) => s.sessionId !== root && input.chainRootOf(s.sessionId) !== root);
    if (!up) continue;
    const upCell = input.ticketOf(up.sessionId);
    if (upCell.state !== 'none') continue;
    const lead = input.chainRootOf(up.sessionId);
    const byTicket = workersByLead.get(lead) ?? new Map<string, Set<string>>();
    const set = byTicket.get(cell.key) ?? new Set<string>();
    set.add(root);
    byTicket.set(cell.key, set);
    workersByLead.set(lead, byTicket);
  }
  const parts = new Map<string, LeadPart>();
  let micro = 0;
  let leads = 0;
  for (const [lead, byTicket] of [...workersByLead].sort((a, b) => a[0].localeCompare(b[0]))) {
    // The lead's dollars: its own chain's requests that carry no ticket (a segment that holds one is that ticket's own).
    let cost = 0;
    for (const r of input.rows) if (input.chainRootOf(r.sessionId) === lead && input.ticketOf(r.sessionId).state === 'none') cost += toMicro(r.costUsd);
    if (cost <= 0) continue;
    const split = splitExact(cost, [...byTicket].map(([key, set]) => ({ key, weight: set.size })));
    leads++;
    for (const [ticket, m] of split) {
      const p = parts.get(ticket) ?? { ticket, micro: 0, workers: 0 };
      p.micro += m;
      p.workers += byTicket.get(ticket)!.size;
      parts.set(ticket, p);
      micro += m;
    }
  }
  return { parts, micro, leads };
}
