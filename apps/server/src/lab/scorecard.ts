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

import {
  CHAT_ENDED_CREDENTIAL,
  CHAT_ENDED_INTEGRITY,
  type CrewCiRow,
  type CrewContextRow,
  type CrewCost,
  type CrewDeploy,
  type CrewEffectiveness,
  type CrewEfficiency,
  type CrewEnding,
  type CrewFigure,
  type CrewHealth,
  type CrewModelRow,
  type CrewProgramScore,
  type CrewReviewItem,
  type CrewRoleRow,
  type CrewSessionCost,
  type CrewSpike,
  type CrewTarget,
  type CrewTypeRow,
  type CrewUnavailable,
  type CrewWindowScore,
  type SpikeEvidence,
} from '@portal/contracts';
import { chainRootOf, rootOf } from '../usagespend/attribution.js';
import type { SessionInfo, UsageRow } from '../usagespend/model.js';
import { spikeSummary } from '../usagespend/spikes.js';
import { cacheReadWeight, inputPricePerToken } from './prices.js';

/* ---------- The facts the pure part reads ---------- */

/** What the scorecard needs of a session beyond usage spend's `SessionInfo`. */
export interface CrewSessionExtra {
  agent: string | null;
  model: string | null;
  maxWorkers: number | null;
  /** 1: the session may start Agent-tool sub-agents (chat_sessions.subagents). */
  subagents: boolean;
  createdAtMs: number;
  /** Tokens of the session's last turn (`chat_sessions.context_used`), null when never recorded. */
  contextUsed: number | null;
  endedReason: string | null;
  /** When the session entered its current state. */
  stateSinceMs: number | null;
}

/** One `usage_spikes` row. */
export interface CrewSpikeRow {
  atMs: number;
  kind: 'rate' | 'burst' | 'outlier';
  sessionId: string | null;
  claudeId: string;
  evidence: SpikeEvidence;
}

/** One `agent.refused` audit row. */
export interface CrewRefusal {
  atMs: number;
  sessionId: string;
  scope: string;
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
  /** Tickets with a deploy of one of their runs waiting for approval now (any age). null: not readable. */
  pendingDeployTickets: ReadonlySet<string> | null;
  /** null: usage_spikes could not be read. */
  spikes: CrewSpikeRow[] | null;
  /** null: chat_audit could not be read. */
  refusals: CrewRefusal[] | null;
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
  ticketLife: 'usage spend ticketReport (T-449) over the requests from the oldest done ticket’s creation (at most 30 days) to the window end',
  costParts: 'chat_usage tokens x the list price (lab/prices.ts; cache write at the 5-minute rate)',
  requests: 'chat_usage.requests of the program’s sessions',
  context: 'chat_sessions.context_used (the last turn) of sessions with a request in the window',
  handovers: 'chat_sessions.created_at of the lead chain’s continuations',
  spikes: 'usage_spikes (the spike detector, §24) of the program’s sessions',
  refusals: 'chat_audit agent.refused of the program’s sessions',
  endings: 'chat_sessions.ended_reason and state_since (integrity:, credential:, or interrupted by an error)',
  pod: 'not recorded by the portal (no pod memory or OOM source)',
} as const;

