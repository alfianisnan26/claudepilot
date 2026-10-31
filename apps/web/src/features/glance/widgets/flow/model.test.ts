import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FlowAction, FlowProgramView, FlowSnapshot } from '@portal/contracts';
import { actionLine, flowCompact, flowView, quietLine } from './model';

const prog = (over: Partial<FlowProgramView> = {}): FlowProgramView => ({
  name: 'konfersi',
  tag: 'konfersi-migration',
  enabled: true,
  ok: true,
  paused: null,
  mergeGate: null,
  mergeGateLive: null,
  leads: [],
  counts: { merge: 2, qa: 3, idle: 1, bypass: 0, stall: 0, conflict: 0, no_pr: 0, idle_lanes: 0 },
  inReview: 9,
  doneRecent: 1,
  stallSince: null,
  ...over,
});
const snap = (programs: FlowProgramView[], enabled = true): FlowSnapshot => ({ enabled, lastRunAt: null, programs, actions: [] });

test('flowView sums programs that ran; none read is unavailable, not zero', () => {
  const v = flowView(snap([prog(), prog({ name: 'b', counts: { merge: 1, qa: 0, idle: 0, bypass: 1, stall: 1, conflict: 0, no_pr: 0, idle_lanes: 0 } }), prog({ name: 'c', ok: false })]));
  assert.deepEqual([v.merge, v.qa, v.idle, v.bypass, v.stalled, v.inReview], [3, 3, 1, 1, 1, 18]);
  const none = flowView(snap([prog({ ok: false })]));
  assert.equal(none.merge, null);
  assert.equal(flowCompact(none, false).value, '-');
});

test('flowCompact: stalled is critical, stuck work warns, off is idle', () => {
  assert.equal(flowCompact(flowView(snap([prog()])), false).level, 'warn');
  assert.equal(flowCompact(flowView(snap([prog()])), false).value, '6');
  assert.equal(flowCompact(flowView(snap([prog({ counts: { merge: 0, qa: 0, idle: 0, bypass: 0, stall: 1, conflict: 0, no_pr: 0, idle_lanes: 0 } })])), false).level, 'critical');
  assert.equal(flowCompact(flowView(snap([prog({ counts: { merge: 0, qa: 0, idle: 0, bypass: 0, stall: 0, conflict: 0, no_pr: 0, idle_lanes: 0 } })])), false).level, 'ok');
  assert.equal(flowCompact(flowView(snap([prog()], false)), false).level, 'idle');
  assert.equal(flowCompact(null, true).level, 'unknown');
});

test('actionLine: a few words, at most three tickets', () => {
  assert.equal(
    actionLine({ at: '', program: 'k', condition: 'merge', kind: 'told', sessionId: null, tickets: ['T-1', 'T-2', 'T-3', 'T-4'], note: '' }),
    'Told · merge · T-1, T-2, T-3 +1',
  );
  assert.equal(actionLine({ at: '', program: 'k', condition: 'stall', kind: 'notified', sessionId: null, tickets: [], note: '' }), 'Notified you · stall');
});

test('actionLine (T-2016): bucket keys when the action has them, the ids of an older action without them', () => {
  const a: FlowAction = { at: '', program: 'k', condition: 'conflict', kind: 'told', sessionId: null, tickets: ['T-12', 'T-13'], note: '' };
  assert.equal(actionLine({ ...a, keys: ['KONF-12', 'T-13'] }), 'Told · conflict · KONF-12, T-13');
  assert.equal(actionLine(a), 'Told · conflict · T-12, T-13');
  assert.equal(actionLine({ ...a, keys: ['KONF-12'] }), 'Told · conflict · T-12, T-13', 'a keys list that does not match is not used');
});

test('flowView lists the programs a pause holds', () => {
  const v = flowView(snap([prog(), prog({ name: 'b', paused: 'keepgoing' })]));
  assert.deepEqual(v.paused, ['b']);
  assert.match(flowCompact(v, false).title, /paused: b/);
});

test('quietLine: "Nothing needed a nudge." only when every program was read; an unread one is unavailable, not quiet', () => {
  const read = flowView({ ...snap([prog()]), lastRunAt: '2026-10-21T00:00:00.000Z' });
  assert.equal(quietLine(read), 'Nothing needed a nudge.');
  assert.equal(quietLine(flowView(snap([prog()]))), 'No round yet.');
  const unread = flowView({ ...snap([prog(), prog({ name: 'b', ok: false })]), lastRunAt: '2026-10-21T00:00:00.000Z' });
  assert.deepEqual(unread.unread, ['b']);
  assert.equal(quietLine(unread), null);
  const stalled = flowView({ ...snap([prog({ counts: { merge: 0, qa: 0, idle: 0, bypass: 0, stall: 1, conflict: 0, no_pr: 0, idle_lanes: 0 } })]), lastRunAt: '2026-10-21T00:00:00.000Z' });
  assert.equal(quietLine(stalled), null, 'a stall has its own line: no quiet claim beside it');
  assert.deepEqual(flowView(snap([prog({ counts: { merge: 0, qa: 0, idle: 0, bypass: 0, stall: 1, conflict: 0, no_pr: 0, idle_lanes: 0 } }), prog({ name: 'b', ok: false, counts: { merge: 0, qa: 0, idle: 0, bypass: 0, stall: 1, conflict: 0, no_pr: 0, idle_lanes: 0 } })])).stalledIn, ['konfersi']);
});

test('T-2018: idle lanes are summed, counted as stuck work, named in the title; a snapshot from before them reads 0', () => {
  const v = flowView(snap([prog({ counts: { merge: 0, qa: 0, idle: 0, bypass: 0, stall: 0, conflict: 0, no_pr: 0, idle_lanes: 2 } }), prog({ name: 'b', counts: { merge: 0, qa: 0, idle: 0, bypass: 0, stall: 0, conflict: 0, no_pr: 0, idle_lanes: 1 } })]));
  assert.equal(v.idleLanes, 3);
  const c = flowCompact(v, false);
  assert.equal(c.value, '3');
  assert.equal(c.level, 'warn');
  assert.match(c.title, /3 idle lanes/);
  const old = { ...prog(), counts: { merge: 0, qa: 0, idle: 0, bypass: 0, stall: 0, conflict: 0, no_pr: 0 } } as unknown as FlowProgramView;
  assert.equal(flowView(snap([old])).idleLanes, 0);
  assert.equal(actionLine({ at: '', program: 'k', condition: 'idle_lanes', kind: 'told', sessionId: null, tickets: ['T-1'], note: '' }), 'Told · idle lanes · T-1');
});
