// T-119 S1a: ticketFlow turns a ticket's events into spans and markers. Pure: every time here is fixed and "now" is passed in (no real clock).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WAITING_TAG, ticketFlow, type FlowEvent, type FlowInput } from './ticketFlow.js';

const T0 = Date.parse('2026-10-18T00:00:00.000Z');
/** The ISO time `m` minutes after T0. */
const at = (m: number): string => new Date(T0 + m * 60_000).toISOString();
const MIN = 60_000;
const NOW = T0 + 1_000 * MIN;

const ui = { actor: 'ui', actorLabel: 'Admin' };
const lane = { actor: 'session:s1', actorLabel: 'Build lane', fromAgent: true };
const ev = (m: number, kind: string, data: Record<string, unknown> | null = null, who: Partial<FlowEvent> = ui, body: string | null = null): FlowEvent => ({
  at: at(m),
  kind,
  actor: 'ui',
  actorLabel: 'Admin',
  body,
  data,
  ...who,
});
const flow = (events: FlowEvent[], over: Partial<FlowInput> = {}, now = NOW) => ticketFlow({ createdAt: at(0), events, ...over }, now);
const brief = (f: ReturnType<typeof flow>) => f.spans.map((s) => `${s.state} ${s.start === s.end ? 'at ' : ''}${s.start.slice(11, 16)}${s.end === null ? ' ..' : s.start === s.end ? '' : `-${s.end.slice(11, 16)}`}`);

test('a normal run: open, in progress, in review, done: each span ends where the next starts, with who moved it', () => {
  const f = flow([
    ev(0, 'created', { tags: [] }),
    ev(10, 'status', { from: 'open', to: 'in_progress' }, lane),
    ev(60, 'status', { from: 'in_progress', to: 'in_review' }, lane),
    ev(90, 'closed', { from: 'in_review', to: 'done' }, ui, 'QA passed'),
  ]);
  assert.deepEqual(brief(f), ['open 00:00-00:10', 'in_progress 00:10-01:00', 'in_review 01:00-01:30', 'done at 01:30']);
  assert.deepEqual(f.spans.map((s) => s.durationMs), [10 * MIN, 50 * MIN, 30 * MIN, 0]);
  assert.deepEqual(f.spans[1]!.by, { actor: 'session:s1', label: 'Build lane', session: 's1' });
  assert.deepEqual(f.spans[0]!.by, { actor: 'ui', label: 'Admin', session: null }, 'the first span is by whoever created it');
  assert.equal(f.spans[3]!.reason, 'QA passed', 'a close carries its summary as the reason');
  assert.equal(f.state, 'done');
  assert.deepEqual(f.totals, { open: 10 * MIN, in_progress: 50 * MIN, in_review: 30 * MIN, done: 0 });
});

test('a reopened ticket has several spans of one state; the closed span is a point and the next span starts at the reopen', () => {
  const f = flow([
    ev(0, 'created'),
    ev(10, 'status', { from: 'open', to: 'in_progress' }),
    ev(20, 'status', { from: 'in_progress', to: 'blocked', reason: 'waiting for the lane' }),
    ev(30, 'status', { from: 'blocked', to: 'in_progress' }),
    ev(40, 'closed', { from: 'in_progress', to: 'done' }),
    ev(100, 'reopened', { from: 'done', to: 'in_progress' }),
  ]);
  assert.deepEqual(brief(f), ['open 00:00-00:10', 'in_progress 00:10-00:20', 'blocked 00:20-00:30', 'in_progress 00:30-00:40', 'done at 00:40', 'in_progress 01:40 ..']);
  assert.equal(f.spans.filter((s) => s.state === 'in_progress').length, 3);
  assert.equal(f.spans[2]!.reason, 'waiting for the lane');
  assert.equal(f.spans[5]!.durationMs, NOW - (T0 + 100 * MIN), 'the open span runs to now');
  assert.equal(f.totals.in_progress, 10 * MIN + 10 * MIN + (NOW - (T0 + 100 * MIN)));
});

test('a ticket with no status event is one span from its created time to now (in the status it has), and a closed one is a point', () => {
  assert.deepEqual(brief(flow([ev(0, 'created')])), ['open 00:00 ..']);
  const running = flow([ev(0, 'created')], { status: 'in_progress' }, T0 + 30 * MIN);
  assert.deepEqual(brief(running), ['in_progress 00:00 ..']);
  assert.equal(running.spans[0]!.durationMs, 30 * MIN, '"now" is the one passed in');
  assert.equal(running.spans[0]!.end, null);
  const closed = flow([], { status: 'wont_do', closedAt: at(45) });
  assert.deepEqual(brief(closed), ['wont_do at 00:45']);
  assert.equal(closed.spans[0]!.durationMs, 0);
  assert.deepEqual(flow([]).spans.map((s) => s.state), ['open'], 'no events at all: created to now');
});

