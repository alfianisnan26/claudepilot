// What an attribution row says (docs/prd/claude-usage.md §21): who spent what, by session (a tree: a session's children are rolled up into it),
// workspace, ticket or persona. Pure, so the wording is tested without a browser. Dollars are estimates; the page's header carries the "est.".

import type { AttributionBy, ChatUsageRange, AttributionReport, AttributionRow, SpendFigure } from '@portal/contracts';
import { formatCost } from '@/lib/usage/format';

/** The dimensions the tab offers. (By Claude and by model are the Requests tab's.) */
export const BY_OPTIONS: { value: AttributionBy; label: string }[] = [
  { value: 'session', label: 'Agent' },
  { value: 'workspace', label: 'Workspace' },
  { value: 'ticket', label: 'Ticket' },
  { value: 'persona', label: 'Persona' },
];

/**
 * The attribution request's URL, for the page's rows and for the CSV download alike, so Export follows the filter the page shows: `done`
 * (only tickets closed as done in the window) applies to the ticket view only.
 */
export function attributionUrl(base: string, by: AttributionBy, range: ChatUsageRange, opts: { done?: boolean; csv?: boolean } = {}): string {
  return `${base}?by=${by}&range=${range}${opts.done && by === 'ticket' ? '&done=1' : ''}${opts.csv ? '&format=csv' : ''}`;
}

/** A share of the window's dollars, a percent from 0 to 100: "24 %", or "-" where it cannot be told. */
export const shareText = (share: SpendFigure): string => (share.basis === 'unavailable' ? '-' : `${Math.round(share.value)} %`);

/** What a row is called: the server's label ("No ticket", "Not recorded"), and for the rest of the roots "Others". */
export const rowName = (row: AttributionRow): string => row.label || (row.state === 'others' ? 'Others' : row.key);

/** What a session row says under its title. `own` is only set when the session started others (its total then includes them). */
export interface SessionLine {
  claude: string;
  claudeId: string;
  ticket: string | null;
  own: string | null;
  /** The session was deleted: its requests stay, its title and links are the last ones recorded. */
  deleted: boolean;
  /** A later row of a continued chat (T-312): the same chat as the row it sits under, not another agent. */
  continued: boolean;
}

export function sessionLine(row: AttributionRow): SessionLine | null {
  const s = row.session;
  if (!s) return null;
  // T-1098: the ticket's bucket key (KONF-12) when the server sends it.
  return { claude: s.claudeName, claudeId: s.claudeId, ticket: s.ticketKey ?? s.ticketId, own: s.children > 0 ? `own ${formatCost(row.own.costUsd)}` : null, deleted: !s.exists, continued: s.continuedFrom !== null && s.depth > 0 };
}

/** A ticket row's facts under its title (T-449): "feature · done · via lead $1.20"; the via-lead part only when leads' dollars were apportioned to it. Null for other rows. */
export function ticketLine(row: AttributionRow): { type: string; status: string; viaLead: string | null } | null {
  const t = row.ticket;
  if (!t) return null;
  // A ticket the portal has no record of has neither: say "unknown" in words, never a bare dash.
  return { type: t.type ?? 'unknown', status: (t.status ?? 'unknown').replace(/_/g, ' '), viaLead: t.viaLeadUsd > 0 ? `via lead ${formatCost(t.viaLeadUsd)}` : null };
}

/** The line under a workspace, ticket or persona row: how many sessions and requests are behind it. */
export function countsLine(row: AttributionRow): string {
  const sessions = `${row.sessions} ${row.sessions === 1 ? 'session' : 'sessions'}`;
  const requests = `${row.total.requests} ${row.total.requests === 1 ? 'request' : 'requests'}`;
  return `${sessions} · ${requests}`;
}

/** The biggest total in the list, for the bars. */
export const maxTotal = (rows: readonly AttributionRow[]): number => Math.max(0, ...rows.filter((r) => r.state !== 'others').map((r) => r.total.costUsd));

/**
 * How much of the window's dollars have a known row (a ticket, a persona): below 100 % the page says so beside the title, since the rest is
 * not recorded (an older request, or a deleted session) rather than nobody's. Null when all of it is known or nothing can be said.
 */
export function coverageNote(report: Pick<AttributionReport, 'coverage'>): { pct: number } | null {
  const c = report.coverage;
  if (c.basis === 'unavailable') return null;
  return c.value >= 100 ? null : { pct: Math.round(c.value) };
}

/** Top-level rows shown at first, and how many more each "Load more" adds (T-377). */
export const ATTRIBUTION_PAGE = 10;

/** A top-level row and, by `session`, the agents it started (all the way down, in tree order), folded under it on the page. */
export interface AttributionItem {
  row: AttributionRow;
  nested: AttributionRow[];
}

/**
 * The report's rows as the page lists them (T-377, T-955): each top-level row with the rows nested under it (by `session`: depth > 0, in the
 * server's tree order), "Others" (the roots past the server's limit) apart, and "No ticket" / "Not recorded" rows apart at the end. A row
 * already listed (same state and key) is never listed again, so a lead shows once however the tree came in.
 */
export function foldRows(rows: readonly AttributionRow[]): { items: AttributionItem[]; others: AttributionRow | null; tail: AttributionRow[] } {
  const items: AttributionItem[] = [];
  const tail: AttributionRow[] = [];
  let others: AttributionRow | null = null;
  const seen = new Set<string>();
  for (const r of rows) {
    const id = `${r.state}|${r.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (r.state === 'others') others = r;
    else if (r.state !== 'known') tail.push(r);
    else if ((r.session?.depth ?? 0) > 0 && items.length > 0) items.at(-1)!.nested.push(r);
    else items.push({ row: r, nested: [] });
  }
  return { items, others, tail };
}

/** The first `shown` items (the server sends them biggest first) and how many are left for "Load more". */
export function pageItems<T>(items: readonly T[], shown: number): { visible: T[]; left: number } {
  const n = Math.max(0, Math.min(items.length, shown));
  return { visible: items.slice(0, n), left: items.length - n };
}

/** The fold toggle's words: "3 agents" ("1 agent"). */
export const nestedText = (n: number): string => `${n} ${n === 1 ? 'agent' : 'agents'}`;
