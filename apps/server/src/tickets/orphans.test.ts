// T-270 layers 2 and 3: the orphan sweep. A ticket whose session is dead (ended, archived, gone) for `tickets.orphanAfterMin` moves by
// itself: to the track's live successor (lineage, then the title prefix), else back to the agents' queue. On a fake clock throughout.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TICKET_SETTING_KEYS } from '@portal/contracts';
import type { NotifyBus } from '../notify/bus.js';
import { adaptTickets } from '../notify/adapters/tickets.js';
import { settingDef } from '../settings/registry.js';
import { OrphanSweep } from './orphans.js';
import { ORPHAN_QUEUE_COMMENT, Tickets, titlePrefix, type TicketAudit } from './service.js';
import { ticketsHarness, UI } from './testkit.js';

const WS = 'kubernetes/kohi-event';
const MIN = 60_000;

async function rig(opts: { afterMin?: number } = {}) {
  // A fake clock that starts at the real "now" (no fixed date) and moves only when a test says so.
  let at = Date.now();
  const now = () => new Date(at);
  let afterMin = opts.afterMin ?? 3;
  const h = await ticketsHarness({ now, orphanAfterMin: () => afterMin });
  const audits: TicketAudit[] = [];
  h.tickets.onAudit = (e) => void audits.push(e);
  const held = (sessionId: string, summary: string, status: 'open' | 'in_progress' | 'in_review' | 'blocked' = 'in_progress') => {
    const s = h.sessions.sessions.get(sessionId)!;
    const state = s.state;
    s.state = 'idle';
    try {
      const t = h.tickets.create(UI, { summary, workspaceId: s.workspaceId });
      return h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId }, status }).id;
    } finally {
      s.state = state;
    }
  };
  const ticket = (id: string) => h.tickets.get(UI, id).ticket;
  const lastAssigned = (id: string) => h.tickets.get(UI, id).events.filter((e) => e.kind === 'assigned').at(-1)!;
  return {
    ...h,
    audits,
    held,
    ticket,
    lastAssigned,
    advance: (ms: number) => void (at += ms),
    setAfter: (m: number) => void (afterMin = m),
    now,
  };
}

test('titlePrefix: the text before the first ":"; none without one', () => {
  assert.equal(titlePrefix('Orchestrator: ClaudePilot dev'), 'Orchestrator');
  assert.equal(titlePrefix('Orchestrator'), null);
  assert.equal(titlePrefix(': nothing before'), null);
  assert.equal(titlePrefix(null), null);
});

test('a session ends with 3 tickets: orphans within the delay (shown, filtered, counted), then moved to the lineage successor, statuses kept, audited', async () => {
  const r = await rig();
  try {
    r.sessions.add({ id: 'a', workspaceId: WS, title: 'Worker: one' });
    r.sessions.add({ id: 'heir', workspaceId: WS, continuedFrom: 'a', title: 'Something else' });
    const ids = [r.held('a', 'one'), r.held('a', 'two', 'in_review'), r.held('a', 'three', 'blocked')];
    r.sessions.setState('a', 'ended', 'crashed');
    const endedAt = r.now().toISOString();

    r.advance(2 * MIN);
    assert.deepEqual(r.tickets.sweepOrphans(), { moved: [], waiting: 3 }, 'not before the delay');
    assert.deepEqual(r.ticket(ids[0]!).orphan, { since: endedAt, sessionId: 'a', why: 'ended' }, 'never silent: the ticket says its session ended, and when');
    const list = r.tickets.list(UI, { orphan: true });
    assert.deepEqual(list.items.map((t) => t.id).sort(), [...ids].sort());
    assert.equal(list.counts.orphans, 3);

    r.advance(1 * MIN);
    const out = r.tickets.sweepOrphans();
    assert.deepEqual(out.moved.map((m) => [m.ticketId, m.from, m.to, m.reason]), ids.map((id) => [id, 'a', 'heir', 'lineage']));
    assert.deepEqual(ids.map((id) => r.ticket(id).status), ['in_progress', 'in_review', 'blocked']);
    for (const id of ids) {
      const t = r.ticket(id);
      assert.deepEqual(t.assignee, { kind: 'session', sessionId: 'heir' });
      assert.equal(t.orphan, null);
      const e = r.lastAssigned(id);
      assert.equal(e.actor, 'system');
      assert.deepEqual(e.data, { from: { kind: 'session', sessionId: 'a' }, to: { kind: 'session', sessionId: 'heir' }, fallback: true, reason: 'lineage', holder: 'ended' });
    }
    const rows = r.audits.filter((a) => a.kind === 'ticket.fallback');
    assert.equal(rows.length, 3, 'one audit row per move');
    assert.deepEqual(rows[0], { kind: 'ticket.fallback', actor: 'system', userId: rows[0]!.userId, subject: `ticket:${ids[0]}`, detail: { ticketId: ids[0], from: 'a', to: 'heir', reason: 'lineage', holder: 'ended' } });
    assert.equal(r.tickets.list(UI, { orphan: true }).total, 0);
    assert.deepEqual(r.tickets.sweepOrphans().moved, [], 'a second pass moves nothing');
  } finally {
    r.done();
  }
});

