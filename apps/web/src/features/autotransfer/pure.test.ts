import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AutoTransferEvent } from '@portal/contracts';
import { autoMarks, droppedText, headline, offer, pctText } from './pure';

const m = (value: number) => ({ value, basis: 'measured' as const });

test('numbers keep their basis', () => {
  assert.equal(pctText(m(8)), '8 %');
  assert.equal(pctText({ value: 12.34, basis: 'estimate' }), '12.3 % est.');
  assert.equal(pctText({ value: null, basis: 'unavailable', reason: 'no_reading' }), '–');
});

test('the card lines', () => {
  const s = { from: { id: 'w', name: 'Work' }, to: { id: 'h', name: 'Home' }, reason: 'low' as const, facts: { leftPct: m(8), thresholdPct: 10, resetsAt: m('x') as never, destLeftPct: m(40) } };
  assert.equal(headline(s), 'Work has 8 % left');
  assert.equal(offer(s), 'Move to Home (40 % left)');
  assert.equal(headline({ ...s, reason: 'exhausted' }), 'Work is used up');
  assert.equal(offer({ ...s, facts: { ...s.facts, destLeftPct: undefined } }), 'Move to Home');
  assert.equal(droppedText({ approvals: 1, queued: 0, agents: 2 }), 'Drops 1 approval, 2 agents');
  assert.equal(droppedText({ approvals: 0, queued: 0, agents: 0 }), null);
});

test('auto marks: automatic moves of the last day, not undone', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const ev = (id: number, kind: AutoTransferEvent['kind'], handoffId: string, at: string, actor = 'portal:autotransfer') => ({ id, kind, handoffId, at, actor }) as AutoTransferEvent;
  const marks = autoMarks(
    [
      ev(5, 'undone', 'h2', '2026-10-12T11:50:00Z', 'ui'),
      ev(4, 'moved', 'h2', '2026-10-12T11:40:00Z'),
      ev(3, 'moved', 'h1', '2026-10-12T11:00:00Z'),
      ev(2, 'moved', 'h0', '2026-10-11T11:00:00Z'),
      ev(1, 'moved', 'hp', '2026-10-12T11:00:00Z', 'user:u_owner'),
    ],
    now,
  );
  assert.deepEqual([...marks.keys()], ['h1']);
});
