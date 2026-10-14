// T-270: a session created as the continuation of an ended one is linked to it (continued_from) and takes the tickets of the ended chain in
// the same transaction; a live predecessor, or one in another workspace, is refused (409) and nothing is created or moved.

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { Tickets } from '../tickets/service.js';
import { ChatTicketSessions } from '../tickets/sessions.js';
import type { Workspaces } from '../workspaces/manager.js';
import { ChatController } from './controller.js';
import { FakeWorkspaces, freshStore, until } from './testkit.js';

const WS = 'docker/ws1';

async function rig() {
  const { store, dataDir } = await freshStore();
  const controller = new ChatController(store, new FakeWorkspaces() as unknown as Workspaces);
  // No host: every session ends at once after it is created, which is what a predecessor needs to be.
  controller.installHost = async () => {
    throw new Error('no host in this test');
  };
  const tickets = new Tickets(store, new ChatTicketSessions(controller));
  controller.continueTickets = (to, from) => tickets.continueFrom(to, from);
  const db = store.db!;
  const setState = (id: string, state: string) => db.prepare('UPDATE chat_sessions SET state = ? WHERE id = ?').run(state, id);
  /** A ticket assigned to a session (assigned while it ran: an ended session can't be assigned). */
  const held = (sessionId: string, summary: string) => {
    const before = controller.get(sessionId)!.state;
    setState(sessionId, 'idle');
    const t = tickets.create({ kind: 'ui' }, { summary });
    const id = tickets.update({ kind: 'ui' }, t.id, { assignee: { kind: 'session', sessionId }, status: 'in_progress' }).id;
    setState(sessionId, before);
    return id;
  };
  const ended = async (req: { continuedFrom?: string; workspaceId?: string } = {}) => {
    const s = await controller.create({ workspaceId: req.workspaceId ?? WS, title: 'Orchestrator', ...(req.continuedFrom ? { continuedFrom: req.continuedFrom } : {}) });
    await until(() => controller.get(s.id)?.state === 'ended');
    return s.id;
  };
  const done = () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { controller, tickets, db, setState, held, ended, done };
}

test('continuation: links continued_from and moves the tickets of the whole ended chain, one assigned entry each, in one step', async () => {
  const r = await rig();
  try {
    const a = await r.ended();
    const tA = r.held(a, 'held by the root');
    const b = await r.ended({ continuedFrom: a });
    assert.equal(r.controller.get(b)!.continuedFrom, a);
    assert.deepEqual(r.tickets.get({ kind: 'ui' }, tA).ticket.assignee, { kind: 'session', sessionId: b }, 'the first continuation took it');
    const tB = r.held(b, 'held by the second');
    // A ticket left on the root after the fact (a person put it there): the chain walk still finds it.
    const tA2 = r.held(a, 'late on the root');

    const c = await r.controller.create({ workspaceId: WS, title: 'Orchestrator', continuedFrom: b });
    assert.equal(r.controller.get(c.id)!.continuedFrom, b);
    for (const [t, from] of [[tB, b], [tA2, a]] as const) {
      const d = r.tickets.get({ kind: 'ui' }, t);
      assert.deepEqual(d.ticket.assignee, { kind: 'session', sessionId: c.id });
      assert.equal(d.ticket.status, 'in_progress');
      const e = d.events.filter((x) => x.kind === 'assigned').at(-1)!;
      assert.equal(e.actor, 'system');
      assert.deepEqual(e.data, { from: { kind: 'session', sessionId: from }, to: { kind: 'session', sessionId: c.id }, continued: true });
    }
    const audit = r.controller.audit({ limit: 50 }).find((x) => x.kind === 'session.continued' && x.sessionId === c.id);
    assert.ok(audit, 'the continuation is audited');
    assert.deepEqual((audit!.detail as { tickets: string[] }).tickets.sort(), [tA, tA2, tB].sort(), 'what the first continuation took goes on with the track');
  } finally {
    r.done();
  }
});

test('continuation: a live predecessor is refused with 409, nothing is created and no ticket moves; so is another workspace’s', async () => {
  const r = await rig();
  try {
    const a = await r.ended();
    const t = r.held(a, 'held by a');
    r.setState(a, 'idle');
    const count = () => (r.db.prepare('SELECT count(*) AS n FROM chat_sessions').get() as { n: number }).n;
    const before = count();
    await assert.rejects(r.controller.create({ workspaceId: WS, continuedFrom: a }), (e: { code?: string; status?: number }) => e.code === 'CONFLICT');
    assert.equal(count(), before, 'no session row');
    assert.deepEqual(r.tickets.get({ kind: 'ui' }, t).ticket.assignee, { kind: 'session', sessionId: a });

    r.setState(a, 'ended');
    await assert.rejects(r.controller.create({ workspaceId: 'docker/ws2', continuedFrom: a }), (e: { code?: string }) => e.code === 'CONFLICT');
    await assert.rejects(r.controller.create({ workspaceId: WS, continuedFrom: 'no-such-session' }), (e: { code?: string }) => e.code === 'NOT_FOUND');
    assert.equal(count(), before);
    assert.deepEqual(r.tickets.get({ kind: 'ui' }, t).ticket.assignee, { kind: 'session', sessionId: a });
  } finally {
    r.done();
  }
});

test('continuation: the link and the move are one transaction: a move that fails leaves no session row', async () => {
  const r = await rig();
  try {
    const a = await r.ended();
    const count = () => (r.db.prepare('SELECT count(*) AS n FROM chat_sessions').get() as { n: number }).n;
    const before = count();
    r.controller.continueTickets = () => {
      throw new Error('the tickets could not move');
    };
    await assert.rejects(r.controller.create({ workspaceId: WS, continuedFrom: a }), /could not move/);
    assert.equal(count(), before);
  } finally {
    r.done();
  }
});

test('the supervisor’s start again names the session it continues (docs/dev-sessions/supervisor.mjs createBody)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../../../docs/dev-sessions/supervisor.mjs', import.meta.url), 'utf8');
  const line = src.split('\n').find((l) => l.startsWith('const createBody = '));
  assert.ok(line, 'createBody is one line the test can read');
  const createBody = new Function('WORKSPACE', 'MAIN', `${line}\nreturn createBody;`)('kubernetes/kohi-event', '/home/node/work/claudepilot') as (t: object, claudeId: string, from: string | null) => Record<string, unknown>;
  const t = { title: 'Orchestrator: ClaudePilot dev' };
  assert.deepEqual(createBody(t, 'c1', 'prev-id'), { workspaceId: 'kubernetes/kohi-event', title: t.title, claudeId: 'c1', allowBypass: true, cwd: '/home/node/work/claudepilot', continuedFrom: 'prev-id' });
  assert.equal('continuedFrom' in createBody(t, 'c1', null), false, 'a first start continues nothing');
  assert.match(src, /startSession\(t, ts, !!cur, [^\n]*cur\?\.state === 'ended' \? cur\.id : null\)/, 'the start-again path passes the ended session');
});
