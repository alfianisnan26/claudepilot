// What an attribution row says (docs/prd/claude-usage.md §21): who spent what, by session (a tree: a session's children are rolled up into it),
// workspace, ticket or persona. Pure, so the wording is tested without a browser. Dollars are estimates; the page's header carries the "est.".

import type { AttributionBy, AttributionReport, AttributionRow, SpendFigure } from '@portal/contracts';
import { formatCost } from '@/lib/usage/format';

/** The dimensions the tab offers. (By Claude and by model are the Requests tab's.) */
export const BY_OPTIONS: { value: AttributionBy; label: string }[] = [
  { value: 'session', label: 'Session' },
  { value: 'workspace', label: 'Workspace' },
  { value: 'ticket', label: 'Ticket' },
  { value: 'persona', label: 'Persona' },
];

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
}

export function sessionLine(row: AttributionRow): SessionLine | null {
  const s = row.session;
  if (!s) return null;
  return { claude: s.claudeName, claudeId: s.claudeId, ticket: s.ticketId, own: s.children > 0 ? `own ${formatCost(row.own.costUsd)}` : null, deleted: !s.exists };
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
