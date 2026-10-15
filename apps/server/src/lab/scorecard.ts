// Crew scorecard (T-450 slice S1a, docs/prd/claude-usage.md §28.14): effectiveness, cost and the standing decisions' targets per PROGRAM
// and per WINDOW. Pure: `scorecardData.ts` loads the facts (sessions, tickets, CI, usage rows) and hands them in; the per-ticket dollars
// come from usage spend's ONE function (`ticketReport`, T-449) through `ticketCosts`, never a copy of it.
//
// - A PROGRAM is a lead's track: the top of a session's lineage (usage spend's `rootOf`: the session it continues, else its parent, up to
//   the first row of the top chat) names it; the LEAD CHAIN is that row and its continuations (`chainRootOf` is the program); every other
//   session under it, at any depth, is a WORKER. A top session that never started a worker is no program.
// - A ticket is the program's when one of its sessions holds it (`ticket_id`), is its assignee, or wrote an event on it. A ticket two
//   programs touched counts in both.
// - Every figure names its basis and source; a table the store does not have is `unavailable` (no_source); a division by nothing is
//   `unavailable` (no_samples); a fact never recorded (a worker's role) is `unavailable` (not_recorded). Never 0 in their place.

import type { CrewCiRow, CrewCost, CrewDeploy, CrewEffectiveness, CrewFigure, CrewProgramScore, CrewReviewItem, CrewTarget, CrewTypeRow, CrewUnavailable, CrewWindowScore } from '@portal/contracts';
import { chainRootOf, rootOf } from '../usagespend/attribution.js';
import type { SessionInfo, UsageRow } from '../usagespend/model.js';

/* ---------- The facts the pure part reads ---------- */

/** What the scorecard needs of a session beyond usage spend's `SessionInfo`. */
export interface CrewSessionExtra {
  agent: string | null;
  model: string | null;
  maxWorkers: number | null;
  /** 1: the session may start Agent-tool sub-agents (chat_sessions.subagents). */
  subagents: boolean;
  createdAtMs: number;
}

export interface CrewTicket {
  id: string;
  type: string;
  status: string;
  closedAtMs: number | null;
  createdAtMs: number;
  assigneeKind: 'session' | 'user' | null;
  assigneeRef: string | null;
  /** Status, close and reopen changes, oldest first. */
  changes: { atMs: number; from: string; to: string; kind: string }[];
  /** Sessions that wrote an event on it (`session:<id>` actors). */
  actors: Set<string>;
  tags: string[];
}

export interface CrewRun {
  id: string;
  number: number;
  pipeline: string;
  status: string;
  sessionId: string | null;
  ticketId: string | null;
  finishedAtMs: number | null;
}

export interface CrewDeployRow extends CrewDeploy {
  atMs: number;
  sessionId: string | null;
  ticketId: string | null;
}

export interface TicketCostRow {
  ticket: string;
  type: string | null;
  ownUsd: number;
  totalUsd: number;
}

export interface CrewFacts {
  nowMs: number;
  /** Usage spend's view of every session (live, or kept after a delete), continuations included. */
  sessions: ReadonlyMap<string, SessionInfo>;
  extra: ReadonlyMap<string, CrewSessionExtra>;
  /** null: the tickets table could not be read. */
  tickets: CrewTicket[] | null;
  /** null: ci_runs could not be read. */
  runs: CrewRun[] | null;
  /** null: ci_deployments could not be read. */
  deploys: CrewDeployRow[] | null;
  /** The requests in [fromMs, toMs) of these sessions. */
  usage(fromMs: number, toMs: number, sessionIds: ReadonlySet<string>): UsageRow[];
  /** Done-in-window tickets' dollars (usage spend's `ticketReport`, doneOnly) over these rows. */
  ticketCosts(rows: UsageRow[], fromMs: number, toMs: number): TicketCostRow[];
}

/* ---------- Programs ---------- */

export interface Program {
  id: string;
  title: string;
  leads: string[];
  members: Set<string>;
}