test('lineage through ended links: the nearest live session down the chain takes it', async () => {
  const r = await rig();
  try {
    r.sessions.add({ id: 'a', workspaceId: WS });
    r.sessions.add({ id: 'b', workspaceId: WS, state: 'ended', continuedFrom: 'a' });
    r.sessions.add({ id: 'c', workspaceId: WS, continuedFrom: 'b' });
    const t = r.held('a', 'deep');
    r.sessions.setState('a', 'ended');
    r.advance(3 * MIN);
    assert.deepEqual(r.tickets.sweepOrphans().moved.map((m) => [m.to, m.reason]), [['c', 'lineage']]);
    assert.deepEqual(r.ticket(t).assignee, { kind: 'session', sessionId: 'c' });
  } finally {
    r.done();
  }
});

test('no lineage: the live session of the same workspace with the same title prefix takes it; another workspace or a title without ":" never', async () => {
  const r = await rig();
  try {
    r.sessions.add({ id: 'orch', workspaceId: WS, title: 'Orchestrator: ClaudePilot dev' });
    r.sessions.add({ id: 'far', workspaceId: 'docker/other', title: 'Orchestrator: ClaudePilot dev', lastActivityAt: new Date(Date.now() + 9 * MIN).toISOString() });
    r.sessions.add({ id: 'worker', workspaceId: WS, title: 'Worker: ClaudePilot dev' });
    r.sessions.add({ id: 'orch2', workspaceId: WS, title: 'Orchestrator: ClaudePilot dev (restarted)' });
    r.sessions.add({ id: 'plain', workspaceId: WS, title: 'Orchestrator' });
    r.sessions.add({ id: 'plain2', workspaceId: WS, title: 'Orchestrator' });
    const t = r.held('orch', 'track work', 'in_progress');
    const u = r.held('plain', 'no colon', 'in_progress');
    r.sessions.setState('orch', 'ended');
    r.sessions.setState('plain', 'ended');
    r.advance(3 * MIN);
    const moved = r.tickets.sweepOrphans().moved;
    assert.deepEqual(moved.find((m) => m.ticketId === t), { ticketId: t, from: 'orch', to: 'orch2', reason: 'title', holder: 'ended' });
    assert.deepEqual(moved.find((m) => m.ticketId === u), { ticketId: u, from: 'plain', to: null, reason: 'queue', holder: 'ended' }, 'a title with no ":" matches nothing');
  } finally {
    r.done();
  }
});

test('no successor: back to the queue unassigned, in_progress becomes open, in_review and blocked stay, notes kept, one system comment', async () => {
  const r = await rig();
  try {
    r.sessions.add({ id: 'gone', workspaceId: WS, title: 'Lonely: track' });
    const ids = [r.held('gone', 'doing'), r.held('gone', 'reviewing', 'in_review'), r.held('gone', 'stuck', 'blocked')];
    r.tickets.comment(UI, ids[0]!, 'A note that stays.');
    r.sessions.setState('gone', 'ended');
    r.advance(3 * MIN);
    const out = r.tickets.sweepOrphans();
    assert.deepEqual(out.moved.map((m) => [m.to, m.reason]), [[null, 'queue'], [null, 'queue'], [null, 'queue']]);
    assert.deepEqual(ids.map((id) => r.ticket(id).status), ['open', 'in_review', 'blocked']);
    for (const id of ids) {
      const d = r.tickets.get(UI, id);
      assert.equal(d.ticket.assignee, null);
      const comments = d.events.filter((e) => e.kind === 'comment');
      assert.equal(comments.filter((c) => c.body === ORPHAN_QUEUE_COMMENT && c.actor === 'system').length, 1);
      assert.deepEqual(r.lastAssigned(id).data, { from: { kind: 'session', sessionId: 'gone' }, to: null, fallback: true, reason: 'queue', holder: 'ended' });
    }
    const first = r.tickets.get(UI, ids[0]!).events;
    assert.ok(first.some((e) => e.kind === 'comment' && e.body === 'A note that stays.'));
    assert.deepEqual(first.find((e) => e.kind === 'status' && e.data?.fallback)?.data, { from: 'in_progress', to: 'open', fallback: true });
    assert.deepEqual(r.audits.filter((a) => a.kind === 'ticket.fallback').map((a) => [a.detail!.from, a.detail!.to, a.detail!.reason]), [['gone', null, 'queue'], ['gone', null, 'queue'], ['gone', null, 'queue']]);
    assert.equal(r.tickets.list(UI, { assignee: 'unassigned' }).total, 3);
  } finally {
    r.done();
  }
});

