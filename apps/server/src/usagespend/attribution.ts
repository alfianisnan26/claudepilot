// Usage spend: who spent what (docs/prd/claude-usage.md §22). The window's requests, grouped by session (a tree: a session's total
// includes the sessions it started), workspace, ticket, persona or Claude. Pure: the store loads the rows, the sessions and the persona
// records; this adds them up.
//
// Rules that keep it honest (round 4 plan, P1):
// - Every request is in exactly one row per dimension, so the rows add up to the window's total (by session: the roots).
// - A fact the portal never recorded is `unknown` with a reason, never guessed and never zero: a persona before launches were recorded
//   (`not_recorded`), the ticket of a session deleted before its links were kept (`session_deleted`).
// - A session's own requests already hold its sub-agents (they run inside the request); children are other sessions (`parent_id`).
// - A chat continued as a new row (`continued_from`, T-136 lineage) is one unit (T-312): each later row is a child of the chain's first row, so
//   that row's total is the chain's and every segment stays visible; a ticket is the nearest one up the chain.
//
// Open to one more dimension (PLAN-12: `by=user`, usage per user): each flat dimension is one entry of `GROUPERS`, a function of the request and the
// session that made it, so a new `by` is one entry (the compiler asks for it as soon as the union grows). The roll-up of a child into its parent lives in
// ONE place, `lineage` (the session, then each parent as far as it is known): a ticket takes the nearest ancestor's, the tree takes the whole chain, and a
// user will take the creator (`creatorOf`, the owner today) of the ROOT. A fact the portal does not have is an `unattributed` row with a reason code:
// the requests keep their real totals and the row says why it cannot be named; the page never shows a 0 for an unknown person, ticket or persona.

import {
  estimatedFigure,
  unavailableFigure,
  type AttributionBy,
  type AttributionRow,
  type ChatUsageTotals,
  type SessionFacts,
  type SpendFigure,
  type SpendReason,
  type TicketTypeCost,
} from '@portal/contracts';
import { apportionLeads } from './ticketCost.js';
import { addRow, addTotals, byCostDesc, roundUsd, zeroTotals, type PersonaRecord, type SessionInfo, type UsageRow } from './model.js';

export interface AttributionInput {
  by: AttributionBy;
  rows: UsageRow[];
  /** Every session that has rows and every ancestor of one that is still known (live, or kept from its last request). */
  sessions: ReadonlyMap<string, SessionInfo>;
  /** Per session, oldest record first. */
  personas: ReadonlyMap<string, readonly PersonaRecord[]>;
  claudeName(claudeId: string, workspaceId: string): string;
  /** The persona's name now, else the one recorded. */
  personaName(poolId: string, recorded: string | null): string;
  /** Root rows of `session` and rows of the other dimensions shown; the rest sum into one `others` row. */
  limit: number;
  /** A dimension this report knows beyond `GROUPERS` (or instead of one): where `by=user` plugs in. Not used by the portal today. */
  groupers?: Readonly<Record<string, GrouperFactory>>;
  /** By ticket (T-449): a ticket's type, status and when it was closed as done (ms), or null when it is not known. */
  ticketFacts?(ticketId: string): { type: string; status: string; doneAtMs: number | null } | null;
  /** By ticket: the window, for "done in the window". */
  window?: { fromMs: number; toMs: number };
  /** By ticket: only tickets closed as done inside `window`. */
  doneOnly?: boolean;
}

export interface Attribution {
  totals: ChatUsageTotals;
  /** The side questions' part of `totals` (rows with `kind = 'side'`); they are inside every row too. */
  side: ChatUsageTotals;
  rows: AttributionRow[];
  coverage: SpendFigure;
  more: number;
  /** By ticket: the done-in-window tickets' dollars by type (needs `ticketFacts` and `window`). */
  doneByType?: TicketTypeCost[];
}

/** The part of a workspace id (`<target>/<name>`) a person calls it by. */
export const workspaceNameOf = (workspaceId: string): string => workspaceId.split('/').pop() || workspaceId;

