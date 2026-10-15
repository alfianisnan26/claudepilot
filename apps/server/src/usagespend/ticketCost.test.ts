import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATTRIBUTION_LEAD_BASIS } from '@portal/contracts';
import { Lab } from '../lab/index.js';
import { splitExact } from './ticketCost.js';
import { DAY, HOUR, NOW, spendHarness } from './testkit.js';

// T-449: a lead's dollars go to the tickets of its workers. The fixture, by hand (dollars):
//   L  lead, no ticket           $10.00   workers: W1 (T-1), W2 (T-1), W3 (T-2)
//   W1 $2.00  W2 $1.00  (T-1, feature, done 1 h ago)    W3 $3.00 (T-2, bug, in progress)
//   S  solo, no ticket, no workers  $4.00
// Weights T-1: 2, T-2: 1 -> $10 splits 6.666667 / 3.333333 (the odd millionth goes to the larger fraction: T-1). Window total $20.00.
async function seeded() {
  const h = await spendHarness();
  const t = new Date(NOW).toISOString();
  const ticket = h.db.prepare('INSERT INTO tickets (number, type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  ticket.run(1, 'feature', 'normal', 2, 'done', 'one', 'human', 'ui', 'owner', t, t, new Date(NOW - HOUR).toISOString());
  ticket.run(2, 'bug', 'normal', 2, 'in_progress', 'two', 'human', 'ui', 'owner', t, t, null);
  h.seed.session('L', { title: 'Lead' });
  h.seed.session('W1', { parentId: 'L', ticketId: 'T-1' });
  h.seed.session('W2', { parentId: 'L', ticketId: 'T-1' });
  h.seed.session('W3', { parentId: 'L', ticketId: 'T-2' });
  h.seed.session('S', { title: 'Solo' });
  for (const [s, usd] of [['L', 10], ['W1', 2], ['W2', 1], ['W3', 3], ['S', 4]] as const) h.seed.usage({ atMs: NOW - 2 * HOUR, session: s, costUsd: usd });
  return h;
}

const micro = (n: number) => Math.round(n * 1e6);

test('a lead’s cost is apportioned by its workers per ticket and the parts add up to it exactly; "via lead" sits beside the ticket’s own', async () => {
  const h = await seeded();
  try {
    const r = h.spend.attribution({ by: 'ticket', range: '1d' });
    const row = (k: string) => r.rows.find((x) => x.key === k)!;
    assert.equal(row('T-1').own.costUsd, 3);
    assert.equal(row('T-1').ticket!.viaLeadUsd, 6.666667);
    assert.equal(row('T-1').ticket!.viaLeadWorkers, 2);
    assert.equal(row('T-1').total.costUsd, 9.666667);
    assert.equal(row('T-2').ticket!.viaLeadUsd, 3.333333);
    assert.equal(row('T-2').total.costUsd, 6.333333);
    assert.equal(micro(row('T-1').ticket!.viaLeadUsd) + micro(row('T-2').ticket!.viaLeadUsd), micro(10), 'the parts sum to the lead’s cost');
    // The rows still add up to the window: nothing counted twice or lost.
    assert.equal(micro(r.rows.reduce((t, x) => t + x.total.costUsd, 0)), micro(r.totals.costUsd));
    assert.equal(r.totals.costUsd, 20);
    assert.match(r.leadBasis ?? '', /split over those tickets/);
    assert.equal(r.leadBasis, ATTRIBUTION_LEAD_BASIS);
  } finally {
    h.done();
  }
});

test('a session with no ticket and no worker on a ticket stays "No ticket"; the lead’s apportioned dollars leave it', async () => {
  const h = await seeded();
  try {
    const r = h.spend.attribution({ by: 'ticket', range: '1d' });
    const none = r.rows.find((x) => x.state === 'none')!;
    assert.equal(none.label, 'No ticket');
    assert.equal(none.total.costUsd, 4);
  } finally {
    h.done();
  }
});

test('a lead whose workers are on no ticket stays entirely "No ticket"', async () => {
  const h = await spendHarness();
  try {
    h.seed.session('L');
    h.seed.session('W', { parentId: 'L' });
    h.seed.usage({ atMs: NOW - HOUR, session: 'L', costUsd: 5 });
    h.seed.usage({ atMs: NOW - HOUR, session: 'W', costUsd: 1 });
    const r = h.spend.attribution({ by: 'ticket', range: '1d' });
    assert.deepEqual(r.rows.map((x) => [x.state, x.total.costUsd]), [['none', 6]]);
  } finally {
    h.done();
  }
});

test('type and status per ticket, and the done-in-window filter with cost per done ticket by type', async () => {
  const h = await seeded();
  try {
    const all = h.spend.attribution({ by: 'ticket', range: '1d' });
    assert.deepEqual([all.rows.find((x) => x.key === 'T-1')!.ticket!.type, all.rows.find((x) => x.key === 'T-1')!.ticket!.status, all.rows.find((x) => x.key === 'T-2')!.ticket!.type], ['feature', 'done', 'bug']);
    assert.ok(all.rows.find((x) => x.key === 'T-1')!.ticket!.doneAt);
    assert.equal(all.rows.find((x) => x.key === 'T-2')!.ticket!.doneAt, null);
    assert.deepEqual(all.doneByType, [{ type: 'feature', tickets: 1, costUsd: 9.666667, perTicketUsd: 9.666667 }]);
    const done = h.spend.attribution({ by: 'ticket', range: '1d', done: true });
    assert.deepEqual(done.rows.map((x) => x.key), ['T-1']);
    assert.equal(done.doneOnly, true);
    // Closed before the window: not "done in the window".
    h.db.prepare('UPDATE tickets SET closed_at = ? WHERE number = 1').run(new Date(NOW - 3 * DAY).toISOString());
    assert.deepEqual(h.spend.attribution({ by: 'ticket', range: '1d', done: true }).rows, []);
  } finally {
    h.done();
  }
});

test('the lab reads the same per-ticket figures (one function)', async () => {
  const h = await seeded();
  try {
    const lab = new Lab({ store: h.store, now: () => NOW });
    const t = lab.ticketCosts(NOW - DAY, NOW);
    const api = h.spend.attribution({ by: 'ticket', range: '1d' });
    for (const x of t) {
      const r = api.rows.find((y) => y.key === x.ticket)!;
      assert.deepEqual([x.ownUsd, x.viaLeadUsd, x.totalUsd, x.type, x.status], [r.own.costUsd, r.ticket!.viaLeadUsd, r.total.costUsd, r.ticket!.type, r.ticket!.status]);
    }
    assert.deepEqual(t.map((x) => x.ticket), ['T-1', 'T-2']);
    assert.equal(lab.summary({ sinceMs: NOW - DAY }).tickets!.length, 2);
    // An agent's own tree only: W3 sees nothing of the lead's apportioning.
    assert.deepEqual(lab.ticketCosts(NOW - DAY, NOW, 'W3').map((x) => [x.ticket, x.viaLeadUsd]), [['T-2', 0]]);
    lab.close();
  } finally {
    h.done();
  }
});

test('splitExact: exact sum, ties to the lower ticket number', () => {
  const m = splitExact(100, [{ key: 'T-10', weight: 1 }, { key: 'T-2', weight: 1 }, { key: 'T-3', weight: 1 }]);
  assert.deepEqual([m.get('T-2'), m.get('T-3'), m.get('T-10')], [34, 33, 33]);
  assert.equal([...m.values()].reduce((a, b) => a + b, 0), 100);
  assert.equal(splitExact(0, [{ key: 'T-1', weight: 1 }]).size, 0);
});