/** Every program: the top of each session's lineage with at least one worker under it. */
export function programsOf(sessions: ReadonlyMap<string, SessionInfo>, extra: ReadonlyMap<string, CrewSessionExtra>): Map<string, Program> {
  const byTop = new Map<string, Set<string>>();
  for (const id of sessions.keys()) {
    const top = programIdOf(id, sessions);
    if (!top) continue;
    (byTop.get(top) ?? byTop.set(top, new Set()).get(top)!).add(id);
  }
  const out = new Map<string, Program>();
  for (const [top, members] of byTop) {
    const leads = [...members].filter((m) => chainRootOf(m, sessions) === top).sort((a, b) => (extra.get(a)?.createdAtMs ?? 0) - (extra.get(b)?.createdAtMs ?? 0) || a.localeCompare(b));
    if (members.size === leads.length) continue; // no worker: a chat, not a crew
    const last = leads.at(-1) ?? top;
    out.set(top, { id: top, title: sessions.get(last)?.title || sessions.get(top)?.title || '', leads, members });
  }
  return out;
}

/** The program a session belongs to (the top of its lineage), or null when the portal has no record of it. */
export function programIdOf(sessionId: string, sessions: ReadonlyMap<string, SessionInfo>): string | null {
  const top = rootOf(sessionId, sessions).session;
  return top ? chainRootOf(top.sessionId, sessions) : null;
}

/* ---------- Figures ---------- */

const r2 = (x: number) => Math.round(x * 100) / 100;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const fig = (value: number, basis: 'measured' | 'estimate', source: string): CrewFigure => ({ value, basis, source });
const none = (reason: CrewUnavailable, source: string): CrewFigure => ({ value: null, basis: 'unavailable', source, reason });

/** Nearest-rank percentile of a sorted list (null when empty). */
export function percentile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

export const SRC = {
  tickets: 'tickets (status, closed_at, type) of the program',
  events: 'ticket_events (status, closed, reopened)',
  review: 'ticket_events replayed to the window end; waits-<what> tags',
  ci: 'ci_runs (finished in the window) of the program',
  deploys: 'ci_deployments of the program’s runs',
  cost: 'chat_usage.cost_usd (Claude Code’s price estimate)',
  ticketCost: 'usage spend ticketReport (T-449) over the window’s requests',
  sessions: 'chat_sessions (state, agent, max_workers, subagents)',
  agents: 'chat_usage.agents (Agent-tool sub-agents per turn)',
  model: 'chat_usage.model of QA and review workers (chat_sessions.agent)',
} as const;

const CLOSED = new Set(['done', 'wont_do']);
const OPEN = new Set(['open', 'in_progress', 'blocked', 'in_review']);

/** A ticket's status at `atMs`, replaying its changes (none recorded before: open). */
function statusAt(t: CrewTicket, atMs: number): { status: string; sinceMs: number } {
  let status = 'open';
  let sinceMs = t.createdAtMs;
  for (const c of t.changes) {
    if (c.atMs > atMs) break;
    status = c.to;
    sinceMs = c.atMs;
  }
  return { status, sinceMs };
}

/** The program's tickets (see the header). */
export function programTickets(p: Program, tickets: readonly CrewTicket[], sessions: ReadonlyMap<string, SessionInfo>): CrewTicket[] {
  const held = new Set<string>();
  for (const m of p.members) {
    const t = sessions.get(m)?.ticketId;
    if (t) held.add(t);
  }
  return tickets.filter((t) => held.has(t.id) || (t.assigneeKind === 'session' && !!t.assigneeRef && p.members.has(t.assigneeRef)) || [...t.actors].some((a) => p.members.has(a)));
}

/* ---------- One window ---------- */