const CLOSED = new Set(['done', 'wont_do']);
const OPEN = new Set(['open', 'in_progress', 'blocked', 'in_review']);
const LIVE = new Set(['starting', 'idle', 'working', 'waiting', 'interrupted']);
const QA_ROLE = /qa|verif|review|ux-check/i;
/** How far back a done ticket's life is read for its cost (gap 1 of S1a). */
export const TICKET_LIFE_CAP_MS = 30 * 24 * 3_600_000;

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
    // What a review waits for, read from the portal NOW: only for the window that ends now (an older window keeps the tag alone).
    const isNow = toMs === facts.nowMs;
    const qaHolds = new Set<string>();
    if (isNow) {
      for (const s of facts.sessions.values()) if (s.exists && s.ticketId && s.state && LIVE.has(s.state) && QA_ROLE.test(facts.extra.get(s.sessionId)?.agent ?? '')) qaHolds.add(s.ticketId);
    }
    const derived = (t: CrewTicket): string | null => {
      if (!isNow) return null;
      if (facts.pendingDeployTickets?.has(t.id)) return 'deploy';
      if (qaHolds.has(t.id)) return 'qa';
      if (t.assigneeKind === 'user') return 'owner';
      return null;
    };
    const review: CrewReviewItem[] = [];
    for (const t of tickets) {
      if (t.createdAtMs >= toMs) continue;
      const s = statusAt(t, toMs - 1);
      if (s.status !== 'in_review') continue;
      const tag = t.tags.find((x) => /^waits-[a-z0-9-]{1,30}$/.test(x));
      const d = tag ? null : derived(t);
      review.push({ ticket: t.id, type: t.type, ageMs: toMs - s.sinceMs, waitsFor: tag ? tag.slice('waits-'.length) : d, waitsBasis: tag ? 'tag' : d ? 'derived' : null });
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

/**
 * Where a done ticket's life starts for its cost: the oldest creation among the program's tickets done in the window, never later than the
 * window's start and never more than `TICKET_LIFE_CAP_MS` before its end. A ticket's cost is what it took to get it done, not only the part
 * that fell in the window (S1a counted the window's requests only).
 */
export function ticketLifeFrom(tickets: readonly CrewTicket[] | null, fromMs: number, toMs: number): number {
  let oldest = fromMs;
  for (const t of tickets ?? []) if (t.status === 'done' && t.closedAtMs !== null && t.closedAtMs >= fromMs && t.closedAtMs < toMs) oldest = Math.min(oldest, t.createdAtMs);
  return Math.max(oldest, toMs - TICKET_LIFE_CAP_MS);
}

export function windowScore(p: Program, facts: CrewFacts, fromMs: number, toMs: number): { score: CrewWindowScore; rows: UsageRow[] } {
  const tickets = facts.tickets ? programTickets(p, facts.tickets, facts.sessions) : null;
  const rows = facts.usage(fromMs, toMs, p.members);
  const lifeFrom = Math.min(fromMs, ticketLifeFrom(tickets, fromMs, toMs));
  const lifeRows = lifeFrom < fromMs ? facts.usage(lifeFrom, toMs, p.members) : rows;
  const costs = facts.ticketCosts(lifeRows, fromMs, toMs);
  const eff = effectiveness(p, facts, tickets, fromMs, toMs, costs);
  return {
    score: { fromMs, toMs, effectiveness: eff, cost: cost(p, rows, facts.sessions, eff.done.value), efficiency: efficiency(p, facts, rows, fromMs, toMs), health: health(p, facts, fromMs, toMs) },
    rows,
  };
}

/* ---------- Efficiency and health ---------- */

/** A session's role: `lead` for the lead chain, else its agent, else `unrecorded`. */
export function roleOf(p: Program, id: string, extra: ReadonlyMap<string, CrewSessionExtra>): string {
  return p.leads.includes(id) ? 'lead' : extra.get(id)?.agent || 'unrecorded';
}

function contextRow(key: string, tokens: number[]): CrewContextRow {
  const s = [...tokens].sort((a, b) => a - b);
  return { key, sessions: s.length, p50: percentile(s, 0.5), p90: percentile(s, 0.9) };
}

function efficiency(p: Program, facts: CrewFacts, rows: UsageRow[], fromMs: number, toMs: number): CrewEfficiency {
  const hours = (toMs - fromMs) / 3_600_000;
  const inWin = (ms: number | null | undefined) => ms !== null && ms !== undefined && ms >= fromMs && ms < toMs;
  const role = (id: string) => roleOf(p, id, facts.extra);

  // Cost by token class at list price (rows of a model with no price are left out).
  const part = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const r of rows) {
    const price = inputPricePerToken(r.model);
    if (price === null) continue;
    part.input += r.input * price;
    part.output += 5 * r.output * price;
    part.cacheRead += cacheReadWeight(r.model) * r.cacheRead * price;
    part.cacheWrite += 1.25 * r.cacheWrite * price;
  }
  const listed = part.input + part.output + part.cacheRead + part.cacheWrite;
  const share = (x: number) => (listed > 0 ? fig(r2((x / listed) * 100), 'estimate', SRC.costParts) : none('no_samples', SRC.costParts));

  const bySession = new Map<string, { cost: number; requests: number }>();
  const mix = new Map<string, CrewModelRow>();
  let requests = 0;
  for (const r of rows) {
    const s = bySession.get(r.sessionId) ?? { cost: 0, requests: 0 };
    s.cost += r.costUsd;
    s.requests += r.requests;
    bySession.set(r.sessionId, s);
    requests += r.requests;
    if (r.model === '<synthetic>') continue;
    const key = `${role(r.sessionId)}\u0000${r.model}`;
    const m = mix.get(key) ?? { role: role(r.sessionId), model: r.model, requests: 0, costUsd: 0 };
    m.requests += r.requests;
    m.costUsd += r.costUsd;
    mix.set(key, m);
  }
  const active = [...bySession.keys()].sort();

  const ctxByRole = new Map<string, number[]>();
  for (const id of active) {
    const c = facts.extra.get(id)?.contextUsed;
    if (c === null || c === undefined) continue;
    (ctxByRole.get(role(id)) ?? ctxByRole.set(role(id), []).get(role(id))!).push(c);
  }
  const contextByLead = p.leads.map((lead) => {
    const workers = active.filter((id) => facts.sessions.get(id)?.parentId === lead && !p.leads.includes(id));
    const tokens = workers.map((id) => facts.extra.get(id)?.contextUsed).filter((c): c is number => c !== null && c !== undefined);
    return { ...contextRow(lead, tokens), leadTokens: bySession.has(lead) ? (facts.extra.get(lead)?.contextUsed ?? null) : null };
  });

  const roles = new Map<string, CrewRoleRow>();
  for (const id of active) {
    const k = role(id);
    const e = roles.get(k) ?? { role: k, sessions: 0, started: 0, requests: 0, requestsPerSession: 0 };
    e.sessions++;
    if (inWin(facts.extra.get(id)?.createdAtMs)) e.started++;
    e.requests += bySession.get(id)!.requests;
    roles.set(k, e);
  }
  for (const e of roles.values()) e.requestsPerSession = r2(e.requests / e.sessions);

  const live = new Map<string, number>();
  if (toMs === facts.nowMs) {
    for (const id of p.members) {
      const s = facts.sessions.get(id);
      if (s?.exists && s.state && LIVE.has(s.state)) live.set(s.claudeId, (live.get(s.claudeId) ?? 0) + 1);
    }
  }

  const handovers = p.leads.slice(1).filter((l) => inWin(facts.extra.get(l)?.createdAtMs)).length;

  const spikes: CrewSpike[] = [];
  for (const s of facts.spikes ?? []) {
    if (!inWin(s.atMs)) continue;
    const top = s.evidence.kind === 'rate' ? (s.evidence.topSession?.sessionId ?? null) : null;
    const session = s.sessionId && p.members.has(s.sessionId) ? s.sessionId : top && p.members.has(top) ? top : null;
    if (!session) continue;
    spikes.push({ at: new Date(s.atMs).toISOString(), kind: s.kind, session, role: role(session), claude: s.claudeId, summary: spikeSummary(s.evidence) });
  }
  spikes.sort((a, b) => a.at.localeCompare(b.at));

  return {
    costParts: { input: share(part.input), output: share(part.output), cacheRead: share(part.cacheRead), cacheWrite: share(part.cacheWrite) },
    requests: fig(requests, 'measured', SRC.requests),
    requestsPerSession: active.length ? fig(r2(requests / active.length), 'measured', SRC.requests) : none('no_samples', SRC.requests),
    contextByRole: [...ctxByRole].map(([k, v]) => contextRow(k, v)).sort((a, b) => a.key.localeCompare(b.key)),
    contextByLead,
    topSessions: active
      .map((id): CrewSessionCost => ({ session: id, role: role(id), costUsd: r6(bySession.get(id)!.cost), requests: bySession.get(id)!.requests }))
      .sort((a, b) => b.costUsd - a.costUsd || a.session.localeCompare(b.session))
      .slice(0, 5),
    modelMix: [...mix.values()].map((m) => ({ ...m, costUsd: r6(m.costUsd) })).sort((a, b) => b.costUsd - a.costUsd || a.role.localeCompare(b.role) || a.model.localeCompare(b.model)),
    roles: [...roles.values()].sort((a, b) => b.sessions - a.sessions || a.role.localeCompare(b.role)),
    liveByClaude: [...live].map(([claude, n]) => ({ claude, live: n })).sort((a, b) => b.live - a.live || a.claude.localeCompare(b.claude)),
    handovers: fig(handovers, 'measured', SRC.handovers),
    handoversPerHour: fig(r2(handovers / hours), 'measured', SRC.handovers),
    spikesCount: facts.spikes ? fig(spikes.length, 'measured', SRC.spikes) : none('no_source', SRC.spikes),
    spikes,
  };
}