const pct = (v: number): number => Math.round(v * 100) / 100;

/** `total` dollars as a percent of the window's: an estimate (dollars are), unavailable when there is nothing to divide by. */
export function shareOf(total: ChatUsageTotals, grand: ChatUsageTotals): SpendFigure {
  if (grand.requests === 0) return unavailableFigure('no_samples');
  if (!(grand.costUsd > 0)) return { value: null, basis: 'unavailable', reason: 'no_cost' };
  return estimatedFigure(pct((total.costUsd / grand.costUsd) * 100));
}

function clean(t: ChatUsageTotals): ChatUsageTotals {
  return { ...t, costUsd: roundUsd(t.costUsd) };
}

interface Acc {
  totals: ChatUsageTotals;
  sessions: Set<string>;
  first: number;
  last: number;
  /** The dollars as the sum of each request in millionths: what a lead's apportioned part is taken from exactly. */
  micro: number;
}

const acc = (): Acc => ({ totals: zeroTotals(), sessions: new Set(), first: Infinity, last: -Infinity, micro: 0 });

function take(a: Acc, r: UsageRow): void {
  a.micro += Math.round(r.costUsd * 1e6);
  addRow(a.totals, r);
  a.sessions.add(r.sessionId);
  if (r.atMs < a.first) a.first = r.atMs;
  if (r.atMs > a.last) a.last = r.atMs;
}

const iso = (ms: number): string | null => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** The newest persona record at or before `atMs`, or undefined when the session has none that old. */
function personaAt(records: readonly PersonaRecord[] | undefined, atMs: number): PersonaRecord | undefined {
  if (!records) return undefined;
  let found: PersonaRecord | undefined;
  for (const r of records) {
    if (r.atMs <= atMs) found = r;
    else break;
  }
  return found;
}

/** What a request is grouped under: a real value, recorded as having none, or not known (with the reason). */
export type Cell = { state: 'known' | 'none' | 'unknown'; key: string; label: string; reason?: SpendReason };

/** How an unattributed row is named, by why it is. A new reason (`pre_multiuser`, for requests from before users existed) is one line here. */
const UNATTRIBUTED_LABEL: Partial<Record<SpendReason, string>> = { not_recorded: 'Not recorded', session_deleted: 'Unknown' };

/** The group of requests whose attribution is not known: they keep their real totals; the row says why, and is never a 0. */
export const unattributed = (reason: SpendReason): Cell => ({ state: 'unknown', key: '', label: UNATTRIBUTED_LABEL[reason] ?? 'Unknown', reason });

/**
 * The one step up from a session: the session it continues when the portal knows it (T-312: a chat continued as a new row is one unit with the
 * rows before it), else its parent. A continuation whose predecessor is not known falls back to its parent, so a lost link never hides a known one.
 */
function upOf(s: SessionInfo, sessions: ReadonlyMap<string, SessionInfo>): string | null {
  const c = s.continuedFrom;
  return c && c !== s.sessionId && sessions.has(c) ? c : s.parentId;
}

/**
 * The first row of the `continued_from` chain a session is part of (the session itself when it continues nothing known). Bounded and cycle safe:
 * on a cycle it stops at the last session before the repeat.
 */
export function chainRootOf(id: string, sessions: ReadonlyMap<string, SessionInfo>): string {
  const seen = new Set<string>([id]);
  let cur = id;
  for (let hops = 0; hops < 64; hops++) {
    const c = sessions.get(cur)?.continuedFrom;
    if (!c || seen.has(c) || !sessions.has(c)) break;
    seen.add(c);
    cur = c;
  }
  return cur;
}

/**
 * The rows of a session's `continued_from` chain that `sessions` holds (`chainRootOf` of each is the session's own root), the session itself
 * always among them. With the map `SpendStore.sessions` loads for one session (it and what it continues) these are the session and the rows
 * before it: the unit a spike and the lab read a continued chat as (T-312).
 */