function effectiveness(p: Program, facts: CrewFacts, tickets: CrewTicket[] | null, fromMs: number, toMs: number, costs: TicketCostRow[]): CrewEffectiveness {
  const hours = (toMs - fromMs) / 3_600_000;
  const inWin = (ms: number | null) => ms !== null && ms >= fromMs && ms < toMs;
  let base: Pick<CrewEffectiveness, 'done' | 'donePerHour' | 'reopened' | 'wontDo' | 'byType' | 'reviewBacklog' | 'review'>;
  if (!tickets) {
    const u = none('no_source', SRC.tickets);
    base = { done: u, donePerHour: u, reopened: u, wontDo: u, byType: [], reviewBacklog: none('no_source', SRC.review), review: [] };
  } else {
    const done = tickets.filter((t) => t.status === 'done' && inWin(t.closedAtMs));
    const wontDo = tickets.filter((t) => t.status === 'wont_do' && inWin(t.closedAtMs)).length;
    const reopened = tickets.filter((t) => t.changes.some((c) => inWin(c.atMs) && (c.kind === 'reopened' || (CLOSED.has(c.from) && OPEN.has(c.to))))).length;
    const costBy = new Map(costs.map((c) => [c.ticket, c]));
    const types = new Map<string, { done: CrewTicket[]; leads: number[]; noStart: number }>();
    for (const t of done) {
      const e = types.get(t.type) ?? { done: [], leads: [], noStart: 0 };
      e.done.push(t);
      const start = t.changes.find((c) => c.to === 'in_progress' && c.atMs <= t.closedAtMs!);
      if (start) e.leads.push(t.closedAtMs! - start.atMs);
      else e.noStart++;
      types.set(t.type, e);
    }
    const byType: CrewTypeRow[] = [...types]
      .map(([type, e]) => {
        const leads = [...e.leads].sort((a, b) => a - b);
        let allIn = 0;
        let own = 0;
        for (const t of e.done) {
          const c = costBy.get(t.id);
          if (c) (allIn += c.totalUsd), (own += c.ownUsd);
        }
        return {
          type,
          done: e.done.length,
          perHour: r2(e.done.length / hours),
          leadTimeP50Ms: percentile(leads, 0.5),
          leadTimeP90Ms: percentile(leads, 0.9),
          noStart: e.noStart,
          costAllInUsd: r6(allIn),
          costWorkersUsd: r6(own),
          perTicketAllInUsd: r6(allIn / e.done.length),
          perTicketWorkersUsd: r6(own / e.done.length),
        };
      })
      .sort((a, b) => b.done - a.done || a.type.localeCompare(b.type));
    const review: CrewReviewItem[] = [];
    for (const t of tickets) {
      if (t.createdAtMs >= toMs) continue;
      const s = statusAt(t, toMs - 1);
      if (s.status !== 'in_review') continue;
      const tag = t.tags.find((x) => /^waits-[a-z0-9-]{1,30}$/.test(x));
      review.push({ ticket: t.id, type: t.type, ageMs: toMs - s.sinceMs, waitsFor: tag ? tag.slice('waits-'.length) : null });
    }
    review.sort((a, b) => b.ageMs - a.ageMs || a.ticket.localeCompare(b.ticket));
    base = {
      done: fig(done.length, 'measured', SRC.tickets),
      donePerHour: fig(r2(done.length / hours), 'measured', SRC.tickets),
      reopened: fig(reopened, 'measured', SRC.events),
      wontDo: fig(wontDo, 'measured', SRC.tickets),
      byType,
      reviewBacklog: fig(review.length, 'measured', SRC.review),
      review,
    };
  }
  const ids = new Set(tickets?.map((t) => t.id) ?? []);
  const mine = (r: { sessionId: string | null; ticketId: string | null }) => (!!r.sessionId && p.members.has(r.sessionId)) || (!!r.ticketId && ids.has(r.ticketId));
  let ciRuns: CrewFigure, ci: CrewCiRow[] = [];
  if (!facts.runs) ciRuns = none('no_source', SRC.ci);
  else {
    const by = new Map<string, CrewCiRow>();
    let n = 0;
    for (const r of facts.runs) {
      if (!inWin(r.finishedAtMs) || !mine(r) || (r.status !== 'passed' && r.status !== 'failed' && r.status !== 'cancelled')) continue;
      const row = by.get(r.pipeline) ?? { pipeline: r.pipeline, passed: 0, failed: 0, cancelled: 0 };
      row[r.status as 'passed' | 'failed' | 'cancelled']++;
      by.set(r.pipeline, row);
      n++;
    }
    ci = [...by.values()].sort((a, b) => a.pipeline.localeCompare(b.pipeline));
    ciRuns = fig(n, 'measured', SRC.ci);
  }
  let deploysCount: CrewFigure, deploys: CrewDeploy[] = [];
  if (!facts.deploys) deploysCount = none('no_source', SRC.deploys);
  else {
    deploys = facts.deploys
      .filter((d) => inWin(d.atMs) && mine(d))
      .sort((a, b) => a.atMs - b.atMs)
      .map((d) => ({ runNumber: d.runNumber, pipeline: d.pipeline, environment: d.environment, approval: d.approval, outcome: d.outcome, at: d.at }));
    deploysCount = fig(deploys.length, 'measured', SRC.deploys);
  }
  return { ...base, ciRuns, ci, deploysCount, deploys };
}