function health(p: Program, facts: CrewFacts, fromMs: number, toMs: number): CrewHealth {
  const inWin = (ms: number | null | undefined) => ms !== null && ms !== undefined && ms >= fromMs && ms < toMs;
  let refusals: CrewFigure;
  const byScope = new Map<string, number>();
  if (!facts.refusals) refusals = none('no_source', SRC.refusals);
  else {
    let n = 0;
    for (const r of facts.refusals) {
      if (!inWin(r.atMs) || !p.members.has(r.sessionId)) continue;
      n++;
      byScope.set(r.scope, (byScope.get(r.scope) ?? 0) + 1);
    }
    refusals = fig(n, 'measured', SRC.refusals);
  }
  const endings: CrewEnding[] = [];
  for (const id of p.members) {
    const s = facts.sessions.get(id);
    const x = facts.extra.get(id);
    if (!s?.exists || !x?.endedReason || !inWin(x.stateSinceMs)) continue;
    const kind: CrewEnding['kind'] | null = x.endedReason.startsWith(CHAT_ENDED_INTEGRITY)
      ? 'integrity'
      : x.endedReason.startsWith(CHAT_ENDED_CREDENTIAL)
        ? 'credential'
        : s.state === 'interrupted'
          ? 'error'
          : null;
    if (kind) endings.push({ session: id, kind, at: new Date(x.stateSinceMs!).toISOString() });
  }
  endings.sort((a, b) => a.at.localeCompare(b.at) || a.session.localeCompare(b.session));
  return {
    refusals,
    refusalsByScope: [...byScope].map(([scope, count]) => ({ scope, count })).sort((a, b) => b.count - a.count || a.scope.localeCompare(b.scope)),
    badEndings: fig(endings.length, 'measured', SRC.endings),
    endings,
    podMemory: none('no_source', SRC.pod),
    oomRestarts: none('no_source', SRC.pod),
  };
}

