// Crew scorecard (T-450 S1a): the loader. Reads the portal's tables into the plain facts `scorecard.ts` works on. Read only; a table this
// store does not have (or can not read) is `null`, which the scorecard shows as unavailable (no_source), never as 0.

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Store } from '../store/store.js';
import { SpendStore } from '../usagespend/store.js';
import { ticketReport } from '../usagespend/ticketReport.js';
import type { SpikeEvidence } from '@portal/contracts';
import type { SessionInfo, UsageRow } from '../usagespend/model.js';
import { programIdOf, wasteKind, type ToolResultCount, type CrewDeployRow, type CrewFacts, type CrewRefusal, type CrewRun, type CrewSessionExtra, type CrewSpikeRow, type CrewTicket, type TicketCostRow } from './scorecard.js';

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
  restoreLinks(db, spend, up);
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
      // A continuation whose link a delete cleared (restoreLinks).
      ...chunked<{ id: string }>(db, level, (l) => `SELECT session_id AS id FROM chat_audit WHERE kind = 'session.continued' AND session_id IS NOT NULL AND json_extract(detail, '$.from') IN ${l}`),
    ];
    for (const r of rows) if (!all.has(r.id)) (all.add(r.id), next.push(r.id));
    level = next;
  }
  const out = spend.sessions(all);
  restoreLinks(db, spend, out);
  return out;
}

/**
 * Gap 3 of S1a: deleting a session (chat/store.ts `deleteSession`) clears its successor's `continued_from` and its children's `parent_id`,
 * and `usage_sessions` keeps no `continued_from`. So a deleted continuation split its lead chain and its workers fell out of the program.
 * The links are put back from what outlives the delete: the `session.continued` audit row (the successor and the row it continued) and the
 * parent `usage_sessions` kept from a live child's last request. Ancestors this brings in are loaded too. Bounded; mutates `map`.
 */
export function restoreLinks(db: DatabaseSync, spend: SpendStore, map: Map<string, SessionInfo>): void {
  for (let round = 0; round < 16; round++) {
    const noCont = [...map.values()].filter((s) => !s.continuedFrom).map((s) => s.sessionId);
    const noParent = [...map.values()].filter((s) => s.exists && !s.parentId).map((s) => s.sessionId);
    const missing = new Set<string>();
    const audits = chunked<{ session_id: string; detail: string }>(db, noCont, (l) => `SELECT session_id, detail FROM chat_audit WHERE kind = 'session.continued' AND session_id IN ${l} ORDER BY id`);
    for (const a of audits) {
      let from: unknown;
      try {
        from = (JSON.parse(a.detail) as { from?: unknown }).from;
      } catch {
        continue;
      }
      const s = map.get(a.session_id);
      if (!s || s.continuedFrom || typeof from !== 'string' || !from || from === s.sessionId) continue;
      map.set(s.sessionId, { ...s, continuedFrom: from });
      if (!map.has(from)) missing.add(from);
    }
    const kept = chunked<{ session_id: string; parent_id: string }>(db, noParent, (l) => `SELECT session_id, parent_id FROM usage_sessions WHERE parent_id IS NOT NULL AND session_id IN ${l}`);
    for (const k of kept) {
      const s = map.get(k.session_id);
      if (!s || s.parentId || k.parent_id === s.sessionId) continue;
      map.set(s.sessionId, { ...s, parentId: k.parent_id });
      if (!map.has(k.parent_id)) missing.add(k.parent_id);
    }
    if (!missing.size) return;
    for (const [id, s] of spend.sessions(missing)) if (!map.has(id)) map.set(id, s);
  }
}

function loadExtra(db: DatabaseSync, ids: readonly string[]): Map<string, CrewSessionExtra> {
  const out = new Map<string, CrewSessionExtra>();
  const rows = chunked<{
    id: string;
    agent: string | null;
    model: string | null;
    max_workers: number | null;
    subagents: number;
    created_at: string;
    context_used: number | null;
    ended_reason: string | null;
    state_since: string | null;
    spawn_why: string | null;
  }>(db, ids, (l) => `SELECT id, agent, model, max_workers, subagents, created_at, context_used, ended_reason, state_since, spawn_why FROM chat_sessions WHERE id IN ${l}`);
  for (const r of rows)
    out.set(r.id, {
      agent: r.agent,
      model: r.model,
      maxWorkers: r.max_workers,
      subagents: r.subagents === 1,
      createdAtMs: ms(r.created_at) ?? 0,
      contextUsed: r.context_used,
      endedReason: r.ended_reason,
      stateSinceMs: ms(r.state_since),
      spawnWhy: r.spawn_why,
    });
  // A deleted continuation: its creation is the moment of its `session.continued` audit row (a hand-over); nothing else is known.
  const gone = ids.filter((id) => !out.has(id));
  const audits = chunked<{ session_id: string; at: string }>(db, gone, (l) => `SELECT session_id, MIN(at) AS at FROM chat_audit WHERE kind = 'session.continued' AND session_id IN ${l} GROUP BY session_id`);
  for (const a of audits) {
    const atMs = ms(a.at);
    if (atMs !== null) out.set(a.session_id, { agent: null, model: null, maxWorkers: null, subagents: false, createdAtMs: atMs, contextUsed: null, endedReason: null, stateSinceMs: null, spawnWhy: null });
  }
  return out;
}

