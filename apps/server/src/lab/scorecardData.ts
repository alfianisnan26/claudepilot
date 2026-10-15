// Crew scorecard (T-450 S1a): the loader. Reads the portal's tables into the plain facts `scorecard.ts` works on. Read only; a table this
// store does not have (or can not read) is `null`, which the scorecard shows as unavailable (no_source), never as 0.

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Store } from '../store/store.js';
import { SpendStore } from '../usagespend/store.js';
import { ticketReport } from '../usagespend/ticketReport.js';
import type { SessionInfo, UsageRow } from '../usagespend/model.js';
import { programIdOf, type CrewDeployRow, type CrewFacts, type CrewRun, type CrewSessionExtra, type CrewTicket, type TicketCostRow } from './scorecard.js';

const CHUNK = 400;
const inList = (n: number) => `(${Array(n).fill('?').join(', ')})`;
const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isFinite(v) ? v : null;
};

function tryRead<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function chunked<R>(db: DatabaseSync, ids: readonly (string | number)[], sql: (list: string) => string, extra: SQLInputValue[] = []): R[] {
  const out: R[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    out.push(...(db.prepare(sql(inList(part.length))).all(...part, ...extra) as unknown as R[]));
  }
  return out;
}

/**
 * The sessions of every program active since `sinceMs`: a session with a request since then or one still live is the seed; its program's
 * top is found through usage spend's lineage, and every session under a top (parents and continuations, live or kept after a delete) is
 * loaded with it.
 */
function loadSessions(db: DatabaseSync, spend: SpendStore, sinceMs: number): Map<string, SessionInfo> {
  const seed = new Set<string>();
  for (const r of db.prepare('SELECT DISTINCT session_id FROM chat_usage WHERE at_ms >= ?').all(sinceMs) as unknown as { session_id: string }[]) seed.add(r.session_id);
  for (const r of db.prepare(`SELECT id FROM chat_sessions WHERE state != 'ended'`).all() as unknown as { id: string }[]) seed.add(r.id);
  const up = spend.sessions(seed);
  const tops = new Set<string>();
  for (const id of seed) {
    const top = up.has(id) ? programIdOf(id, up) : null;
    if (top) tops.add(top);
  }
  // Down from each top: children (parent_id) and continuations (continued_from), bounded.
  const all = new Set<string>(tops);
  let level = [...tops];
  for (let depth = 0; level.length && depth < 32 && all.size < 5000; depth++) {
    const next: string[] = [];
    const rows = [
      ...chunked<{ id: string }>(db, level, (l) => `SELECT id FROM chat_sessions WHERE parent_id IN ${l}`),
      ...chunked<{ id: string }>(db, level, (l) => `SELECT id FROM chat_sessions WHERE continued_from IN ${l}`),
      ...chunked<{ id: string }>(db, level, (l) => `SELECT session_id AS id FROM usage_sessions WHERE parent_id IN ${l}`),
    ];
    for (const r of rows) if (!all.has(r.id)) (all.add(r.id), next.push(r.id));
    level = next;
  }
  return spend.sessions(all);
}

function loadExtra(db: DatabaseSync, ids: readonly string[]): Map<string, CrewSessionExtra> {
  const out = new Map<string, CrewSessionExtra>();
  const rows = chunked<{ id: string; agent: string | null; model: string | null; max_workers: number | null; subagents: number; created_at: string }>(
    db,
    ids,
    (l) => `SELECT id, agent, model, max_workers, subagents, created_at FROM chat_sessions WHERE id IN ${l}`,
  );
  for (const r of rows) out.set(r.id, { agent: r.agent, model: r.model, maxWorkers: r.max_workers, subagents: r.subagents === 1, createdAtMs: ms(r.created_at) ?? 0 });
  return out;
}

