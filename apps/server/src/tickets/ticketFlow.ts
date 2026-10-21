// T-119 S1a: a ticket's flow, derived from its events and stored nowhere twice. A pure function: no clock, no database. The caller
// passes the ticket's created time, its events and "now"; it gets back SPANS (a state, from when to when, who moved it, why) and MARKERS
// (assigned, claimed, bumped, a person's comment, priority and tag changes, a CI result, "waiting for a person"). The chart (S2), the flow
// metrics (T-111, T-119 S3) and the Portal MCP tool read the same result.
//
// Rules, each with a test in ticketFlow.test.ts:
//  - Status moves are the `status`, `closed` and `reopened` events: `data` is `{ from, to }`. Events are read in time order (ties keep their
//    given order), whatever order they arrive in; one with an unreadable time or an unknown status is ignored.
//  - A ticket with no status event is one span, from its created time, in `status` (default open): still running (end null).
//  - A reopened ticket has several spans of one state.
//  - A closed state (done, wont_do) is a point: its span ends where it starts, at the close. Later spans start at the reopen, not at the close.
//  - "Waiting for a person" is the tag `needs-a-person`: while it is on a ticket that is not closed, that stretch is a `waiting` span in place of
//    the status span it covers (the status span is split around it).
//  - An open span has `end` null; its `durationMs` runs to the given "now" (never negative).
//  - clipFlow keeps what touches a window: a span that overlaps it (a running one up to now), a marker inside it.
// Not yet: an open approval as a reason to wait, linked commits and pull requests, the derived table (`ticket_spans`).

import {
  isTicketClosed,
  TICKET_STATUSES,
  type TicketFlow,
  type TicketFlowActor,
  type TicketFlowMarker,
  type TicketFlowMarkerKind,
  type TicketFlowSpan,
  type TicketFlowState,
  type TicketStatus,
} from '@portal/contracts';

/** The tag a ticket carries while it waits for a person. */
export const WAITING_TAG = 'needs-a-person';

export type FlowState = TicketFlowState;

/** The part of a ticket event the flow reads (a `TicketEvent` fits). */
export interface FlowEvent {
  at: string;
  kind: string;
  actor: string;
  actorLabel?: string;
  body?: string | null;
  data?: Record<string, unknown> | null;
  fromAgent?: boolean;
}

export interface FlowInput {
  /** When the ticket was created (ISO). */
  createdAt: string;
  /** The ticket's status now: the one span of a ticket with no status event. Default open. */
  status?: TicketStatus;
  /** When it closed (ISO), for a closed ticket with no status event. */
  closedAt?: string | null;
  events: readonly FlowEvent[];
}

// The wire shapes live in the contracts (the chart reads them); the names here are the same types.
export type FlowActor = TicketFlowActor;
export type FlowSpan = TicketFlowSpan;
export type FlowMarkerKind = TicketFlowMarkerKind;
export type FlowMarker = TicketFlowMarker;
export type Flow = TicketFlow;

const STATUSES = new Set<string>(TICKET_STATUSES);
const isStatus = (v: unknown): v is TicketStatus => typeof v === 'string' && STATUSES.has(v);
const MOVES = new Set(['status', 'closed', 'reopened']);
const DETAIL_MAX = 200;

const actorOf = (e: FlowEvent): FlowActor => ({ actor: e.actor, label: e.actorLabel ?? e.actor, session: e.actor.startsWith('session:') ? e.actor.slice('session:'.length) : null });
const isAgent = (e: FlowEvent): boolean => e.fromAgent ?? /^(?:session|portal-mcp):/.test(e.actor);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, DETAIL_MAX) : null);
const hasWaitingTag = (v: unknown): boolean => Array.isArray(v) && v.includes(WAITING_TAG);
const iso = (ms: number): string => new Date(ms).toISOString();

interface Ev {
  at: number;
  e: FlowEvent;
}
interface Raw {
  state: FlowState;
  start: number;
  /** Infinity while running. */
  end: number;
  by: FlowActor | null;
  reason: string | null;
}

/** A person is told apart from the portal and from an agent: a comment counts as a person's when neither wrote it. */
const personComment = (e: FlowEvent): boolean => !isAgent(e) && e.actor !== 'system' && e.data?.fallback !== true;

