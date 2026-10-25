// Pilot metrics (T-2360, §28.15): the loader. Reads the closed tickets of a bounded span (the window and the one before it, by the
// `tickets_closed_at` index of migration 856), their events, verdicts and merge records (by ticket number, indexed), and the open work now.
// Read only. Ticket text is not kept: of a comment only the first 300 characters after "Self-test:" are read, in SQL, to find its verdict.

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { SessionInfo } from '../usagespend/model.js';
import type { FlowTicketFacts, OpenTicketFacts } from './flowMetrics.js';
import { programIdOf } from './scorecard.js';

const CHUNK = 400;
const inList = (n: number) => `(${Array(n).fill('?').join(', ')})`;
const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
};

function chunked<R>(db: DatabaseSync, ids: readonly number[], sql: (list: string) => string, extra: SQLInputValue[] = []): R[] {
  const out: R[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    out.push(...(db.prepare(sql(inList(part.length))).all(...part, ...extra) as unknown as R[]));
  }
  return out;
}

/** D-102's self-test line (flow/engine.ts), and its fail form: `Self-test: <job | command> on <sha> pass|fail <N>`. */
export const SELF_TEST_VERDICT = /^Self-test:\s*\S.*?\son\s+[0-9a-f]{12,40}\s+(pass|fail)\b/i;

/** The verdict a comment carries: its `data.verdict` (QA or review verdict), else a self-test line; null for any other comment. */
export function verdictOf(data: string | null, selfTest: string | null): boolean | null {
  if (data) {
    try {
      const v = (JSON.parse(data) as { verdict?: unknown }).verdict;
      if (typeof v === 'string') return v.toLowerCase() === 'pass';
    } catch {
      // not JSON: no verdict in it
    }
  }
  const m = selfTest ? SELF_TEST_VERDICT.exec(selfTest.split('\n')[0]!.trim()) : null;
  return m ? m[1]!.toLowerCase() === 'pass' : null;
}

/** The unit lead of a ticket: its first `area-*` tag (sorted), else `lead:<lineage root>` of the session that held it, else `unrecorded`. */
export function leadOf(tags: readonly string[], holder: string | null, sessions: ReadonlyMap<string, SessionInfo> | null): string {
  const area = [...tags].filter((t) => t.startsWith('area-')).sort()[0];
  if (area) return area;
  if (holder && sessions?.has(holder)) {
    const root = programIdOf(holder, sessions);
    if (root) return `lead:${root}`;
  }
  return 'unrecorded';
}

/**
 * The tickets closed (done or won't-do) in [fromMs, toMs), with what their stages need. `sessionsOf` resolves holder sessions with their
 * lineage (usage spend's `sessions`); null leaves the lead to the `area-*` tag.
 */