test('never touched: a live (or interrupted) session’s tickets, a person’s ticket, a closed ticket', async () => {
  const r = await rig();
  try {
    r.sessions.add({ id: 'live', workspaceId: WS, state: 'working' });
    r.sessions.add({ id: 'nap', workspaceId: WS, state: 'interrupted' });
    r.sessions.add({ id: 'dead', workspaceId: WS, state: 'idle' });
    const tLive = r.held('live', 'live');
    const tNap = r.held('nap', 'interrupted can be woken');
    const tDone = r.held('dead', 'finished');
    r.tickets.close(UI, tDone, { summary: 'done' });
    const person = r.tickets.create(UI, { summary: 'for a person', workspaceId: WS, assignee: { kind: 'user', name: 'Admin' } }).id;
    r.sessions.setState('dead', 'ended');
    r.advance(60 * MIN);
    assert.deepEqual(r.tickets.sweepOrphans(), { moved: [], waiting: 0 });
    r.advance(60 * MIN);
    assert.deepEqual(r.tickets.sweepOrphans().moved, []);
    assert.deepEqual(r.ticket(tLive).assignee, { kind: 'session', sessionId: 'live' });
    assert.deepEqual(r.ticket(tNap).assignee, { kind: 'session', sessionId: 'nap' });
    assert.deepEqual(r.ticket(tDone).assignee, { kind: 'session', sessionId: 'dead' }, 'a closed ticket keeps who did it');
    assert.deepEqual(r.ticket(person).assignee, { kind: 'user', name: 'Admin' });
    assert.equal(r.ticket(tLive).orphan, null);
    assert.equal(r.audits.filter((a) => a.kind === 'ticket.fallback').length, 0);
  } finally {
    r.done();
  }
});

test('in-place recovery (T-136, same id): ended then live again within the delay is not swept; a later end starts the delay again', async () => {
  const r = await rig();
  try {
    r.sessions.add({ id: 'me', workspaceId: WS });
    const t = r.held('me', 'mine');
    r.sessions.setState('me', 'ended', 'integrity');
    r.advance(1 * MIN);
    r.tickets.sweepOrphans();
    r.sessions.setState('me', 'idle');
    assert.equal(r.ticket(t).orphan, null);
    r.advance(10 * MIN);
    assert.deepEqual(r.tickets.sweepOrphans(), { moved: [], waiting: 0 });
    r.sessions.setState('me', 'ended');
    r.advance(2 * MIN);
    assert.deepEqual(r.tickets.sweepOrphans(), { moved: [], waiting: 1 }, 'the delay counts from the new end, not the old one');
    r.advance(1 * MIN);
    assert.equal(r.tickets.sweepOrphans().moved.length, 1);
  } finally {
    r.done();
  }
});

test('archived and missing sessions are dead too: the sweep notes when it first saw them and moves after the delay', async () => {
  const r = await rig();
  try {
    r.sessions.add({ id: 'arch', workspaceId: WS });
    r.sessions.add({ id: 'del', workspaceId: WS });
    const tA = r.held('arch', 'archived');
    const tD = r.held('del', 'deleted');
    r.sessions.sessions.get('arch')!.state = 'ended';
    r.sessions.sessions.get('arch')!.archivedAt = r.now().toISOString();
    r.sessions.sessions.delete('del');
    assert.deepEqual(r.ticket(tD).orphan, { since: null, sessionId: 'del', why: 'missing' }, 'unknown until the sweep looks');
    const seen = r.now().toISOString();
    assert.equal(r.tickets.sweepOrphans().waiting, 2);
    assert.deepEqual(r.ticket(tD).orphan, { since: seen, sessionId: 'del', why: 'missing' });
    assert.equal(r.ticket(tA).orphan?.why, 'archived');
    r.advance(3 * MIN);
    assert.deepEqual(r.tickets.sweepOrphans().moved.map((m) => [m.ticketId, m.holder, m.reason]).sort(), [[tA, 'archived', 'queue'], [tD, 'missing', 'queue']].sort());
  } finally {
    r.done();
  }
});