export function ticketFlow(input: FlowInput, now: number): Flow {
  const evs: Ev[] = [];
  for (const e of input.events) {
    const at = Date.parse(e.at);
    if (Number.isFinite(at)) evs.push({ at, e });
  }
  // Time order; a stable sort keeps the given order for events at the same instant.
  evs.sort((a, b) => a.at - b.at);
  const created = Date.parse(input.createdAt);
  const earliest = evs[0]?.at;
  const base = Number.isFinite(created) ? (earliest !== undefined ? Math.min(created, earliest) : created) : earliest;
  if (base === undefined) return { spans: [], markers: [], state: null, totals: {} };

  const createdEv = evs.find((x) => x.e.kind === 'created');
  const moves = evs.filter((x) => MOVES.has(x.e.kind) && isStatus(x.e.data?.to));

  // ---- status spans
  const raw: Raw[] = [];
  const first = moves[0];
  const firstFrom = first?.e.data?.from;
  const state0: TicketStatus = first ? (isStatus(firstFrom) ? firstFrom : 'open') : (input.status ?? 'open');
  let cur: Raw = { state: state0, start: base, end: Infinity, by: createdEv ? actorOf(createdEv.e) : null, reason: null };
  if (!first && isTicketClosed(state0)) {
    const closedAt = input.closedAt ? Date.parse(input.closedAt) : NaN;
    cur.start = Number.isFinite(closedAt) ? closedAt : base;
  }
  const finish = (r: Raw, until: number) => {
    r.end = isTicketClosed(r.state as TicketStatus) ? r.start : Math.max(until, r.start);
    raw.push(r);
  };
  for (const m of moves) {
    const to = m.e.data!.to as TicketStatus;
    if (to === cur.state) continue;
    finish(cur, m.at);
    cur = { state: to, start: m.at, end: Infinity, by: actorOf(m.e), reason: text(m.e.data?.reason) ?? (m.e.kind === 'closed' ? text(m.e.body) : null) };
  }
  finish(cur, Infinity);

  // ---- waiting for a person: the stretches the tag is on
  const windows: { start: number; end: number; by: FlowActor }[] = [];
  const firstTags = evs.find((x) => x.e.kind === 'tags');
  let on: { at: number; by: FlowActor } | null = null;
  if (hasWaitingTag(createdEv?.e.data?.tags) || (!createdEv && firstTags && hasWaitingTag(firstTags.e.data?.from))) {
    on = { at: base, by: createdEv ? actorOf(createdEv.e) : actorOf(firstTags!.e) };
  }
  for (const x of evs) {
    if (x.e.kind !== 'tags') continue;
    const waiting = hasWaitingTag(x.e.data?.to);
    if (waiting && !on) on = { at: x.at, by: actorOf(x.e) };
    else if (!waiting && on) (windows.push({ start: on.at, end: x.at, by: on.by }), (on = null));
  }
  if (on) windows.push({ start: on.at, end: Infinity, by: on.by });

  const pieces: Raw[] = [];
  for (const r of raw) {
    // A closed state is a point (end = start), so this also keeps waiting off a close.
    if (r.end <= r.start) {
      pieces.push(r);
      continue;
    }
    let cursor = r.start;
    for (const w of windows) {
      const w0 = Math.max(w.start, cursor);
      const w1 = Math.min(w.end, r.end);
      if (w1 <= w0) continue;
      if (w0 > cursor) pieces.push({ ...r, start: cursor, end: w0 });
      pieces.push({ state: 'waiting', start: w0, end: w1, by: w.by, reason: WAITING_TAG });
      cursor = w1;
    }
    if (cursor < r.end) pieces.push({ ...r, start: cursor });
  }

  const spans: FlowSpan[] = pieces.map((r) => ({
    state: r.state,
    start: iso(r.start),
    end: Number.isFinite(r.end) ? iso(r.end) : null,
    durationMs: Math.max(0, (Number.isFinite(r.end) ? r.end : now) - r.start),
    by: r.by,
    reason: r.reason,
  }));
  const totals: Partial<Record<FlowState, number>> = {};
  for (const s of spans) totals[s.state] = (totals[s.state] ?? 0) + s.durationMs;

  // ---- markers
  const markers: FlowMarker[] = [];
  const mark = (x: Ev, kind: FlowMarkerKind, detail: string | null) => markers.push({ kind, at: iso(x.at), by: actorOf(x.e), detail });
  for (const x of evs) {
    const d = x.e.data ?? {};
    switch (x.e.kind) {
      case 'assigned': {
        const to = d.to as { sessionId?: unknown; name?: unknown } | null | undefined;
        mark(x, d.claimed === true ? 'claimed' : 'assigned', text(to?.sessionId) ?? text(to?.name) ?? 'nobody');
        break;
      }
      case 'bumped':
        mark(x, 'bumped', text(x.e.body));
        break;
      case 'comment':
        if (personComment(x.e)) mark(x, 'comment', text(x.e.body));
        break;
      case 'priority':
        mark(x, 'priority', `${String(d.from)} → ${String(d.to)}`);
        break;
      case 'tags': {
        const from = Array.isArray(d.from) ? d.from.map(String) : [];
        const to = Array.isArray(d.to) ? d.to.map(String) : [];
        const added = to.filter((t) => !from.includes(t));
        const removed = from.filter((t) => !to.includes(t));
        mark(x, 'tags', [...added.map((t) => `+${t}`), ...removed.map((t) => `-${t}`)].join(' ').slice(0, DETAIL_MAX) || null);
        if (added.includes(WAITING_TAG)) mark(x, 'waiting', WAITING_TAG);
        break;
      }
      case 'ci':
        mark(x, 'ci', text(d.name) ?? text(d.check));
        break;
    }
  }

  return { spans, markers, state: spans.at(-1)?.state ?? null, totals };
}

/**
 * The part of a flow a window shows: the spans that overlap `from`..`to` (a running span lasts until `now`; a closed point counts when it falls
 * inside) and the markers inside it. `state` and `totals` stay over the whole life. Spans are not cut: the chart clips them to its axis.
 */
export function clipFlow(flow: Flow, from: number, to: number, now: number): Flow {
  const spans = flow.spans.filter((s) => {
    const a = Date.parse(s.start);
    const b = s.end === null ? Math.max(a, now) : Date.parse(s.end);
    return a <= to && b >= from;
  });
  const markers = flow.markers.filter((m) => {
    const at = Date.parse(m.at);
    return at >= from && at <= to;
  });
  return { ...flow, spans, markers };
}
