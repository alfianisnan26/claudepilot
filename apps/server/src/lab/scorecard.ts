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
  modelFamilyOf,
  modelInfo,
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
  type QuotaUnusedRow,
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
  /** T-490 (D-63): why its lead started it above its role's model (`chat_sessions.spawn_why`); absent or null: none given. */
  spawnWhy?: string | null;
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

/** T-549: one session's tool results in a window: all, and the ones that were a waste (`denied`, `portal`, `failed` add up to `wasted`). */
export interface ToolResultCount {
  sessionId: string;
  total: number;
  /** An error result that says a permission was denied (or never granted). */
  denied: number;
  /** An error result of one of the portal's own tools (`mcp__pilot__*`). */
  portal: number;
  /** Any other error result (a command that failed). */
  failed: number;
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
  /**
   * T-549 (D-65): the tool results (chat_events kind tool_result) in [fromMs, toMs) of these sessions, counted per session. null: the table
   * could not be read; absent: the facts carry no such reader (both are `no_source`).
   */
  toolResults?(fromMs: number, toMs: number, sessionIds: ReadonlySet<string>): ToolResultCount[] | null;
  /** T-549 (D-65): quota left unused at the resets inside the window (T-547). Absent or null: not read for this caller (`no_source`). */
  quotaUnused?: readonly QuotaUnusedRow[] | null;
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
    const leads = chainOrder(top, [...members].filter((m) => chainRootOf(m, sessions) === top), sessions, extra);
    if (members.size === leads.length) continue; // no worker: a chat, not a crew
    const last = leads.at(-1) ?? top;
    out.set(top, { id: top, title: sessions.get(last)?.title || sessions.get(top)?.title || '', leads, members });
  }
  return out;
}

/**
 * The lead chain oldest first, by its links: from the top, each next row is the one that continues the last (the older by creation when
 * two do). A deleted row has no creation time of its own, so the links decide, not the clock; a row the walk misses goes last by creation.
 */
function chainOrder(top: string, chain: string[], sessions: ReadonlyMap<string, SessionInfo>, extra: ReadonlyMap<string, CrewSessionExtra>): string[] {
  const byAge = (a: string, b: string) => (extra.get(a)?.createdAtMs ?? 0) - (extra.get(b)?.createdAtMs ?? 0) || a.localeCompare(b);
  const left = new Set(chain);
  const out: string[] = [];
  for (let cur: string | undefined = left.has(top) ? top : undefined; cur; ) {
    out.push(cur);
    left.delete(cur);
    const from = cur;
    cur = [...left].filter((id) => sessions.get(id)?.continuedFrom === from).sort(byAge)[0];
  }
  return [...out, ...[...left].sort(byAge)];
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
  model: 'chat_usage.model of QA and review workers (chat_sessions.agent); a worker started with a why (chat_sessions.spawn_why) is not an offender',
  qaReviewOpus: 'chat_usage.model (opus or fable) of QA and review workers (chat_sessions.agent) with a request in the window; why: chat_sessions.spawn_why',
  ticketLife: 'usage spend ticketReport (T-449) over the requests from the oldest done ticket’s creation (at most 30 days) to the window end',
  costParts: 'chat_usage tokens x the list price (lab/prices.ts; cache write at the 5-minute rate)',
  requests: 'chat_usage.requests of the program’s sessions',
  context: 'chat_sessions.context_used (the last turn) of sessions with a request in the window',
  handovers: 'chat_sessions.created_at of the lead chain’s continuations',
  spikes: 'usage_spikes (the spike detector, §24) of the program’s sessions',
  refusals: 'chat_audit agent.refused of the program’s sessions',
  endings: 'chat_sessions.ended_reason and state_since (integrity:, credential:, or interrupted by an error)',
  pod: 'not recorded by the portal (no pod memory or OOM source)',
  doneRate: 'tickets (type feature or task, status done, closed_at in the window) of the program, scaled to a day; baseline: D-65',
  quotaUnused: 'claude_usage_samples (T-547): per Claude and plan window, 100 minus the percent used in the last reading before each reset in the window',
  toolResults: 'chat_events (kind tool_result, is_error) of the program’s sessions in the window / all their tool results',
} as const;