export function loadFlowTickets(db: DatabaseSync, fromMs: number, toMs: number, sessionsOf: ((ids: Iterable<string>) => Map<string, SessionInfo>) | null): FlowTicketFacts[] {
  const rows = db
    .prepare(
      `SELECT number, type, priority, status, created_at, closed_at, assignee_kind, assignee_ref FROM tickets
       WHERE closed_at >= ? AND closed_at < ? AND status IN ('done', 'wont_do')`,
    )
    .all(new Date(fromMs).toISOString(), new Date(toMs).toISOString()) as unknown as {
    number: number;
    type: string;
    priority: string;
    status: 'done' | 'wont_do';
    created_at: string;
    closed_at: string;
    assignee_kind: string | null;
    assignee_ref: string | null;
  }[];
  type Acc = { starts: number[]; firstAgent: number | null; verdicts: { atMs: number; pass: boolean }[]; merges: number[]; tags: string[]; holder: string | null };
  const by = new Map<number, Acc>();
  for (const r of rows) by.set(r.number, { starts: [], firstAgent: null, verdicts: [], merges: [], tags: [], holder: r.assignee_kind === 'session' ? r.assignee_ref : null });
  const numbers = [...by.keys()];
  const events = chunked<{ ticket_number: number; at: string; kind: string; actor: string; data: string | null; st: string | null }>(
    db,
    numbers,
    (l) =>
      `SELECT ticket_number, at, kind, actor, data, CASE WHEN kind = 'comment' AND instr(body, 'Self-test:') > 0 THEN substr(body, instr(body, 'Self-test:'), 300) END AS st
       FROM ticket_events WHERE ticket_number IN ${l} AND kind IN ('status', 'comment') ORDER BY ticket_number, id`,
  );
  for (const e of events) {
    const a = by.get(e.ticket_number)!;
    const at = ms(e.at);
    if (at === null) continue;
    if (e.kind === 'status') {
      try {
        const d = JSON.parse(e.data ?? '{}') as { to?: unknown };
        if (d.to === 'in_progress') {
          a.starts.push(at);
          if (!a.holder && e.actor.startsWith('session:')) a.holder = e.actor.slice('session:'.length);
        }
      } catch {
        // a status event without readable data is not a start
      }
      continue;
    }
    if (a.firstAgent === null && e.actor.startsWith('session:')) a.firstAgent = at;
    const v = verdictOf(e.data, e.st);
    if (v !== null) a.verdicts.push({ atMs: at, pass: v });
  }
  for (const m of chunked<{ ticket_number: number; at: string }>(db, numbers, (l) => `SELECT ticket_number, at FROM ticket_merge_status WHERE ticket_number IN ${l} AND state = 'merged' ORDER BY ticket_number, id`)) {
    const at = ms(m.at);
    if (at !== null) by.get(m.ticket_number)!.merges.push(at);
  }
  for (const t of chunked<{ ticket_number: number; tag: string }>(db, numbers, (l) => `SELECT ticket_number, tag FROM ticket_tags WHERE ticket_number IN ${l}`)) by.get(t.ticket_number)!.tags.push(t.tag);
  const holders = new Set<string>();
  for (const a of by.values()) if (a.holder && !a.tags.some((t) => t.startsWith('area-'))) holders.add(a.holder);
  let sessions: Map<string, SessionInfo> | null = null;
  if (sessionsOf && holders.size) {
    try {
      sessions = sessionsOf(holders);
    } catch {
      sessions = null;
    }
  }
  const out: FlowTicketFacts[] = [];
  for (const r of rows) {
    const a = by.get(r.number)!;
    const created = ms(r.created_at);
    const closed = ms(r.closed_at);
    if (created === null || closed === null) continue;
    const sort = (xs: number[]) => xs.sort((x, y) => x - y);
    out.push({
      id: `T-${r.number}`,
      type: r.type,
      priority: r.priority,
      status: r.status,
      createdAtMs: created,
      closedAtMs: closed,
      tags: a.tags.sort(),
      lead: leadOf(a.tags, a.holder, sessions),
      starts: sort(a.starts),
      firstAgentCommentMs: a.firstAgent,
      verdicts: a.verdicts.sort((x, y) => x.atMs - y.atMs),
      merges: sort(a.merges),
    });
  }
  return out;
}

/** Every ticket that is open work now (open, in progress, blocked, in review), with its tags and, in review, since when. */
export function loadOpenTickets(db: DatabaseSync): OpenTicketFacts[] {
  const rows = db
    .prepare(`SELECT number, status, created_at, updated_at, assignee_kind, assignee_ref FROM tickets WHERE status IN ('open', 'in_progress', 'blocked', 'in_review')`)
    .all() as unknown as { number: number; status: string; created_at: string; updated_at: string; assignee_kind: string | null; assignee_ref: string | null }[];
  const tags = new Map<number, string[]>();
  const numbers = rows.map((r) => r.number);
  for (const t of chunked<{ ticket_number: number; tag: string }>(db, numbers, (l) => `SELECT ticket_number, tag FROM ticket_tags WHERE ticket_number IN ${l}`)) (tags.get(t.ticket_number) ?? tags.set(t.ticket_number, []).get(t.ticket_number)!).push(t.tag);
  const review = rows.filter((r) => r.status === 'in_review').map((r) => r.number);
  const since = new Map<number, number>();
  for (const e of chunked<{ ticket_number: number; at: string }>(
    db,
    review,
    (l) => `SELECT ticket_number, MAX(at) AS at FROM ticket_events WHERE ticket_number IN ${l} AND kind = 'status' AND json_extract(data, '$.to') = 'in_review' GROUP BY ticket_number`,
  )) {
    const at = ms(e.at);
    if (at !== null) since.set(e.ticket_number, at);
  }
  return rows.map((r) => {
    const created = ms(r.created_at) ?? 0;
    return {
      id: `T-${r.number}`,
      status: r.status,
      tags: (tags.get(r.number) ?? []).sort(),
      updatedAtMs: ms(r.updated_at) ?? created,
      statusSinceMs: since.get(r.number) ?? created,
      assigneeSession: r.assignee_kind === 'session' ? r.assignee_ref : null,
    };
  });
}

/** The `program-*` tags in use (a range on the tag index). */
export function loadProgramTags(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT DISTINCT tag FROM ticket_tags WHERE tag >= 'program-' AND tag < 'program.' ORDER BY tag`).all() as unknown as { tag: string }[]).map((r) => r.tag);
}
