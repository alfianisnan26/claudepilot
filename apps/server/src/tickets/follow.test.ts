// T-270: tickets follow the track. A continuation takes its ended predecessors' tickets; a live session may act on a ticket an ENDED session
// of its workspace holds when that session is in its lineage or has no live successor (FR9a, audited); ticket_adopt takes them all.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canActForEnded } from './authz.js';
import type { TicketAudit } from './service.js';
import { agent, ticketsHarness, UI } from './testkit.js';

const WS = 'kubernetes/kohi-event';

async function rig() {
  const h = await ticketsHarness();
  const audits: TicketAudit[] = [];
  h.tickets.onAudit = (e) => void audits.push(e);
  const held = (sessionId: string, summary: string, status: 'in_progress' | 'in_review' | 'blocked' = 'in_progress') => {
    // Assigning needs a live session: an ended one is assigned while it still ran.
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
  return { ...h, audits, held };
}

test('canActForEnded: lineage and orphan allow; a live holder, a person, a missing session, another workspace or a live successor refuse', () => {
  const actor = { id: 'c', workspaceId: WS, state: 'idle' };
  const ended = (id: string, workspaceId = WS) => ({ id, workspaceId, state: 'ended' });
  const base = { actor, holderKind: 'session' as const, actorAncestors: ['b', 'a'], holderHasLiveSuccessor: false };
  assert.deepEqual(canActForEnded({ ...base, holder: ended('b'), holderHasLiveSuccessor: true }), { allow: true, why: 'lineage' });
  assert.deepEqual(canActForEnded({ ...base, holder: ended('x') }), { allow: true, why: 'orphan' });
  assert.deepEqual(canActForEnded({ ...base, holder: ended('x'), holderHasLiveSuccessor: true }), { allow: false, why: 'live_successor' });
  assert.deepEqual(canActForEnded({ ...base, holder: { id: 'b', workspaceId: WS, state: 'idle' } }), { allow: false, why: 'live' });
  assert.deepEqual(canActForEnded({ ...base, holder: { id: 'b', workspaceId: WS, state: 'interrupted' } }), { allow: false, why: 'live' }, 'an interrupted session can be woken: it keeps its work');
  assert.deepEqual(canActForEnded({ ...base, holder: ended('b', 'docker/other') }), { allow: false, why: 'other_workspace' });
  assert.deepEqual(canActForEnded({ ...base, holder: null }), { allow: false, why: 'missing' });
  assert.deepEqual(canActForEnded({ ...base, holder: null, holderKind: 'user' }), { allow: false, why: 'not_a_session' });
  assert.deepEqual(canActForEnded({ ...base, actor: { ...actor, state: 'ended' }, holder: ended('b') }), { allow: false, why: 'actor_ended' });
});

test('continueFrom: the ended chain’s unfinished tickets go to the new session, one assigned entry each; closed and live ones stay', async () => {
  const r = await rig();
  try {
    r.sessions.add({ id: 'a', workspaceId: WS, state: 'ended' });
    r.sessions.add({ id: 'b', workspaceId: WS, state: 'ended', continuedFrom: 'a' });
    r.sessions.add({ id: 'live', workspaceId: WS, state: 'idle' });
    r.sessions.add({ id: 'c', workspaceId: WS, state: 'idle', continuedFrom: 'b' });
    const tA = r.held('a', 'from the root');
    const tB = r.held('b', 'from the predecessor', 'in_review');
    const tDone = r.held('b', 'finished');
    r.tickets.close(UI, tDone, { summary: 'done' });
    const tLive = r.held('live', 'a live session’s');

    const moved = r.tickets.continueFrom('c', ['b', 'a', 'live']);
    assert.deepEqual(moved.sort(), [tA, tB].sort());
    for (const [id, from, status] of [[tA, 'a', 'in_progress'], [tB, 'b', 'in_review']] as const) {
      const d = r.tickets.get(UI, id);
      assert.deepEqual(d.ticket.assignee, { kind: 'session', sessionId: 'c' });
      assert.equal(d.ticket.status, status, 'the status stays');
      const last = d.events.filter((e) => e.kind === 'assigned').at(-1)!;
      assert.equal(last.actor, 'system');
      assert.deepEqual(last.data, { from: { kind: 'session', sessionId: from }, to: { kind: 'session', sessionId: 'c' }, continued: true });
    }
    assert.deepEqual(r.tickets.get(UI, tDone).ticket.assignee, { kind: 'session', sessionId: 'b' }, 'a closed ticket keeps who did it');
    assert.deepEqual(r.tickets.get(UI, tLive).ticket.assignee, { kind: 'session', sessionId: 'live' }, 'a live session is never a source');
    assert.equal(r.audits.filter((a) => a.kind === 'ticket.continued').length, 1);
  } finally {
    r.done();
  }
});

test('FR9a: a continuation may comment, update and close a ticket its ended predecessor holds; each write is audited with lineage', async () => {
  const r = await rig();
  try {
    r.sessions.add({ id: 'a', workspaceId: WS, state: 'ended' });
    r.sessions.add({ id: 'b', workspaceId: WS, state: 'ended', continuedFrom: 'a' });
    r.sessions.add({ id: 'c', workspaceId: WS, state: 'idle', continuedFrom: 'b' });
    r.sessions.add({ id: 'd', workspaceId: WS, state: 'idle', continuedFrom: 'b' }); // a second continuation: a's successor is live, but c continues it
    const t = r.held('a', 'held by the root');
    const me = agent(WS, 'c');
    r.tickets.comment(me, t, 'Taking it on.');
    r.tickets.update(me, t, { status: 'blocked' });
    r.tickets.close(me, t, { summary: 'Done by the continuation.' });
    const rows = r.audits.filter((a) => a.kind === 'ticket.acted_for_ended');
    assert.deepEqual(rows.map((a) => [a.detail!.action, a.detail!.sessionId, a.detail!.forSession, a.detail!.why, a.actor]), [
      ['comment', 'c', 'a', 'lineage', 'session:c'],
      ['update', 'c', 'a', 'lineage', 'session:c'],
      ['close', 'c', 'a', 'lineage', 'session:c'],
    ]);
  } finally {
    r.done();
  }
});

test('FR9a: an orphan (ended, nobody continues it) is allowed and audited; an ended one with a live successor, a live one, a person’s and another workspace’s are refused', async () => {
  const r = await rig();
  try {
    r.sessions.add({ id: 'orphan', workspaceId: WS, state: 'ended' });
    r.sessions.add({ id: 'gone', workspaceId: WS, state: 'ended' });
    r.sessions.add({ id: 'heir', workspaceId: WS, state: 'idle', continuedFrom: 'gone' });
    r.sessions.add({ id: 'busy', workspaceId: WS, state: 'working' });
    r.sessions.add({ id: 'far', workspaceId: 'docker/other', state: 'ended' });
    r.sessions.add({ id: 'me', workspaceId: WS, state: 'idle' });
    const tOrphan = r.held('orphan', 'orphaned');
    const tGone = r.held('gone', 'its heir is live');
    const tBusy = r.held('busy', 'a live session’s');
    const person = r.tickets.create(UI, { summary: 'for a person', workspaceId: WS, assignee: { kind: 'user', name: 'Admin' } }).id;
    const far = r.held('far', 'elsewhere');
    const me = agent(WS, 'me');

    r.tickets.comment(me, tOrphan, 'Picked up.');
    assert.deepEqual(r.audits.filter((a) => a.kind === 'ticket.acted_for_ended').map((a) => [a.detail!.forSession, a.detail!.why]), [['orphan', 'orphan']]);

    assert.throws(() => r.tickets.comment(me, tGone, 'x'), /assigned to another session/);
    assert.throws(() => r.tickets.update(me, tBusy, { status: 'blocked' }), /assigned to another session/);
    assert.throws(() => r.tickets.close(me, tBusy, { summary: 'x' }), /assigned to another session/);
    assert.throws(() => r.tickets.update(me, person, { status: 'blocked' }), /assigned to a person/);
    assert.throws(() => r.tickets.comment(me, far, 'x'), /No such ticket/, 'another workspace’s ticket does not exist for it');
    // The heir itself may: it continues `gone`.
    r.tickets.comment(agent(WS, 'heir'), tGone, 'Mine by lineage.');
    assert.equal(r.audits.filter((a) => a.kind === 'ticket.acted_for_ended').length, 2);
  } finally {
    r.done();
  }
});

test('adopt: takes an ended session’s unfinished tickets (lineage or orphan); refuses a live one, a live successor’s and another workspace', async () => {
  const r = await rig();
  try {
    r.sessions.add({ id: 'old', workspaceId: WS, state: 'ended' });
    r.sessions.add({ id: 'me', workspaceId: WS, state: 'idle', continuedFrom: 'old' });
    r.sessions.add({ id: 'busy', workspaceId: WS, state: 'idle' });
    r.sessions.add({ id: 'gone', workspaceId: WS, state: 'ended' });
    r.sessions.add({ id: 'heir', workspaceId: WS, state: 'idle', continuedFrom: 'gone' });
    r.sessions.add({ id: 'far', workspaceId: 'docker/other', state: 'ended' });
    const t1 = r.held('old', 'one');
    const t2 = r.held('old', 'two', 'in_review');
    r.held('busy', 'live');
    r.held('gone', 'heir’s');
    const me = agent(WS, 'me');

    assert.deepEqual(r.tickets.adoptPlan(me, 'old').tickets, [t1, t2]);
    const out = r.tickets.adopt(me, 'old');
    assert.deepEqual(out, { tickets: [t1, t2], why: 'lineage', from: 'old' });
    assert.equal(r.tickets.get(UI, t2).ticket.status, 'in_review', 'the status stays');
    const e = r.tickets.get(UI, t1).events.filter((x) => x.kind === 'assigned').at(-1)!;
    assert.equal(e.actor, 'session:me');
    assert.deepEqual(e.data, { from: { kind: 'session', sessionId: 'old' }, to: { kind: 'session', sessionId: 'me' }, adopted: true, why: 'lineage' });
    const audit = r.audits.find((a) => a.kind === 'ticket.adopted')!;
    assert.deepEqual(audit.detail, { sessionId: 'me', forSession: 'old', why: 'lineage', tickets: [t1, t2] });

    assert.throws(() => r.tickets.adopt(me, 'busy'), (err: { code?: string }) => err.code === 'CONFLICT');
    assert.throws(() => r.tickets.adopt(me, 'gone'), (err: { code?: string }) => err.code === 'FORBIDDEN');
    assert.throws(() => r.tickets.adopt(me, 'far'), (err: { code?: string }) => err.code === 'NOT_FOUND');
    assert.throws(() => r.tickets.adopt(me, 'nobody'), (err: { code?: string }) => err.code === 'NOT_FOUND');
    assert.deepEqual(r.tickets.adopt(me, 'old').tickets, [], 'a second call moves nothing');
  } finally {
    r.done();
  }
});