function cost(p: Program, rows: UsageRow[], sessions: ReadonlyMap<string, SessionInfo>, done: number | null): CrewCost {
  let total = 0;
  let lead = 0;
  for (const r of rows) {
    const m = Math.round(r.costUsd * 1e6);
    total += m;
    if (chainRootOf(r.sessionId, sessions) === p.id) lead += m;
  }
  const workers = total - lead;
  const usd = (m: number) => fig(m / 1e6, 'estimate', SRC.cost);
  return {
    total: usd(total),
    lead: usd(lead),
    workers: usd(workers),
    leadShare: total > 0 ? fig(r2((lead / total) * 100), 'estimate', SRC.cost) : none('no_samples', SRC.cost),
    perDoneAllIn: done === null ? none('no_source', SRC.tickets) : done > 0 ? fig(r6(total / 1e6 / done), 'estimate', `${SRC.cost} / done tickets`) : none('no_samples', SRC.tickets),
    perDoneWorkers: done === null ? none('no_source', SRC.tickets) : done > 0 ? fig(r6(workers / 1e6 / done), 'estimate', `${SRC.cost} / done tickets`) : none('no_samples', SRC.tickets),
  };
}

export function windowScore(p: Program, facts: CrewFacts, fromMs: number, toMs: number): { score: CrewWindowScore; rows: UsageRow[] } {
  const tickets = facts.tickets ? programTickets(p, facts.tickets, facts.sessions) : null;
  const rows = facts.usage(fromMs, toMs, p.members);
  const costs = facts.ticketCosts(rows, fromMs, toMs);
  const eff = effectiveness(p, facts, tickets, fromMs, toMs, costs);
  return { score: { fromMs, toMs, effectiveness: eff, cost: cost(p, rows, facts.sessions, eff.done.value) }, rows };
}

/* ---------- Targets ---------- */

/** D-61's cap on a lead's live workers when its `max_workers` is not set (ClaudePilot and Konfersi; Event sets 2). */
export const DEFAULT_WORKER_CAP = 3;
const LIVE = new Set(['starting', 'idle', 'working', 'waiting', 'interrupted']);
const QA_ROLE = /qa|verif|review|ux-check/i;
/** The one ticket allowed in the owner's queue (D-62: Konfersi production). */
export const OWNER_QUEUE_ALLOWED = ['T-93'];