test('the delay setting: registered with its InfoTip (default 3), and a longer delay holds the move', async () => {
  const def = settingDef(TICKET_SETTING_KEYS.orphanAfterMin);
  assert.equal(def?.default, 3);
  assert.equal(def?.type, 'number');
  assert.ok(def?.help && def.help.length > 20);
  const r = await rig({ afterMin: 10 });
  try {
    r.sessions.add({ id: 'x', workspaceId: WS });
    r.held('x', 'waits');
    r.sessions.setState('x', 'ended');
    r.advance(9 * MIN);
    assert.equal(r.tickets.sweepOrphans().moved.length, 0);
    r.setAfter(5);
    assert.equal(r.tickets.sweepOrphans().moved.length, 1, 'read at every pass');
  } finally {
    r.done();
  }
});

test('bounded and restart safe: a pass moves at most `max`; a new portal on the same database keeps the delay and finishes the rest', async () => {
  const r = await rig();
  try {
    r.sessions.add({ id: 'a', workspaceId: WS });
    const ids = [r.held('a', '1'), r.held('a', '2'), r.held('a', '3')];
    r.sessions.setState('a', 'ended');
    r.advance(2 * MIN);
    r.tickets.sweepOrphans();
    // The portal restarts here: a new service on the same store; its clock is a minute on, so only the delay noted before can be due.
    r.advance(1 * MIN);
    const again = new Tickets(r.store, r.sessions, { now: r.now, orphanAfterMin: () => 3 });
    assert.equal(again.orphanLastRun(), new Date(r.now().getTime() - MIN).toISOString(), 'the last pass is in the database');
    assert.equal(again.sweepOrphans({ max: 2 }).moved.length, 2, 'bounded');
    // ... and restarts again in the middle.
    const third = new Tickets(r.store, r.sessions, { now: r.now, orphanAfterMin: () => 3 });
    assert.deepEqual(third.sweepOrphans().moved.map((m) => m.ticketId), [ids[2]]);
    assert.deepEqual(ids.map((id) => r.ticket(id).assignee), [null, null, null]);
  } finally {
    r.done();
  }
});

test('the sweep sends no notification and creates no ticket, no session, no message', async () => {
  const r = await rig();
  try {
    const emitted: unknown[] = [];
    const bus = { emit: (e: unknown) => (emitted.push(e), null) } as unknown as NotifyBus;
    adaptTickets(r.tickets, bus, { info: () => ({ type: 'task', workspaceId: WS, open: true }) });
    r.sessions.add({ id: 'a', workspaceId: WS });
    r.sessions.add({ id: 'b', workspaceId: WS, continuedFrom: 'a' });
    r.sessions.add({ id: 'c', workspaceId: WS });
    r.held('a', 'to the heir');
    r.held('c', 'to the queue', 'in_review');
    r.sessions.setState('a', 'ended');
    r.sessions.setState('c', 'ended');
    const before = r.tickets.counts(UI).total;
    r.advance(3 * MIN);
    assert.equal(r.tickets.sweepOrphans().moved.length, 2);
    await new Promise((res) => setImmediate(res));
    assert.equal(r.tickets.counts(UI).total, before, 'no ticket made (no needs-a-person request)');
    assert.deepEqual(emitted, []);
    assert.deepEqual(r.sessions.created, []);
    assert.deepEqual(r.sessions.sent, []);
  } finally {
    r.done();
  }
});

test('the loop: the first pass waits for the rest of the minute since the last one, then one pass a minute (jittered) until stopped', () => {
  let at = Date.now();
  const timers: { fn: () => void; ms: number }[] = [];
  let passes = 0;
  let last: string | null = new Date(at - 20_000).toISOString();
  const loop = new OrphanSweep(
    {
      orphanLastRun: () => last,
      sweepOrphans: () => {
        passes++;
        last = new Date(at).toISOString();
        return { moved: [], waiting: 0 };
      },
    },
    { now: () => new Date(at), random: () => 0.5, jitterMs: 10_000, setTimer: (fn, ms) => (timers.push({ fn, ms }), {}), clearTimer: () => {} },
  );
  loop.start();
  assert.equal(timers[0]!.ms, 40_000 + 5_000);
  at += 45_000;
  timers[0]!.fn();
  assert.equal(passes, 1);
  assert.equal(timers[1]!.ms, 60_000 + 5_000);
  loop.stop();
  timers[1]!.fn();
  assert.equal(passes, 1, 'stopped: no pass');
  last = null;
  const fresh = new OrphanSweep({ orphanLastRun: () => last, sweepOrphans: () => ({ moved: [], waiting: 0 }) }, { random: () => 0, setTimer: (fn, ms) => (timers.push({ fn, ms }), {}) });
  fresh.start();
  assert.equal(timers.at(-1)!.ms, 0, 'never ran: now');
});