/** Tickets that may matter since `sinceMs`: not closed, or changed or closed since then (a ticket closed before it stayed closed). */
function loadTickets(db: DatabaseSync, sinceMs: number): CrewTicket[] {
  const since = new Date(sinceMs).toISOString();
  const rows = db
    .prepare(
      `SELECT number, type, status, closed_at, created_at, assignee_kind, assignee_ref FROM tickets
       WHERE status NOT IN ('done', 'wont_do') OR updated_at >= ? OR closed_at >= ?`,
    )
    .all(since, since) as unknown as { number: number; type: string; status: string; closed_at: string | null; created_at: string; assignee_kind: 'session' | 'user' | null; assignee_ref: string | null }[];
  const byNumber = new Map<number, CrewTicket>();
  for (const r of rows) {
    byNumber.set(r.number, {
      id: `T-${r.number}`,
      type: r.type,
      status: r.status,
      closedAtMs: ms(r.closed_at),
      createdAtMs: ms(r.created_at) ?? 0,
      assigneeKind: r.assignee_kind,
      assigneeRef: r.assignee_ref,
      changes: [],
      actors: new Set(),
      tags: [],
    });
  }
  const numbers = [...byNumber.keys()];
  const events = chunked<{ ticket_number: number; at: string; kind: string; actor: string; data: string | null }>(
    db,
    numbers,
    (l) => `SELECT ticket_number, at, kind, actor, data FROM ticket_events WHERE ticket_number IN ${l} ORDER BY id`,
  );
  for (const e of events) {
    const t = byNumber.get(e.ticket_number)!;
    if (e.actor.startsWith('session:')) t.actors.add(e.actor.slice('session:'.length));
    if (e.kind !== 'status' && e.kind !== 'closed' && e.kind !== 'reopened') continue;
    const at = ms(e.at);
    if (at === null) continue;
    let d: { from?: unknown; to?: unknown } = {};
    try {
      d = e.data ? (JSON.parse(e.data) as typeof d) : {};
    } catch {
      continue;
    }
    if (typeof d.from === 'string' && typeof d.to === 'string') t.changes.push({ atMs: at, from: d.from, to: d.to, kind: e.kind });
  }
  for (const t of byNumber.values()) t.changes.sort((a, b) => a.atMs - b.atMs);
  const tags = chunked<{ ticket_number: number; tag: string }>(db, numbers, (l) => `SELECT ticket_number, tag FROM ticket_tags WHERE ticket_number IN ${l}`);
  for (const r of tags) byNumber.get(r.ticket_number)!.tags.push(r.tag);
  return [...byNumber.values()];
}

function loadRuns(db: DatabaseSync, sinceMs: number): CrewRun[] {
  const rows = db
    .prepare(`SELECT id, number, pipeline, status, session_id, ticket_id, finished_at FROM ci_runs WHERE finished_at >= ? AND (session_id IS NOT NULL OR ticket_id IS NOT NULL)`)
    .all(new Date(sinceMs).toISOString()) as unknown as { id: string; number: number; pipeline: string; status: string; session_id: string | null; ticket_id: string | null; finished_at: string | null }[];
  return rows.map((r) => ({ id: r.id, number: r.number, pipeline: r.pipeline, status: r.status, sessionId: r.session_id, ticketId: r.ticket_id, finishedAtMs: ms(r.finished_at) }));
}

function loadDeploys(db: DatabaseSync, sinceMs: number): CrewDeployRow[] {
  const rows = db
    .prepare(
      `SELECT d.run_number, d.pipeline, d.environment, d.approval, d.outcome, d.created_at, r.session_id, r.ticket_id
       FROM ci_deployments d LEFT JOIN ci_runs r ON r.id = d.run_id WHERE d.created_at >= ?`,
    )
    .all(new Date(sinceMs).toISOString()) as unknown as { run_number: number; pipeline: string; environment: string; approval: string; outcome: string | null; created_at: string; session_id: string | null; ticket_id: string | null }[];
  return rows.map((r) => ({ runNumber: r.run_number, pipeline: r.pipeline, environment: r.environment, approval: r.approval, outcome: r.outcome, at: r.created_at, atMs: ms(r.created_at) ?? 0, sessionId: r.session_id, ticketId: r.ticket_id }));
}

/** The facts for windows back to `sinceMs` (the start of the previous window when comparing). null: the store can not be read. */
export function loadCrewFacts(store: Store, nowMs: number, sinceMs: number): CrewFacts | null {
  const db = store.db;
  if (!db) return null;
  const spend = new SpendStore(store);
  const sessions = tryRead(() => loadSessions(db, spend, sinceMs)) ?? new Map<string, SessionInfo>();
  const extra = tryRead(() => loadExtra(db, [...sessions.keys()])) ?? new Map<string, CrewSessionExtra>();
  return {
    nowMs,
    sessions,
    extra,
    tickets: tryRead(() => loadTickets(db, sinceMs)),
    runs: tryRead(() => loadRuns(db, sinceMs)),
    deploys: tryRead(() => loadDeploys(db, sinceMs)),
    usage: (fromMs: number, toMs: number, ids: ReadonlySet<string>): UsageRow[] => spend.usageRows(fromMs, toMs, { sessionIds: ids }),
    // Usage spend's ONE per-ticket function (T-449), done tickets of the window only.
    ticketCosts: (rows: UsageRow[], fromMs: number, toMs: number): TicketCostRow[] =>
      ticketReport(spend, { rows, sessions, fromMs, toMs, limit: 5000, doneOnly: true })
        .rows.filter((r) => r.state === 'known')
        .map((r) => ({ ticket: r.key, type: r.ticket?.type ?? null, ownUsd: r.own.costUsd, totalUsd: r.total.costUsd })),
  };
}