export function targets(p: Program, facts: CrewFacts, rows: UsageRow[]): CrewTarget[] {
  const out: CrewTarget[] = [];
  const workers = [...p.members].filter((m) => !p.leads.includes(m));
  const liveLead = [...p.leads].reverse().find((l) => facts.sessions.get(l)?.exists) ?? p.leads.at(-1)!;
  const cap = facts.extra.get(liveLead)?.maxWorkers ?? DEFAULT_WORKER_CAP;
  const live = workers.filter((w) => {
    const s = facts.sessions.get(w);
    return !!s?.exists && !!s.state && LIVE.has(s.state);
  });
  out.push({
    id: 'live_workers',
    decision: 'D-61',
    rule: `At most ${cap} live workers per lead (the lead's max_workers, else ${DEFAULT_WORKER_CAP}); measured now.`,
    state: live.length > cap ? 'breach' : 'ok',
    figure: fig(live.length, 'measured', SRC.sessions),
    offenders: live.length > cap ? live.slice(0, 20) : [],
  });

  const agentsBy = new Map<string, number>();
  for (const r of rows) if (p.leads.includes(r.sessionId) && r.agents > 0) agentsBy.set(r.sessionId, (agentsBy.get(r.sessionId) ?? 0) + r.agents);
  const agents = [...agentsBy.values()].reduce((a, b) => a + b, 0);
  const allowed = p.leads.filter((l) => facts.sessions.get(l)?.exists && facts.sessions.get(l)?.state !== 'ended' && facts.extra.get(l)?.subagents);
  out.push({
    id: 'lead_subagents',
    decision: 'D-61',
    rule: 'No Agent-tool sub-agents in a lead (warn: a live lead may still start them, subagents on).',
    state: agents > 0 ? 'breach' : allowed.length ? 'warn' : 'ok',
    figure: fig(agents, 'measured', SRC.agents),
    offenders: (agents > 0 ? [...agentsBy.keys()] : allowed).slice(0, 20),
  });

  if (!facts.tickets) out.push({ id: 'owner_queue', decision: 'D-62', rule: 'Nothing in the owner’s queue but T-93 (Konfersi production).', state: 'unavailable', figure: none('no_source', SRC.tickets), offenders: [] });
  else {
    const queue = programTickets(p, facts.tickets, facts.sessions).filter((t) => t.assigneeKind === 'user' && OPEN.has(t.status) && !OWNER_QUEUE_ALLOWED.includes(t.id));
    out.push({
      id: 'owner_queue',
      decision: 'D-62',
      rule: 'Nothing in the owner’s queue but T-93 (Konfersi production).',
      state: queue.length ? 'breach' : 'ok',
      figure: fig(queue.length, 'measured', 'tickets assigned to a person, not closed'),
      offenders: queue.map((t) => t.id).slice(0, 20),
    });
  }

  const workerRows = rows.filter((r) => !p.leads.includes(r.sessionId) && r.model !== '<synthetic>');
  const withRows = new Set(workerRows.map((r) => r.sessionId));
  const qa = [...withRows].filter((w) => QA_ROLE.test(facts.extra.get(w)?.agent ?? ''));
  const roleKnown = [...withRows].some((w) => !!facts.extra.get(w)?.agent);
  const rule = 'QA, verifier, ux-checker and reviewer workers run on sonnet.';
  if (withRows.size && !roleKnown) out.push({ id: 'qa_review_model', decision: 'D-63', rule, state: 'unavailable', figure: none('not_recorded', SRC.model), offenders: [] });
  else {
    const off = qa.filter((w) => workerRows.some((r) => r.sessionId === w && !/sonnet/i.test(r.model))).sort();
    out.push({ id: 'qa_review_model', decision: 'D-63', rule, state: off.length ? 'breach' : 'ok', figure: fig(off.length, 'measured', SRC.model), offenders: off.slice(0, 20) });
  }
  return out;
}

/* ---------- The scorecard ---------- */

export function programScore(p: Program, facts: CrewFacts, windowMs: number, compare: boolean): CrewProgramScore {
  const to = facts.nowMs;
  const cur = windowScore(p, facts, to - windowMs, to);
  return {
    program: p.id,
    title: p.title,
    leads: p.leads,
    workers: p.members.size - p.leads.length,
    current: cur.score,
    previous: compare ? windowScore(p, facts, to - 2 * windowMs, to - windowMs).score : null,
    targets: targets(p, facts, cur.rows),
  };
}

export const SCORECARD_BASIS: Record<string, string> = {
  program: 'The top of a session’s lineage (continuations, then parents) with at least one worker; the lead chain is that row and its continuations.',
  tickets: 'A program’s tickets: held by one of its sessions (ticket_id), assigned to one, or with an event written by one. MEASURED.',
  done: 'Tickets whose status is done and closed_at is in the window. MEASURED.',
  reopened: 'Tickets with a reopen (or a change from done or wont_do back to work) in the window. MEASURED.',
  leadTime: 'From the first change to in_progress to closed_at, per done ticket; p50 and p90 by nearest rank. MEASURED.',
  review: 'Tickets in review at the window’s end (the status timeline replayed), age since they entered review; waits for: a waits-<what> tag, else not recorded. MEASURED.',
  ci: 'CI runs of the program’s sessions or tickets finished in the window, by pipeline; deploys: ci_deployments of those runs. MEASURED.',
  cost: 'Dollars of the program’s requests in the window (Claude Code’s price estimate): lead = the lead chain’s own requests, workers = the rest. ESTIMATE.',
  costByType: 'Per type: usage spend’s per-ticket dollars (ticketReport, T-449: own plus the lead’s part split over its workers’ tickets) of the done tickets, over the window’s requests only. ESTIMATE.',
  perDone: 'All-in: the window’s dollars over its done tickets; workers only: the workers’ dollars over them. ESTIMATE.',
  targets: 'D-61 live workers and no Agent-tool sub-agents in a lead; D-62 the owner’s queue; D-63 QA and review on sonnet. Live workers are measured now; the rest over the window.',
};
