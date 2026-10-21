import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FlowProgramView, FlowSnapshot } from '@portal/contracts';
import { actionLine, flowCompact, flowView } from './model';

const prog = (over: Partial<FlowProgramView> = {}): FlowProgramView => ({
  name: 'konfersi',
  tag: 'konfersi-migration',
  enabled: true,
  ok: true,
  mergeGate: null,
  mergeGateLive: null,
  leads: [],
  counts: { merge: 2, qa: 3, idle: 1, bypass: 0, stall: 0 },
  inReview: 9,
  doneRecent: 1,
  stallSince: null,
  ...over,
});
const snap = (programs: FlowProgramView[], enabled = true): FlowSnapshot => ({ enabled, lastRunAt: null, programs, actions: [] });

test('flowView sums programs that ran; none read is unavailable, not zero', () => {
  const v = flowView(snap([prog(), prog({ name: 'b', counts: { merge: 1, qa: 0, idle: 0, bypass: 1, stall: 1 } }), prog({ name: 'c', ok: false })]));
  assert.deepEqual([v.merge, v.qa, v.idle, v.bypass, v.stalled, v.inReview], [3, 3, 1, 1, 1, 18]);
  const none = flowView(snap([prog({ ok: false })]));
  assert.equal(none.merge, null);
  assert.equal(flowCompact(none, false).value, '-');
});

test('flowCompact: stalled is critical, stuck work warns, off is idle', () => {
  assert.equal(flowCompact(flowView(snap([prog()])), false).level, 'warn');
  assert.equal(flowCompact(flowView(snap([prog()])), false).value, '6');
  assert.equal(flowCompact(flowView(snap([prog({ counts: { merge: 0, qa: 0, idle: 0, bypass: 0, stall: 1 } })])), false).level, 'critical');
  assert.equal(flowCompact(flowView(snap([prog({ counts: { merge: 0, qa: 0, idle: 0, bypass: 0, stall: 0 } })])), false).level, 'ok');
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