export function chainOf(id: string, sessions: ReadonlyMap<string, SessionInfo>): string[] {
  const root = chainRootOf(id, sessions);
  const out = [...sessions.keys()].filter((k) => k !== id && chainRootOf(k, sessions) === root);
  return [id, ...out];
}

/**
 * A session and then each step up (the session it continues, else its parent; `upOf`), as far as the portal knows them: the one place a child or a
 * continuation rolls up. `broken` is true when the walk stopped at a session the portal has no record of (deleted before its links were kept), or
 * at a cycle of links, rather than at a root.
 */
export function lineage(id: string, sessions: ReadonlyMap<string, SessionInfo>): { sessions: SessionInfo[]; broken: boolean } {
  const chain: SessionInfo[] = [];
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur) {
    if (seen.has(cur) || chain.length >= 64) return { sessions: chain, broken: true };
    seen.add(cur);
    const s = sessions.get(cur);
    if (!s) return { sessions: chain, broken: true };
    chain.push(s);
    cur = upOf(s, sessions);
  }
  return { sessions: chain, broken: false };
}

/** The top of a session's lineage (null when the session itself is not known). With `broken`, it is the topmost session still known, not the true root. */
export function rootOf(id: string, sessions: ReadonlyMap<string, SessionInfo>): { session: SessionInfo | null; broken: boolean } {
  const l = lineage(id, sessions);
  return { session: l.sessions.at(-1) ?? null, broken: l.broken };
}

/** A session's ticket: its own, else the nearest ancestor's (a helper's cost belongs to the work that started it). */
function ticketOf(id: string, sessions: ReadonlyMap<string, SessionInfo>): Cell {
  const { sessions: chain, broken } = lineage(id, sessions);
  const own = chain.find((s) => s.ticketId);
  if (own) return { state: 'known', key: own.ticketId!, label: own.ticketId! };
  // Neither the session nor an ancestor is known any more: its links were not kept, so its ticket is not known.
  return broken ? unattributed('session_deleted') : { state: 'none', key: '', label: 'No ticket' };
}

/** Builds, for one report, the function that names a request's group (so a grouper can keep per-session work for the report's length). */
export type GrouperFactory = (input: AttributionInput) => (r: UsageRow) => Cell;

/** The flat dimensions. Typed by the union of `by` less `session` (the tree): a new `by` does not compile until it has its entry here. */
const GROUPERS = {
  workspace: () => (r) => ({ state: 'known', key: r.workspaceId, label: workspaceNameOf(r.workspaceId) }),
  claude: (input) => (r) => ({ state: 'known', key: r.claudeId, label: input.claudeName(r.claudeId, r.workspaceId) }),
  ticket: (input) => {
    const memo = new Map<string, Cell>();
    return (r) => {
      let c = memo.get(r.sessionId);
      if (!c) memo.set(r.sessionId, (c = ticketOf(r.sessionId, input.sessions)));
      return c;
    };
  },
  persona: (input) => (r) => {
    const rec = personaAt(input.personas.get(r.sessionId), r.atMs);
    if (!rec) return unattributed('not_recorded');
    if (rec.personaId === null) return { state: 'none', key: '', label: 'No persona' };
    return { state: 'known', key: rec.personaId, label: input.personaName(rec.personaId, rec.name) };
  },
} satisfies Record<Exclude<AttributionBy, 'session'>, GrouperFactory>;