test('events out of clock order are read in time order; ties keep their given order; an unreadable time or an unknown status is ignored', () => {
  const sorted = [
    ev(0, 'created'),
    ev(10, 'status', { from: 'open', to: 'in_progress' }),
    ev(20, 'status', { from: 'in_progress', to: 'blocked' }),
    ev(30, 'status', { from: 'blocked', to: 'in_review' }),
  ];
  const shuffled = [sorted[3]!, sorted[1]!, sorted[0]!, sorted[2]!];
  assert.deepEqual(flow(shuffled), flow(sorted));
  assert.deepEqual(brief(flow(shuffled)), ['open 00:00-00:10', 'in_progress 00:10-00:20', 'blocked 00:20-00:30', 'in_review 00:30 ..']);
  // Two moves at the same instant: the later in the list wins the state, the earlier one is a zero-length span.
  const tie = flow([ev(0, 'created'), ev(5, 'status', { from: 'open', to: 'blocked' }), ev(5, 'status', { from: 'blocked', to: 'in_progress' })]);
  assert.deepEqual(brief(tie), ['open 00:00-00:05', 'blocked 00:05-00:05', 'in_progress 00:05 ..']);
  const odd = flow([ev(0, 'created'), { ...ev(5, 'status', { from: 'open', to: 'in_progress' }), at: 'not a time' }, ev(6, 'status', { from: 'open', to: 'sleeping' })]);
  assert.deepEqual(brief(odd), ['open 00:00 ..']);
  // An event earlier than the created time pulls the start back to it (the span never starts after its own first event).
  assert.equal(flow([ev(-5, 'status', { from: 'open', to: 'in_progress' })]).spans[0]!.start, at(-5));
  assert.deepEqual(ticketFlow({ createdAt: 'nope', events: [] }, NOW), { spans: [], markers: [], state: null, totals: {} });
});

test('a closed ticket: the done and wont_do spans end at the close and do not grow with now', () => {
  const events = [ev(0, 'created'), ev(10, 'status', { from: 'open', to: 'in_progress' }), ev(70, 'closed', { from: 'in_progress', to: 'wont_do' })];
  const early = flow(events, {}, T0 + 80 * MIN);
  const late = flow(events, {}, T0 + 900 * MIN);
  const last = late.spans.at(-1)!;
  assert.deepEqual([last.state, last.start, last.end, last.durationMs], ['wont_do', at(70), at(70), 0]);
  assert.deepEqual(early.spans, late.spans, 'later now: nothing about a closed ticket changes');
  assert.equal(late.state, 'wont_do');
});

test('waiting for a person: the needs-a-person tag splits the status span; it ends when the tag goes, or at the close', () => {
  const f = flow([
    ev(0, 'created', { tags: [] }),
    ev(10, 'status', { from: 'open', to: 'in_progress' }, lane),
    ev(20, 'tags', { from: [], to: [WAITING_TAG] }, lane),
    ev(50, 'tags', { from: [WAITING_TAG], to: [] }),
  ]);
  assert.deepEqual(brief(f), ['open 00:00-00:10', 'in_progress 00:10-00:20', 'waiting 00:20-00:50', 'in_progress 00:50 ..']);
  assert.deepEqual([f.spans[2]!.reason, f.spans[2]!.by?.session], [WAITING_TAG, 's1']);
  assert.deepEqual(f.markers.map((m) => [m.kind, m.at.slice(11, 16)]), [['tags', '00:20'], ['waiting', '00:20'], ['tags', '00:50']]);
  assert.equal(f.totals.waiting, 30 * MIN);
  // Still waiting at the end: an open waiting span.
  const still = flow([ev(0, 'created'), ev(5, 'tags', { from: [], to: ['a', WAITING_TAG] })]);
  assert.deepEqual(brief(still), ['open 00:00-00:05', 'waiting 00:05 ..']);
  // Waiting from creation (the tag was on at creation).
  assert.deepEqual(brief(flow([ev(0, 'created', { tags: [WAITING_TAG] }), ev(15, 'tags', { from: [WAITING_TAG], to: [] })])), ['waiting 00:00-00:15', 'open 00:15 ..']);
  // Closed while the tag is still on: waiting stops at the close, and the done point follows.
  const closed = flow([ev(0, 'created'), ev(10, 'status', { from: 'open', to: 'in_progress' }), ev(20, 'tags', { from: [], to: [WAITING_TAG] }), ev(60, 'closed', { from: 'in_progress', to: 'done' })]);
  assert.deepEqual(brief(closed), ['open 00:00-00:10', 'in_progress 00:10-00:20', 'waiting 00:20-01:00', 'done at 01:00']);
  // Another tag changing does not wait.
  assert.deepEqual(brief(flow([ev(0, 'created'), ev(5, 'tags', { from: [], to: ['frontend'] })])), ['open 00:00 ..']);
});

test('markers: assigned, claimed, bumped, a person’s comment (not an agent’s or the portal’s), priority, tags and a CI result', () => {
  const f = flow([
    ev(0, 'created'),
    ev(1, 'assigned', { from: null, to: { kind: 'session', sessionId: 'qa1' } }),
    ev(2, 'assigned', { from: null, to: { kind: 'session', sessionId: 'lead' }, claimed: true }, lane),
    ev(3, 'bumped', { sessionId: 'lead', sessionTitle: 'Lead', mode: 'send' }, ui, 'look at T-9'),
    ev(4, 'comment', null, ui, 'a person says'),
    ev(5, 'comment', null, lane, 'an agent says'),
    ev(6, 'comment', { fallback: true }, { actor: 'system', actorLabel: 'Portal' }, 'back in the queue'),
    ev(7, 'priority', { from: 'normal', to: 'urgent' }),
    ev(8, 'tags', { from: ['a', 'b'], to: ['b', 'c'] }),
    ev(9, 'ci', { name: 'gate' }, { actor: 'system', actorLabel: 'CI' }),
    ev(10, 'summary', { from: 'x', to: 'y' }),
  ]);
  assert.deepEqual(
    f.markers.map((m) => [m.kind, m.at.slice(14, 16), m.detail]),
    [
      ['assigned', '01', 'qa1'],
      ['claimed', '02', 'lead'],
      ['bumped', '03', 'look at T-9'],
      ['comment', '04', 'a person says'],
      ['priority', '07', 'normal → urgent'],
      ['tags', '08', '+c -a'],
      ['ci', '09', 'gate'],
    ],
  );
});
