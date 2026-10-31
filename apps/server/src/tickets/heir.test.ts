// T-3220 (PILOT-1115): a lead chat ended; three minutes later the orphan sweep moved its tickets BY TITLE ("ClaudePilot: …") to an
// unrelated live chat; then Keep going started the continuation, which got none of them, and ticket_adopt from it was refused ("still
// live"). The continuation is the heir: it takes back what the title fallback moved off its predecessor, at its create and by ticket_adopt.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agent, ticketsHarness, UI } from './testkit.js';

const WS = 'kubernetes/kohi-event';

/** The incident: lead `old` ended with two tickets, the sweep moved them by title to the live `other` (same "ClaudePilot:" prefix). */
async function rig() {
  const h = await ticketsHarness({ orphanAfterMin: () => 0 });
  h.sessions.add({ id: 'old', workspaceId: WS, title: 'ClaudePilot: portal perf (T-2368)' });
  h.sessions.add({ id: 'other', workspaceId: WS, title: 'ClaudePilot: metrics portal (T-2360)' });
  h.sessions.add({ id: 'third', workspaceId: WS, title: 'Konfersi: lead' });
  const held = (sessionId: string, summary: string, status: 'in_progress' | 'in_review' = 'in_progress') => {
    const t = h.tickets.create(UI, { summary, workspaceId: WS });
    return h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId }, status }).id;
  };
  const t1 = held('old', 'urgent human request');
  const t2 = held('old', 'released, to close', 'in_review');
  const t3 = held('old', 'handed on on purpose after the fallback');
  const mine = held('other', 'other’s own work');
  h.sessions.setState('old', 'ended', 'integrity');
  const swept = h.tickets.sweepOrphans().moved;
  assert.deepEqual(
    swept.map((m) => [m.ticketId, m.to, m.reason]),
    [t1, t2, t3].map((id) => [id, 'other', 'title']),
    'the incident: the title fallback picks the unrelated live chat',
  );
  // After the fallback a person hands t3 on deliberately: that is kept.
  h.tickets.update(UI, t3, { assignee: { kind: 'session', sessionId: 'third' } });
  const holder = (id: string) => h.tickets.get(UI, id).ticket.assignee;
  const lastAssigned = (id: string) =>
    h.tickets
      .get(UI, id)
      .events.filter((e) => e.kind === 'assigned')
      .at(-1)!;
  return { ...h, t1, t2, t3, mine, holder, lastAssigned };
}

test('T-3220: a Keep going continuation created after a title fallback takes back its predecessor’s tickets; a later hand-off and the holder’s own stay', async () => {
  const r = await rig();
  try {
    r.sessions.add({ id: 'cont', workspaceId: WS, title: 'ClaudePilot: portal perf (T-2368)', continuedFrom: 'old' });
    const moved = r.tickets.continueFrom('cont', ['old']);
    assert.deepEqual(moved, [r.t1, r.t2], 'before the fix: [] (the tickets stayed with the unrelated chat)');
    for (const id of [r.t1, r.t2]) {
      assert.deepEqual(r.holder(id), { kind: 'session', sessionId: 'cont' });
      const e = r.lastAssigned(id);
      assert.equal(e.actor, 'system');
      assert.deepEqual(e.data, {
        from: { kind: 'session', sessionId: 'other' },
        to: { kind: 'session', sessionId: 'cont' },
        continued: true,
        heirOf: 'old',
      });
    }
    assert.equal(r.tickets.get(UI, r.t2).ticket.status, 'in_review', 'the status stays');
    assert.deepEqual(r.holder(r.t3), { kind: 'session', sessionId: 'third' }, 'a deliberate hand-off after the fallback is kept');
    assert.deepEqual(r.holder(r.mine), { kind: 'session', sessionId: 'other' }, 'the title holder’s own ticket stays');
    assert.deepEqual(r.tickets.continueFrom('cont', ['old']), [], 'a second call moves nothing');
  } finally {
    r.done();
  }
});

test('T-3220: ticket_adopt from the continuation takes back what the title fallback moved off its predecessor; adopting the live holder names the predecessor', async () => {
  const r = await rig();
  try {
    // A continuation that already existed (created before this fix, so its create moved nothing).
    r.sessions.add({ id: 'cont', workspaceId: WS, title: 'ClaudePilot: portal perf (T-2368)', continuedFrom: 'old' });
    const me = agent(WS, 'cont');
    assert.throws(
      () => r.tickets.adopt(me, 'other'),
      (e: { code?: string; message?: string }) => e.code === 'CONFLICT' && /ticket_adopt from_session old/.test(e.message ?? ''),
      'the live holder is still refused, but the answer says where to take them from',
    );
    assert.deepEqual(r.tickets.adoptPlan(me, 'old').tickets, [r.t1, r.t2], 'before the fix: [] (old holds nothing after the fallback)');
    const out = r.tickets.adopt(me, 'old');
    assert.deepEqual(out, { tickets: [r.t1, r.t2], why: 'lineage', from: 'old' });
    for (const id of [r.t1, r.t2]) {
      assert.deepEqual(r.holder(id), { kind: 'session', sessionId: 'cont' });
      const e = r.lastAssigned(id);
      assert.equal(e.actor, 'session:cont');
      assert.deepEqual(e.data, {
        from: { kind: 'session', sessionId: 'other' },
        to: { kind: 'session', sessionId: 'cont' },
        adopted: true,
        why: 'lineage',
        heirOf: 'old',
      });
    }
    // Now it may write to them (before: FORBIDDEN "assigned to another session").
    r.tickets.comment(me, r.t1, 'Progress from the continuation.');
    r.tickets.close(me, r.t2, { summary: 'Released and live-checked.' });
    assert.deepEqual(r.holder(r.t3), { kind: 'session', sessionId: 'third' });
    assert.deepEqual(r.holder(r.mine), { kind: 'session', sessionId: 'other' });
  } finally {
    r.done();
  }
});

test('T-3220: without a continuation nobody takes the title holder’s tickets: an orphan adopter of the ended chat gets none of them', async () => {
  const r = await rig();
  try {
    r.sessions.add({ id: 'stranger', workspaceId: WS, title: 'Someone: else' });
    const out = r.tickets.adopt(agent(WS, 'stranger'), 'old');
    assert.deepEqual(out, { tickets: [], why: 'orphan', from: 'old' });
    assert.deepEqual(r.holder(r.t1), { kind: 'session', sessionId: 'other' });
    assert.throws(() => r.tickets.adopt(agent(WS, 'stranger'), 'other'), /still live: it keeps its tickets/);
  } finally {
    r.done();
  }
});