function groups(input: AttributionInput, grand: ChatUsageTotals): { rows: AttributionRow[]; coverage: SpendFigure; more: number; doneByType?: TicketTypeCost[] } {
  const make = input.groupers?.[input.by] ?? (GROUPERS as Record<string, GrouperFactory>)[input.by];
  if (!make) throw new Error(`no way to group by ${input.by}`);
  const cellOf = make(input);
  const map = new Map<string, { cell: Cell; acc: Acc }>();
  const entry = (cell: Cell) => {
    const id = `${cell.state}\u0000${cell.key}`;
    let g = map.get(id);
    if (!g) map.set(id, (g = { cell, acc: acc() }));
    return g;
  };
  for (const r of input.rows) take(entry(cellOf(r)).acc, r);

  // By ticket (T-449): leads' dollars move from "No ticket" to the tickets their workers are on (ticketCost.ts), in millionths so they add up exactly.
  const byTicket = input.by === 'ticket' && !input.groupers?.ticket;
  const via = new Map<string, { micro: number; workers: number }>();
  if (byTicket) {
    const memo = new Map<string, Cell>();
    const ticketCell = (id: string): Cell => memo.get(id) ?? (memo.set(id, ticketOf(id, input.sessions)), memo.get(id)!);
    const lead = apportionLeads({
      rows: input.rows,
      sessions: input.sessions,
      ticketOf: ticketCell,
      chainRootOf: (id) => chainRootOf(id, input.sessions),
      lineage: (id) => lineage(id, input.sessions).sessions,
    });
    for (const p of lead.parts.values()) {
      via.set(p.ticket, { micro: p.micro, workers: p.workers });
      entry({ state: 'known', key: p.ticket, label: p.ticket });
    }
    const none = map.get('none\u0000');
    if (none && lead.micro > 0) {
      none.acc.micro -= lead.micro;
      none.acc.totals.costUsd = none.acc.micro / 1e6;
    }
  }
  const doneIn = (id: string): boolean => {
    const f = input.ticketFacts?.(id);
    const w = input.window;
    return !!f && f.status === 'done' && f.doneAtMs !== null && !!w && f.doneAtMs >= w.fromMs && f.doneAtMs < w.toMs;
  };
  const row = (cell: Cell, a: Acc): AttributionRow => {
    const own = clean(a.totals);
    const v = byTicket && cell.state === 'known' ? via.get(cell.key) : undefined;
    const total = v ? clean({ ...a.totals, costUsd: (a.micro + v.micro) / 1e6 }) : own;
    const f = byTicket && cell.state === 'known' ? input.ticketFacts?.(cell.key) : undefined;
    return {
      by: input.by,
      key: cell.key,
      label: cell.label,
      state: cell.state,
      ...(cell.reason ? { reason: cell.reason } : {}),
      own,
      total,
      share: shareOf(total, grand),
      sessions: a.sessions.size,
      firstAt: iso(a.first),
      lastAt: iso(a.last),
      ...(byTicket && cell.state === 'known'
        ? { ticket: { type: f?.type ?? null, status: f?.status ?? null, doneAt: f && f.status === 'done' && f.doneAtMs !== null ? new Date(f.doneAtMs).toISOString() : null, viaLeadUsd: (v?.micro ?? 0) / 1e6, viaLeadWorkers: v?.workers ?? 0 } }
        : {}),
    };
  };
  const all = [...map.values()].filter((g) => g.cell.state === 'known').map((g) => row(g.cell, g.acc));
  all.sort(byCostDesc);
  let doneByType: TicketTypeCost[] | undefined;
  if (byTicket && input.ticketFacts && input.window) {
    const types = new Map<string, { tickets: number; micro: number }>();
    for (const r of all) {
      if (!doneIn(r.key)) continue;
      const t = r.ticket?.type ?? 'unknown';
      const e = types.get(t) ?? { tickets: 0, micro: 0 };
      e.tickets++;
      e.micro += Math.round(r.total.costUsd * 1e6);
      types.set(t, e);
    }
    doneByType = [...types]
      .map(([type, e]) => ({ type, tickets: e.tickets, costUsd: e.micro / 1e6, perTicketUsd: roundUsd(e.micro / 1e6 / e.tickets) }))
      .sort((a, b) => b.costUsd - a.costUsd || a.type.localeCompare(b.type));
  }
  const done = byTicket && !!input.doneOnly;
  const known = done ? all.filter((r) => doneIn(r.key)) : all;
  const shown = known.slice(0, input.limit);
  const rows = [...shown];
  const rest = known.slice(input.limit);
  if (rest.length) {
    const sum = zeroTotals();
    const sessions = new Set<string>();
    const keys = new Set(rest.map((x) => x.key));
    for (const g of map.values()) {
      if (g.cell.state !== 'known' || !keys.has(g.cell.key)) continue;
      addTotals(sum, g.acc.totals);
      sum.costUsd += (via.get(g.cell.key)?.micro ?? 0) / 1e6;
      for (const s of g.acc.sessions) sessions.add(s);
    }
    const total = clean(sum);
    rows.push({ by: input.by, key: 'others', label: 'Others', state: 'others', own: total, total, share: shareOf(total, grand), sessions: sessions.size, firstAt: null, lastAt: null });
  }
  if (!done) {
    for (const state of ['none', 'unknown'] as const) {
      const g = [...map.values()].find((x) => x.cell.state === state);
      if (g) rows.push(row(g.cell, g.acc));
    }
  }
  // Dollars whose row is known or recorded as none, over all dollars (with `doneOnly`: the dollars of the rows shown).
  let attributed = 0;
  if (done) for (const r of known) attributed += r.total.costUsd;
  else for (const g of map.values()) if (g.cell.state !== 'unknown') attributed += g.acc.totals.costUsd + (g.cell.state === 'known' ? (via.get(g.cell.key)?.micro ?? 0) / 1e6 : 0);
  const coverage: SpendFigure =
    grand.requests === 0 ? unavailableFigure('no_samples') : !(grand.costUsd > 0) ? { value: null, basis: 'unavailable', reason: 'no_cost' } : estimatedFigure(pct((attributed / grand.costUsd) * 100));
  return { rows, coverage, more: rest.length, ...(doneByType ? { doneByType } : {}) };
}

