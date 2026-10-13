import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ticketsCompact, ticketsView } from './model.js';

const counts = (byStatus: Partial<Record<'open' | 'in_progress' | 'blocked' | 'in_review' | 'done' | 'wont_do', number>>, needsYou = 0, unassigned = 0) => ({
  counts: { byStatus: { open: 0, in_progress: 0, blocked: 0, in_review: 0, done: 0, wont_do: 0, ...byStatus }, needsYou, unassigned, total: 0 },
});

test('open is every status that is not closed; the four are listed in the queue order; closed ones never count', () => {
  const v = ticketsView(counts({ open: 4, in_progress: 2, blocked: 1, in_review: 0, done: 30, wont_do: 2 }, 3, 2));
  assert.equal(v.open, 7);
  assert.deepEqual(v.byStatus.map((s) => [s.label, s.count]), [['Open', 4], ['In progress', 2], ['Blocked', 1], ['In review', 0]]);
  assert.deepEqual([v.needsYou, v.unassigned], [3, 2]);
  assert.deepEqual(ticketsCompact(v, false), { value: '7', level: 'warn', title: 'Tickets: 7 open, 3 waiting for you and 1 blocked' });
});

test('an empty queue is idle and zero; loading and unavailable are states', () => {
  assert.deepEqual(ticketsCompact(ticketsView(counts({ done: 5 })), false), { value: '0', level: 'idle', title: 'Tickets: 0 open' });
  assert.equal(ticketsCompact(ticketsView(counts({ open: 1 })), false).level, 'ok');
  assert.equal(ticketsCompact(null, false).loading, true);
  assert.equal(ticketsCompact(null, true).value, '-');
});