/* ---------- Targets ---------- */

/** D-61's cap on a lead's live workers when its `max_workers` is not set (ClaudePilot and Konfersi; Event sets 2). */
export const DEFAULT_WORKER_CAP = 3;
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
  review:
    'Tickets in review at the window’s end (the status timeline replayed), age since they entered review; waits for: a waits-<what> tag, else (the window that ends now) a deploy of its runs waiting for approval, a live QA or review session holding it, or a person it is assigned to; else not recorded. MEASURED.',
  ci: 'CI runs of the program’s sessions or tickets finished in the window, by pipeline; deploys: ci_deployments of those runs. MEASURED.',
  cost: 'Dollars of the program’s requests in the window (Claude Code’s price estimate): lead = the lead chain’s own requests, workers = the rest. ESTIMATE.',
  costByType:
    'Per type: usage spend’s per-ticket dollars (ticketReport, T-449: own plus the lead’s part split over its workers’ tickets) of the done tickets over their life: the program’s requests from the oldest such ticket’s creation (at most 30 days back) to the window’s end. ESTIMATE.',
  costParts: 'Shares of the window’s dollars at list price by token class: input, output (x5), cache read (x0.1, Opus 5.5 x0.05), cache write (x1.25, the 5-minute rate). Models with no price are left out. ESTIMATE.',
  context: 'Tokens of each session’s last turn (chat_sessions.context_used) for the sessions with a request in the window, p50 and p90 by nearest rank, per role and per lead (its direct workers). MEASURED.',
  roles: 'Per role (the worker’s agent; lead; unrecorded): sessions with a request in the window, of them started in the window (churn), requests per session; model mix: requests and dollars per role and model. MEASURED (dollars ESTIMATE).',
  spread: 'Live sessions per Claude now (T-427); hand-overs: lead continuations started in the window (T-423). MEASURED.',
  spikes: 'The spike detector’s events (usage_spikes, §24) of the program’s sessions; a rate spike when the program’s session is its top one. MEASURED.',
  health: 'agent.refused audit rows; sessions ended by an integrity or credential check or interrupted by an error, in the window. Pod memory and OOM restarts: unavailable (the portal does not record them). MEASURED.',
  perDone: 'All-in: the window’s dollars over its done tickets; workers only: the workers’ dollars over them. ESTIMATE.',
  targets: 'D-61 live workers and no Agent-tool sub-agents in a lead; D-62 the owner’s queue; D-63 QA and review on sonnet. Live workers are measured now; the rest over the window.',
};