/** Tickets with a deploy of one of their runs waiting for approval now (`pending` or `waiting`), whatever its age. */
function loadPendingDeployTickets(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(`SELECT DISTINCT r.ticket_id AS t FROM ci_deployments d JOIN ci_runs r ON r.id = d.run_id WHERE d.approval IN ('pending', 'waiting') AND r.ticket_id IS NOT NULL`)
    .all() as unknown as { t: string }[];
  return new Set(rows.map((r) => r.t));
}

function loadSpikes(db: DatabaseSync, sinceMs: number): CrewSpikeRow[] {
  const rows = db.prepare(`SELECT at_ms, kind, session_id, claude_id, evidence FROM usage_spikes WHERE at_ms >= ? ORDER BY at_ms`).all(sinceMs) as unknown as {
    at_ms: number;
    kind: CrewSpikeRow['kind'];
    session_id: string | null;
    claude_id: string;
    evidence: string;
  }[];
  const out: CrewSpikeRow[] = [];
  for (const r of rows) {
    try {
      out.push({ atMs: r.at_ms, kind: r.kind, sessionId: r.session_id, claudeId: r.claude_id, evidence: JSON.parse(r.evidence) as SpikeEvidence });
    } catch {
      // A row whose evidence does not parse is left out.
    }
  }
  return out;
}

function loadRefusals(db: DatabaseSync, sinceMs: number): CrewRefusal[] {
  const rows = db.prepare(`SELECT at, session_id, detail FROM chat_audit WHERE kind = 'agent.refused' AND session_id IS NOT NULL AND at >= ?`).all(new Date(sinceMs).toISOString()) as unknown as {
    at: string;
    session_id: string;
    detail: string | null;
  }[];
  return rows.map((r) => {
    let scope = 'unknown';
    try {
      const s = (JSON.parse(r.detail ?? '{}') as { scope?: unknown }).scope;
      if (typeof s === 'string' && /^[a-z_]{1,40}$/.test(s)) scope = s;
    } catch {
      // keep unknown
    }
    return { atMs: ms(r.at) ?? 0, sessionId: r.session_id, scope };
  });
}

/**
 * T-549 (D-65): the tool results of these sessions in [fromMs, toMs), counted per session: all of them, and the error ones by kind (a
 * permission denial, an error of a portal tool, another failure). Read from `chat_events` (kind tool_result, payload isError); the error
 * text is cut to its first 400 characters in SQL, so a long output never travels.
 */
export function loadToolResults(db: DatabaseSync, fromMs: number, toMs: number, ids: ReadonlySet<string>): ToolResultCount[] {
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();
  const by = new Map<string, ToolResultCount>();
  const of = (id: string) => by.get(id) ?? by.set(id, { sessionId: id, total: 0, denied: 0, portal: 0, failed: 0 }).get(id)!;
  const list = [...ids];
  for (const r of chunked<{ session_id: string; n: number }>(db, list, (l) => `SELECT session_id, COUNT(*) AS n FROM chat_events WHERE session_id IN ${l} AND kind = 'tool_result' AND at >= ? AND at < ? GROUP BY session_id`, [from, to])) of(r.session_id).total += r.n;
  const errors = chunked<{ session_id: string; tool: string | null; text: string | null }>(
    db,
    list,
    (l) =>
      `SELECT session_id, json_extract(payload, '$.toolName') AS tool, substr(json_extract(payload, '$.text'), 1, 400) AS text FROM chat_events WHERE session_id IN ${l} AND kind = 'tool_result' AND at >= ? AND at < ? AND json_extract(payload, '$.isError') = 1`,
    [from, to],
  );
  for (const e of errors) of(e.session_id)[wasteKind(e.tool, e.text)]++;
  return [...by.values()].filter((r) => r.total > 0).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
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
    pendingDeployTickets: tryRead(() => loadPendingDeployTickets(db)),
    spikes: tryRead(() => loadSpikes(db, sinceMs)),
    refusals: tryRead(() => loadRefusals(db, sinceMs)),
    toolResults: (fromMs: number, toMs: number, ids: ReadonlySet<string>): ToolResultCount[] | null => tryRead(() => loadToolResults(db, fromMs, toMs, ids)),
    usage: (fromMs: number, toMs: number, ids: ReadonlySet<string>): UsageRow[] => spend.usageRows(fromMs, toMs, { sessionIds: ids }),
    // Usage spend's ONE per-ticket function (T-449), done tickets of the window only.
    ticketCosts: (rows: UsageRow[], fromMs: number, toMs: number): TicketCostRow[] =>
      ticketReport(spend, { rows, sessions, fromMs, toMs, limit: 5000, doneOnly: true })
        .rows.filter((r) => r.state === 'known')
        .map((r) => ({ ticket: r.key, type: r.ticket?.type ?? null, ownUsd: r.own.costUsd, totalUsd: r.total.costUsd })),
  };
}