/** The session tree: one row per session with requests and per known ancestor of one, a session's `total` holding the ones it started. */
function sessionTree(input: AttributionInput, grand: ChatUsageTotals): { rows: AttributionRow[]; more: number } {
  const own = new Map<string, Acc>();
  const lastRow = new Map<string, UsageRow>();
  for (const r of input.rows) {
    let a = own.get(r.sessionId);
    if (!a) own.set(r.sessionId, (a = acc()));
    take(a, r);
    lastRow.set(r.sessionId, r);
  }
  // The nodes: the sessions with requests, and the ancestors still known (so the tree has no holes).
  const nodes = new Set<string>(own.keys());
  for (const id of [...own.keys()]) for (const s of lineage(id, input.sessions).sessions) nodes.add(s.sessionId);
  // A continuation sits right under the ROOT of its chain (T-312: the root's total is the chain's, each segment is a row one level down, however
  // long the chain); any other session under its parent.
  const parent = (id: string): string | null => {
    const s = input.sessions.get(id);
    if (!s) return null;
    const root = s.continuedFrom && input.sessions.has(s.continuedFrom) ? chainRootOf(id, input.sessions) : id;
    const p = root !== id ? root : s.parentId;
    return p && p !== id && nodes.has(p) ? p : null;
  };
  const kids = new Map<string, string[]>();
  for (const id of nodes) {
    const p = parent(id);
    if (p) (kids.get(p) ?? kids.set(p, []).get(p)!).push(id);
  }
  let roots = [...nodes].filter((id) => !parent(id)).sort();
  // Everything reachable from the roots; whatever is left over sits in a cycle of parent links (corrupt data): break it at its first id.
  const reach = (starts: string[], seen: Set<string>) => {
    const stack = [...starts];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(kids.get(id) ?? []));
    }
  };
  const seen = new Set<string>();
  reach(roots, seen);
  for (const id of [...nodes].sort()) {
    if (seen.has(id)) continue;
    roots.push(id);
    const p = parent(id);
    if (p) kids.set(p, (kids.get(p) ?? []).filter((k) => k !== id));
    reach([id], seen);
  }
  roots = [...new Set(roots)];

  // Totals bottom-up: a pre-order from the roots, handled in reverse, sees every child before its parent.
  const pre: string[] = [];
  const walk = [...roots];
  while (walk.length) {
    const id = walk.pop()!;
    pre.push(id);
    walk.push(...(kids.get(id) ?? []));
  }
  const total = new Map<string, ChatUsageTotals>();
  const count = new Map<string, number>();
  for (const id of [...pre].reverse()) {
    const t = zeroTotals();
    const o = own.get(id);
    if (o) addTotals(t, o.totals);
    let n = o ? 1 : 0;
    for (const k of kids.get(id) ?? []) {
      addTotals(t, total.get(k)!);
      n += count.get(k)!;
    }
    total.set(id, t);
    count.set(id, n);
  }
  const labelOf = (id: string): string => {
    const t = input.sessions.get(id)?.title;
    return t || `Session ${id.slice(0, 8)}`;
  };
  const sorter = (a: string, b: string) => byCostDesc({ total: total.get(a)!, label: labelOf(a) }, { total: total.get(b)!, label: labelOf(b) });
  roots.sort(sorter);
  for (const list of kids.values()) list.sort(sorter);

  const shownRoots = roots.slice(0, input.limit);
  const rest = roots.slice(input.limit);
  const rows: AttributionRow[] = [];
  const stack = [...shownRoots].reverse().map((id) => ({ id, depth: 0 }));
  while (stack.length) {
    const { id, depth } = stack.pop()!;
    const info = input.sessions.get(id);
    const last = lastRow.get(id);
    const o = own.get(id);
    const children = kids.get(id) ?? [];
    const workspaceId = info?.workspaceId ?? last?.workspaceId ?? '';
    const claudeId = info?.claudeId || last?.claudeId || '';
    const facts: SessionFacts = {
      sessionId: id,
      title: info?.title ?? '',
      workspaceId,
      workspaceName: workspaceNameOf(workspaceId),
      claudeId,
      claudeName: input.claudeName(claudeId, workspaceId),
      ticketId: info?.ticketId ?? null,
      parentId: info?.parentId ?? null,
      continuedFrom: info?.continuedFrom ?? null,
      depth,
      children: children.length,
      exists: info?.exists ?? false,
      state: info?.state ?? null,
    };
    const ownTotals = clean(o?.totals ?? zeroTotals());
    const totalClean = clean(total.get(id)!);
    rows.push({
      by: 'session',
      key: id,
      label: labelOf(id),
      state: 'known',
      own: ownTotals,
      total: totalClean,
      share: shareOf(totalClean, grand),
      sessions: count.get(id)!,
      firstAt: o ? iso(o.first) : null,
      lastAt: o ? iso(o.last) : null,
      session: facts,
    });
    for (let i = children.length - 1; i >= 0; i--) stack.push({ id: children[i]!, depth: depth + 1 });
  }
  if (rest.length) {
    const sum = zeroTotals();
    let sessions = 0;
    for (const id of rest) {
      addTotals(sum, total.get(id)!);
      sessions += count.get(id)!;
    }
    const t = clean(sum);
    rows.push({ by: 'session', key: 'others', label: 'Others', state: 'others', own: t, total: t, share: shareOf(t, grand), sessions, firstAt: null, lastAt: null });
  }
  return { rows, more: rest.length };
}

/** Groups the window's requests by one dimension (§22). */
export function attribute(input: AttributionInput): Attribution {
  const grand = zeroTotals();
  const sideAcc = zeroTotals();
  for (const r of input.rows) {
    addRow(grand, r);
    if (r.kind === 'side') addRow(sideAcc, r);
  }
  const totals = clean(grand);
  const side = clean(sideAcc);
  if (input.by === 'session') {
    const { rows, more } = sessionTree(input, grand);
    const coverage: SpendFigure = grand.requests === 0 ? unavailableFigure('no_samples') : !(grand.costUsd > 0) ? { value: null, basis: 'unavailable', reason: 'no_cost' } : estimatedFigure(100);
    return { totals, side, rows, coverage, more };
  }
  const { rows, coverage, more, doneByType } = groups(input, grand);
  return { totals, side, rows, coverage, more, ...(doneByType ? { doneByType } : {}) };
}