const CLOSED = new Set(['done', 'wont_do']);
const OPEN = new Set(['open', 'in_progress', 'blocked', 'in_review']);
const LIVE = new Set(['starting', 'idle', 'working', 'waiting', 'interrupted']);
const QA_ROLE = /qa|verif|review|ux-check/i;
/** T-490 (D-63): a model of the opus family or above (fable), by the catalogue's rank. */
const isOpusOrAbove = (model: string) => (modelInfo(modelFamilyOf(model))?.rank ?? 0) >= modelInfo('opus')!.rank;
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

export function windowScore(p: Program, facts: CrewFacts, fromMs: number, toMs: number): { score: CrewWindowScore; rows: UsageRow[]; costs: TicketCostRow[] } {
  const tickets = facts.tickets ? programTickets(p, facts.tickets, facts.sessions) : null;
  const rows = facts.usage(fromMs, toMs, p.members);
  const lifeFrom = Math.min(fromMs, ticketLifeFrom(tickets, fromMs, toMs));
  const lifeRows = lifeFrom < fromMs ? facts.usage(lifeFrom, toMs, p.members) : rows;
  const costs = facts.ticketCosts(lifeRows, fromMs, toMs);
  const eff = effectiveness(p, facts, tickets, fromMs, toMs, costs);
  return {
    score: { fromMs, toMs, effectiveness: eff, cost: cost(p, rows, facts.sessions, eff.done.value), efficiency: efficiency(p, facts, rows, fromMs, toMs), health: health(p, facts, fromMs, toMs) },
    rows,
    costs,
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

/** T-490, T-549: the QA and review workers with a request in `rows`, and those with a request on opus or fable. */
function qaOpusSets(p: Program, facts: CrewFacts, rows: UsageRow[]): { qaWorkers: string[]; onOpus: string[] } {
  const active = [...new Set(rows.map((r) => r.sessionId))].sort();
  const qaWorkers = active.filter((id) => !p.leads.includes(id) && QA_ROLE.test(facts.extra.get(id)?.agent ?? '') && rows.some((r) => r.sessionId === id && r.model !== '<synthetic>'));
  return { qaWorkers, onOpus: qaWorkers.filter((id) => rows.some((r) => r.sessionId === id && isOpusOrAbove(r.model))) };
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

  // T-490 (D-63): the QA and review workers active in the window, and those on opus or fable (any request).
  const { qaWorkers, onOpus } = qaOpusSets(p, facts, rows);
  const qaReviewOpus = {
    sessions: qaWorkers.length,
    opus: onOpus.length,
    opusWithWhy: onOpus.filter((id) => !!facts.extra.get(id)?.spawnWhy).length,
    share: qaWorkers.length ? fig(r2((onOpus.length / qaWorkers.length) * 100), 'measured', SRC.qaReviewOpus) : none('no_samples', SRC.qaReviewOpus),
  };

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
    qaReviewOpus,
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

export function targets(p: Program, facts: CrewFacts, rows: UsageRow[], win?: D65Window): CrewTarget[] {
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
  const rule = 'QA, verifier, ux-checker and reviewer workers run on sonnet, unless started with a why (T-490).';
  if (withRows.size && !roleKnown) out.push({ id: 'qa_review_model', decision: 'D-63', rule, state: 'unavailable', figure: none('not_recorded', SRC.model), offenders: [] });
  else {
    // T-490: a worker its lead started above sonnet with a reason (`session_spawn` why) is D-63's allowed exception, not an offender.
    const off = qa.filter((w) => !facts.extra.get(w)?.spawnWhy && workerRows.some((r) => r.sessionId === w && !/sonnet/i.test(r.model))).sort();
    out.push({ id: 'qa_review_model', decision: 'D-63', rule, state: off.length ? 'breach' : 'ok', figure: fig(off.length, 'measured', SRC.model), offenders: off.slice(0, 20) });
  }
  if (win) out.push(...d65Targets(p, facts, rows, win));
  return out;
}

/* ---------- D-65 (T-549) ---------- */

/** D-65's targets (owner, 2026-10-15) and this page's warn margin (a default of the page, not of the decision). */
export const D65 = {
  costPerDoneUsd: 8,
  leadSharePct: 30,
  qaOpusPct: 10,
  unusedPct: 30,
  wastedPct: 3,
  /** Warn from this fraction of a ceiling up to it (breach at or above the ceiling). */
  warnFrac: 0.8,
  /** Feature and task tickets done a day at the baseline (scorecard T-450, 24 h to 2026-10-15 11:00 UTC; all ticket types), by the lead's workspace name. */
  doneBaselines: [
    // By exact workspace id, never a pattern on the name (a pattern on "event" gave kubernetes/kohi-event the Event program's 12).
    // Source of the numbers: D-65 baseline (docs/dev-sessions/DECISIONS.md). The Event program left pilot (D-67), so it has no row.
    // kubernetes/kohi-event is ClaudePilot's own workspace (deploy pipeline and continuation tests: PILOT_WORKSPACE, WORKSPACE): D-65's 48.
    { workspace: 'kubernetes/kohi-event', perDay: 48 },
    // kubernetes/konfersi is Konfersi's workspace (chat/lineage.test.ts): D-65's 47.
    { workspace: 'kubernetes/konfersi', perDay: 47 },
  ],
  /** From the baseline down to this fraction of it is a warn; below it a breach. */
  doneBreachFrac: 0.5,
} as const;

const DENIED = /permission (to use .* )?(has been |was )?denied|permission denied|haven.t granted|requested permissions? to use|doesn.t want to proceed|denied by|not allowed to use|blocked by (a )?(deny|policy)/i;

/** Classifies an error tool result: a permission denial, an error of a portal tool, or another failure. */
export function wasteKind(toolName: string | null, text: string | null): 'denied' | 'portal' | 'failed' {
  if (DENIED.test((text ?? '').slice(0, 400))) return 'denied';
  return toolName !== null && toolName.startsWith('mcp__pilot__') ? 'portal' : 'failed';
}

/** A ceiling target: breach at or above it, warn from `warnFrac` of it. */
const ceilingState = (v: number, ceiling: number) => (v >= ceiling ? 'breach' : v >= ceiling * D65.warnFrac ? 'warn' : 'ok');

export interface D65Window {
  fromMs: number;
  toMs: number;
  /** The done tickets' dollars over their life (usage spend's ticketReport), for the offenders of the cost row. */
  costs: TicketCostRow[];
}

export function d65Targets(p: Program, facts: CrewFacts, rows: UsageRow[], win: D65Window): CrewTarget[] {
  const out: CrewTarget[] = [];
  const unavailable = (id: CrewTarget['id'], rule: string, reason: CrewUnavailable, source: string): CrewTarget => ({ id, decision: 'D-65', rule, state: 'unavailable', figure: none(reason, source), offenders: [] });
  const inWin = (ms: number | null) => ms !== null && ms >= win.fromMs && ms < win.toMs;
  const tickets = facts.tickets ? programTickets(p, facts.tickets, facts.sessions) : null;
  const done = tickets ? tickets.filter((t) => t.status === 'done' && inWin(t.closedAtMs)) : null;
  const c = cost(p, rows, facts.sessions, done ? done.length : null);

  // 1. All-in cost per done ticket under 8 USD.
  const ruleCost = `All-in cost per done ticket under ${D65.costPerDoneUsd} USD (lead included).`;
  if (c.perDoneAllIn.value === null) out.push(unavailable('cost_per_done', ruleCost, c.perDoneAllIn.reason ?? 'no_source', c.perDoneAllIn.source));
  else {
    const over = win.costs.filter((t) => t.totalUsd >= D65.costPerDoneUsd).sort((a, b) => b.totalUsd - a.totalUsd || a.ticket.localeCompare(b.ticket));
    out.push({ id: 'cost_per_done', decision: 'D-65', rule: ruleCost, state: ceilingState(c.perDoneAllIn.value, D65.costPerDoneUsd), figure: c.perDoneAllIn, offenders: over.map((t) => t.ticket).slice(0, 20) });
  }

  // 2. Lead share of cost under 30 percent.
  const ruleLead = `The lead chain’s share of the program’s cost under ${D65.leadSharePct} percent.`;
  if (c.leadShare.value === null) out.push(unavailable('lead_share', ruleLead, c.leadShare.reason ?? 'no_source', c.leadShare.source));
  else out.push({ id: 'lead_share', decision: 'D-65', rule: ruleLead, state: ceilingState(c.leadShare.value, D65.leadSharePct), figure: c.leadShare, offenders: c.leadShare.value >= D65.leadSharePct * D65.warnFrac ? p.leads.slice(0, 20) : [] });

  // 3. QA and review sessions on opus under 10 percent (a why does not exempt: D-65 measures the share).
  const ruleQa = `QA and review sessions on opus under ${D65.qaOpusPct} percent of them.`;
  const { qaWorkers, onOpus } = qaOpusSets(p, facts, rows);
  if (!qaWorkers.length) out.push(unavailable('qa_opus_share', ruleQa, 'no_samples', SRC.qaReviewOpus));
  else {
    const share = r2((onOpus.length / qaWorkers.length) * 100);
    out.push({ id: 'qa_opus_share', decision: 'D-65', rule: ruleQa, state: ceilingState(share, D65.qaOpusPct), figure: fig(share, 'measured', SRC.qaReviewOpus), offenders: onOpus.slice(0, 20) });
  }

  // 4. Feature and task tickets done a day, against the baseline.
  const ruleDone = 'Feature and task tickets done a day at or above the 2026-10-15 baseline (48 / 47 a day, all types: ClaudePilot / Konfersi).';
  const wsName = facts.sessions.get(p.id)?.workspaceId ?? '';
  const base = D65.doneBaselines.find((b) => b.workspace === wsName);
  if (!done) out.push(unavailable('done_rate', ruleDone, 'no_source', SRC.tickets));
  else if (!base) out.push(unavailable('done_rate', ruleDone, 'not_recorded', `${SRC.doneRate}; no baseline for workspace ${wsName || 'unknown'}`));
  else {
    const days = (win.toMs - win.fromMs) / 86_400_000;
    const perDay = r2(done.filter((t) => t.type === 'feature' || t.type === 'task').length / days);
    out.push({
      id: 'done_rate',
      decision: 'D-65',
      rule: ruleDone,
      state: perDay >= base.perDay ? 'ok' : perDay >= base.perDay * D65.doneBreachFrac ? 'warn' : 'breach',
      figure: fig(perDay, 'measured', `${SRC.doneRate} (${base.perDay} a day)`),
      offenders: [],
    });
  }

  // 5. Quota left unused at a window's reset: no Claude over 30 percent (whole portal; the work-queued condition is not measured).
  const ruleQuota = `No Claude ends a quota window with more than ${D65.unusedPct} percent unused (whole portal; “work queued” is not measured).`;
  if (facts.quotaUnused === undefined || facts.quotaUnused === null) out.push(unavailable('quota_unused', ruleQuota, 'no_source', SRC.quotaUnused));
  else {
    const known = facts.quotaUnused.filter((r) => r.unusedPct.value !== null);
    if (!known.length) out.push(unavailable('quota_unused', ruleQuota, 'no_samples', SRC.quotaUnused));
    else {
      const worst = Math.max(...known.map((r) => r.unusedPct.value!));
      const offenders = [...new Set(known.filter((r) => r.unusedPct.value! >= D65.unusedPct * D65.warnFrac).sort((a, b) => b.unusedPct.value! - a.unusedPct.value!).map((r) => r.claudeId))];
      out.push({ id: 'quota_unused', decision: 'D-65', rule: ruleQuota, state: worst > D65.unusedPct ? 'breach' : worst >= D65.unusedPct * D65.warnFrac ? 'warn' : 'ok', figure: fig(r2(worst), 'measured', SRC.quotaUnused), offenders: offenders.slice(0, 20) });
    }
  }

  // 6. Wasted tool calls (comment 4802): error results (a permission denial, a portal error, a failed command) over all tool results, under 3 percent.
  const ruleWaste = `Wasted tool calls (a permission denial, a portal error or a failed command) under ${D65.wastedPct} percent of tool results.`;
  const counts = facts.toolResults ? facts.toolResults(win.fromMs, win.toMs, p.members) : null;
  if (!counts) out.push(unavailable('wasted_tool_calls', ruleWaste, 'no_source', SRC.toolResults));
  else {
    const total = counts.reduce((n, r) => n + r.total, 0);
    if (!total) out.push(unavailable('wasted_tool_calls', ruleWaste, 'no_samples', SRC.toolResults));
    else {
      const wasted = (r: ToolResultCount) => r.denied + r.portal + r.failed;
      const pct = r2((counts.reduce((n, r) => n + wasted(r), 0) / total) * 100);
      const offenders = counts.filter((r) => wasted(r) > 0).sort((a, b) => wasted(b) - wasted(a) || a.sessionId.localeCompare(b.sessionId)).map((r) => r.sessionId);
      out.push({ id: 'wasted_tool_calls', decision: 'D-65', rule: ruleWaste, state: ceilingState(pct, D65.wastedPct), figure: fig(pct, 'measured', SRC.toolResults), offenders: (pct >= D65.wastedPct * D65.warnFrac ? offenders : []).slice(0, 20) });
    }
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
    workspaceId: facts.sessions.get(p.id)?.workspaceId || null,
    leads: p.leads,
    workers: p.members.size - p.leads.length,
    current: cur.score,
    previous: compare ? windowScore(p, facts, to - 2 * windowMs, to - windowMs).score : null,
    targets: targets(p, facts, cur.rows, { fromMs: to - windowMs, toMs: to, costs: cur.costs }),
  };
}

export const SCORECARD_BASIS: Record<string, string> = {
  program: 'The top of a session’s lineage (continuations, then parents) with at least one worker; the lead chain is that row and its continuations.',
  quotaUnused: 'Quota left unused at reset (T-547): per Claude and plan window, 100 minus the percent used in the last usage reading taken within 30 minutes before the reset. No such reading: unavailable. MEASURED.',
  tickets: 'A program’s tickets:held by one of its sessions (ticket_id), assigned to one, or with an event written by one. MEASURED.',
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
  qaReviewOpus:
    'D-63 (T-490): of the QA, verifier, ux-check and review workers (their role) with a request in the window, the share with a request on opus or fable; how many of those were started with a why (session_spawn). Unavailable with no such worker. MEASURED.',
  pace: 'T-600 headline: sum of usedPct over sum of evenPct of the 5-hour session window of every Claude on its own plan that is signed in and has a pace (claudeusage WindowPace); 1 spends the quota exactly by its reset. Under 10 points of even pace in all: windows_just_reset; no such Claude: no_claude; an agent’s read: no_source (quota is not a program’s). ESTIMATE.',
  unusedAtReset: 'T-600 headline: with the pace under 0.9, 100 minus the mean projectedPct at reset of those Claudes. ESTIMATE.',
  usage: 'T-600 headline: requests and estimated dollars of the programs’ sessions in the window, per hour. Requests MEASURED, dollars ESTIMATE.',
  resolved: 'T-600 headline: tickets of the programs done (won’t-do apart) with closed_at in the window; a ticket two programs touched counts once globally and once in each program. MEASURED.',
  perResolved: 'T-600 headline: the window’s dollars over its resolved tickets; unavailable (no_samples) with none. ESTIMATE.',
  createdPerClosed: 'T-600 headline: tickets created in the window over tickets closed (done plus won’t-do) in it; under 1 the backlog shrinks; unavailable (no_samples) with none closed. MEASURED.',
  targets: 'D-61 live workers and no Agent-tool sub-agents in a lead; D-62 the owner’s queue; D-63 QA and review on sonnet (a worker started with a why is not an offender). Live workers are measured now; the rest over the window.',
  d65: 'D-65 (T-549): cost per done under 8 USD, lead share under 30 %, QA on opus under 10 %, feature and task done a day over the 48 / 47 baseline, no quota over 30 % unused at reset, wasted tool calls (error results) under 3 %. Warn from 80 % of a ceiling.',
};
