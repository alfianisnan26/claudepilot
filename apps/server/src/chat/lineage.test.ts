// T-136 part E (data): the `continued_from` link, the one-time repair of the chains split on 2026-10-13, and the lineage read.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../store/migrations.js';
import { ticketsHarness, UI } from '../tickets/testkit.js';
import { lineageOf, repairSplitChains, SPLIT_CHAINS_2026_10_13 } from './lineage.js';
import { ChatStore } from './store.js';

const WS = 'kubernetes/kohi-event';
/** A full id with the given prefix, made at runtime (the rest random), as the real rows have. */
const idWith = (prefix: string) => `${prefix}${randomUUID().slice(prefix.length)}`;

function addSession(db: DatabaseSync, o: { id: string; state: string; cost?: number; pinnedAt?: string | null; ticketId?: string | null; createdAt: string; workspace?: string }) {
  db.prepare(
    `INSERT INTO chat_sessions (id, workspace_id, cwd, title, origin, state, state_since, created_at, last_activity_at, cost_est_usd, pinned_at, ticket_id)
     VALUES (?, ?, '/home/node/work/claudepilot', 'Orchestrator', 'ui', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.id, o.workspace ?? WS, o.state, o.createdAt, o.createdAt, o.createdAt, o.cost ?? 0, o.pinnedAt ?? null, o.ticketId ?? null);
}

/** The real chains' shape: three orchestrator rows (two ended for integrity, the head live) and two Konfersi rows. */
async function fixture() {
  const h = await ticketsHarness();
  const db = h.store.db!;
  const t0 = Date.now() - 6 * 3_600_000;
  const at = (hours: number) => new Date(t0 + hours * 3_600_000).toISOString();
  const [a, b, c] = SPLIT_CHAINS_2026_10_13[0]!.map(idWith);
  const [k1, k2] = SPLIT_CHAINS_2026_10_13[1]!.map(idWith);
  addSession(db, { id: a!, state: 'ended', cost: 40.5, pinnedAt: at(0.5), createdAt: at(0) });
  addSession(db, { id: b!, state: 'ended', cost: 66.46, ticketId: 'T-105', createdAt: at(2) });
  addSession(db, { id: c!, state: 'idle', cost: 3.25, createdAt: at(4) });
  addSession(db, { id: k1!, state: 'ended', cost: 12, createdAt: at(1), workspace: 'kubernetes/konfersi' });
  addSession(db, { id: k2!, state: 'idle', cost: 1, createdAt: at(3), workspace: 'kubernetes/konfersi' });
  // Tickets the ended rows held, and one the live head already holds.
  for (const id of [a!, b!, c!]) h.sessions.add({ id, workspaceId: WS });
  const held = (sessionId: string, summary: string) => {
    const t = h.tickets.create(UI, { summary });
    return h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId }, status: 'in_progress' }).id;
  };
  const tA = held(a!, 'held by the first row');
  const tB1 = held(b!, 'held by the second row');
  const tB2 = held(b!, 'also held by the second row');
  const tC = held(c!, 'held by the head');
  return { h, db, ids: { a: a!, b: b!, c: c!, k1: k1!, k2: k2! }, tickets: { tA, tB1, tB2, tC } };
}

test('migrations 770-772 exist once each, in the block of T-136', () => {
  for (const v of [770, 771, 772]) assert.equal(MIGRATIONS.filter((m) => m.version === v).length, 1, `migration ${v}`);
});

test('repair (T-136): the split chains are linked, the pin and the ticket link move to the head, and the ended rows’ tickets are the head’s', async () => {
  const { h, db, ids, tickets } = await fixture();
  try {
    const done = repairSplitChains(db);
    assert.deepEqual(
      done.map((d) => [d.ids, d.linked, d.pinMoved]),
      [
        [[ids.a, ids.b, ids.c], 2, true],
        [[ids.k1, ids.k2], 1, false],
      ],
    );
    const row = (id: string) => db.prepare('SELECT continued_from, pinned_at, ticket_id FROM chat_sessions WHERE id = ?').get(id) as { continued_from: string | null; pinned_at: string | null; ticket_id: string | null };
    assert.equal(row(ids.a).continued_from, null);
    assert.equal(row(ids.b).continued_from, ids.a);
    assert.equal(row(ids.c).continued_from, ids.b);
    assert.equal(row(ids.k2).continued_from, ids.k1);
    assert.ok(row(ids.c).pinned_at, 'the head is pinned');
    assert.equal(row(ids.a).pinned_at, null, 'the old row is not pinned any more');
    assert.equal(row(ids.c).ticket_id, 'T-105', 'the head takes the ticket link it lacked');

    // The ticket move, read through the tickets module: the head holds them, with an entry on each timeline.
    assert.deepEqual(done[0]!.ticketsMoved.sort(), [tickets.tA, tickets.tB1, tickets.tB2].sort());
    for (const id of [tickets.tA, tickets.tB1, tickets.tB2, tickets.tC]) {
      const t = h.tickets.get(UI, id);
      assert.deepEqual(t.ticket.assignee, { kind: 'session', sessionId: ids.c }, id);
    }
    const moved = h.tickets.get(UI, tickets.tB1).events.at(-1)!;
    assert.equal(moved.kind, 'assigned');
    assert.equal(moved.actor, 'system');
    assert.deepEqual(moved.data, { from: { kind: 'session', sessionId: ids.b }, to: { kind: 'session', sessionId: ids.c }, continued: true });
    assert.ok(!h.tickets.get(UI, tickets.tC).events.some((e) => e.data?.['continued'] === true), 'the head’s own ticket has no repair entry');

    // The lineage read: the chain from any row of it, and its cost summed.
    const chat = new ChatStore(h.store);
    for (const id of [ids.a, ids.b, ids.c]) {
      const l = chat.lineage(id)!;
      assert.equal(l.rootId, ids.a);
      assert.equal(l.headId, ids.c);
      assert.deepEqual(l.sessions.map((s) => s.id), [ids.a, ids.b, ids.c]);
      assert.equal(Math.round(l.costUsd * 100), 11021);
    }
    assert.equal(chat.toSession(chat.row(ids.c)!).continuedFrom, ids.b, 'exposed on the wire');
    assert.equal(chat.toSession(chat.row(ids.a)!).continuedFrom, null);

    // Once only: run again, nothing changes and nothing is written twice.
    const events = (db.prepare('SELECT count(*) AS n FROM ticket_events').get() as { n: number }).n;
    const again = repairSplitChains(db);
    assert.deepEqual(again.map((d) => [d.linked, d.ticketsMoved.length]), [[0, 0], [0, 0]]);
    assert.equal((db.prepare('SELECT count(*) AS n FROM ticket_events').get() as { n: number }).n, events);
  } finally {
    h.done();
  }
});

test('repair (T-136): a no-op on a database without the rows, with a prefix that matches two rows, or with rows in different workspaces', async () => {
  const empty = await ticketsHarness();
  try {
    assert.deepEqual(repairSplitChains(empty.store.db!), [], 'a scratch portal: nothing to link');
  } finally {
    empty.done();
  }
  const { h, db, ids } = await fixture();
  try {
    // A second row with the Konfersi head's prefix: that chain is ambiguous and left alone; the other is still repaired.
    addSession(db, { id: idWith(SPLIT_CHAINS_2026_10_13[1]![1]!), state: 'idle', createdAt: new Date().toISOString(), workspace: 'kubernetes/konfersi' });
    db.prepare('UPDATE chat_sessions SET workspace_id = ? WHERE id = ?').run('docker/elsewhere', ids.b);
    assert.deepEqual(repairSplitChains(db), [], 'neither chain resolves');
    assert.equal((db.prepare('SELECT count(*) AS n FROM chat_sessions WHERE continued_from IS NOT NULL').get() as { n: number }).n, 0);
  } finally {
    h.done();
  }
});

test('repair (T-136): a link already set elsewhere is never overwritten', async () => {
  const { h, db, ids } = await fixture();
  try {
    db.prepare('UPDATE chat_sessions SET continued_from = ? WHERE id = ?').run(ids.k1, ids.c);
    assert.deepEqual(repairSplitChains(db).map((d) => d.ids), [[ids.k1, ids.k2]]);
    assert.equal((db.prepare('SELECT continued_from FROM chat_sessions WHERE id = ?').get(ids.b) as { continued_from: string | null }).continued_from, null);
  } finally {
    h.done();
  }
});

test('lineage (T-136): a session that continues nothing is its own chain; a cycle stops; a deleted row ends the chain', async () => {
  const h = await ticketsHarness();
  try {
    const db = h.store.db!;
    const now = Date.now();
    const x = randomUUID();
    const y = randomUUID();
    addSession(db, { id: x, state: 'idle', cost: 2, createdAt: new Date(now - 1000).toISOString() });
    assert.deepEqual(lineageOf(db, x), { rootId: x, headId: x, sessions: [{ id: x, costUsd: 2, state: 'idle' }], costUsd: 2 });
    assert.equal(lineageOf(db, 'nope'), null);
    addSession(db, { id: y, state: 'idle', cost: 1, createdAt: new Date(now).toISOString() });
    db.prepare('UPDATE chat_sessions SET continued_from = ? WHERE id = ?').run(y, x);
    db.prepare('UPDATE chat_sessions SET continued_from = ? WHERE id = ?').run(x, y);
    assert.equal(lineageOf(db, x)!.sessions.length, 2, 'a cycle is walked once');
    const chat = new ChatStore(h.store);
    chat.deleteSession(x);
    assert.equal((db.prepare('SELECT continued_from FROM chat_sessions WHERE id = ?').get(y) as { continued_from: string | null }).continued_from, null);
  } finally {
    h.done();
  }
});
