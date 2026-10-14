// Efficiency lab (T-287 slice 2, docs/prd/claude-usage.md §28.7): a slice's outcome from its ticket's status timeline. A rule of thumb over
// what the ticket records, never a guess where it records nothing: after the slice ended, the ticket's next decision is `done` (accepted) or a
// send-back from in review to work (rework); an accepted ticket that is reopened within 7 days of done makes it a defect. No ticket, no
// decision yet, or a ticket the lab can not read: unknown. The ticket's last ESTIMATE comment gives its size (S, M, L, XL), nothing else of
// the comment is read or kept.

import type { DatabaseSync } from 'node:sqlite';
import type { LabOutcome } from '@portal/contracts';

export const DAY_MS = 86_400_000;
/** How long after done a reopen still counts as a defect of the delivered work. */
export const DEFECT_WINDOW_MS = 7 * DAY_MS;

export interface StatusChange {
  atMs: number;
  from: string;
  to: string;
}

export interface TicketFacts {
  /** Status, close and reopen events, oldest first. */
  changes: StatusChange[];
  estimateSize: string | null;
}

export type TicketReader = (ticket: string) => TicketFacts | null;

const WORK = new Set(['open', 'in_progress', 'blocked']);
const NOT_CLOSED = new Set(['open', 'in_progress', 'blocked', 'in_review']);
const SIZE = /\b(?:size|effort(?:\s+class)?)\s*[:=]?\s*(XL|S|M|L)\b/i;

/** The size an ESTIMATE comment names, or null. */
export function estimateSizeOf(body: string): string | null {
  if (!/^\s*\**ESTIMATE\b/i.test(body)) return null;
  const m = SIZE.exec(body);
  return m ? m[1]!.toUpperCase() : null;
}

/** The outcome of a slice that ended at `endMs`, from its ticket's facts (null: no ticket or not readable). */
export function outcomeOf(endMs: number | null, facts: TicketFacts | null): LabOutcome {
  if (!facts || endMs === null) return 'unknown';
  for (const c of facts.changes) {
    if (c.atMs < endMs) continue;
    if (c.to === 'done') {
      const reopened = facts.changes.some((r) => r.atMs > c.atMs && r.atMs <= c.atMs + DEFECT_WINDOW_MS && r.from === 'done' && NOT_CLOSED.has(r.to));
      return reopened ? 'defect' : 'accepted';
    }
    if (c.from === 'in_review' && WORK.has(c.to)) return 'rework';
  }
  return 'unknown';
}

/** Reads a ticket's facts from the portal's own ticket tables (read only). `T-12` is ticket number 12. */
export function dbTicketReader(db: DatabaseSync): TicketReader {
  return (ticket) => {
    const m = /^T-(\d{1,9})$/.exec(ticket);
    if (!m) return null;
    try {
      const rows = db
        .prepare("SELECT at, kind, body, data FROM ticket_events WHERE ticket_number = ? AND kind IN ('status', 'closed', 'reopened', 'comment') ORDER BY id")
        .all(Number(m[1])) as { at: string; kind: string; body: string | null; data: string | null }[];
      const changes: StatusChange[] = [];
      let estimateSize: string | null = null;
      for (const r of rows) {
        if (r.kind === 'comment') {
          estimateSize = (r.body && estimateSizeOf(r.body)) || estimateSize;
          continue;
        }
        const d = r.data ? (JSON.parse(r.data) as { from?: unknown; to?: unknown }) : {};
        const atMs = Date.parse(r.at);
        if (typeof d.from === 'string' && typeof d.to === 'string' && Number.isFinite(atMs)) changes.push({ atMs, from: d.from, to: d.to });
      }
      return { changes, estimateSize };
    } catch {
      return null; // no ticket tables (a bare store) or a row the lab can not read: unknown, never a guess
    }
  };
}
