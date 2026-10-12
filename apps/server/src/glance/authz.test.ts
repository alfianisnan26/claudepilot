import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { objectRef, sessionRef, ticketRef, type Actor, type ChatRequest, type Owner } from '@portal/contracts';
import { anonymous, asUser, clearResolvers, declaredPolicies, ownerActor, registerResolver } from '../authz/seam.js';
import { declareGlancePolicies, glanceSources } from './authz.js';
import { buildSnapshot } from './build.js';
import { ago, fakeCi, HOUR, MIN, NOW, request, run, session, task, ticket, userActor } from './testkit.js';

// The glance across users (PLAN-10 M7): with the seam's resolvers registered for sessions, tickets and CI runs, user B cannot see, count or
// answer what belongs to user A through the glance, and a session shared with B at `view` shows to B but its requests are not B's to answer.

const user = (id: string): Owner => ({ kind: 'user', id });
const sessionOwner: Record<string, { owner: string; publicView?: boolean }> = { a1: { owner: 'u_a' }, b1: { owner: 'u_b' }, shared: { owner: 'u_a', publicView: true } };
const ticketOwner: Record<string, string> = { 'T-1': 'u_a', 'T-2': 'u_b' };
const runOwner: Record<string, string> = { RA: 'u_a', RB: 'u_b' };

before(() => {
  registerResolver({
    type: 'session',
    resolve: (id) => {
      const s = sessionOwner[id];
      return s ? { ref: sessionRef(id), owner: user(s.owner), ...(s.publicView ? { publicLevel: 'view' as const } : {}) } : null;
    },
  });
  registerResolver({ type: 'ticket', resolve: (id) => (ticketOwner[id] ? { ref: ticketRef(id), owner: user(ticketOwner[id]!) } : null) });
  registerResolver({ type: 'ci_run', resolve: (id) => (runOwner[id] ? { ref: objectRef('ci_run', id), owner: user(runOwner[id]!) } : null) });
});
after(() => clearResolvers());

const asking = (id: string, createdMinAgo: number): ChatRequest => request({ requestId: `q-${id}`, createdAt: ago(createdMinAgo * MIN), title: `Run a command for ${id}` });

function reads() {
  return glanceSources({
    chat: {
      list: () => [
        session({ id: 'a1', state: 'waiting', waiting: 1 }),
        session({ id: 'b1', state: 'waiting', waiting: 1 }),
        session({ id: 'shared', state: 'waiting', waiting: 1 }),
        session({ id: 'ghost', state: 'working' }), // a session no resolver knows: nobody's
      ],
      openRequests: (id) => [asking(id, 5)],
      tasks: (id) => [task({ taskId: `t-${id}`, description: `Task of ${id}` })],
    },
    tickets: { list: () => ({ items: [ticket({ id: 'T-1' }), ticket({ id: 'T-2' })], total: 2, counts: { byStatus: {} as never, needsYou: 2, unassigned: 0, total: 2 } }) },
    ci: fakeCi([
      run({ id: 'RA', repoId: 'r1', pipeline: 'ci', branch: 'main', status: 'failed', created: 3 * HOUR, finished: 2 * HOUR }),
      run({ id: 'RB', repoId: 'r2', pipeline: 'ci', branch: 'main', status: 'failed', created: 3 * HOUR, finished: HOUR }),
    ]),
  });
}

const snapshotFor = (actor: Actor) => buildSnapshot(reads(), actor, NOW);

test('user A sees A\'s sessions, requests, tickets and failed runs, and nothing of B\'s or of a session nobody owns', () => {
  const snap = snapshotFor(userActor('u_a'));
  // a1 and shared are A's; b1 is B's; ghost has no owner (default deny)
  assert.deepEqual(snap.sessions.items.map((s) => s.id).sort(), ['a1', 'shared']);
  assert.equal(snap.sessions.waiting, 2);
  assert.deepEqual(snap.attention.approvals.items.map((a) => a.sessionId).sort(), ['a1', 'shared']);
  assert.equal(snap.attention.approvals.count, 2);
  // T-2 is B's: hidden, and the count is only what A can see (1), not the portal's 2
  assert.deepEqual(snap.attention.tickets.items.map((t) => t.id), ['T-1']);
  assert.equal(snap.attention.tickets.count, 1);
  assert.deepEqual(snap.attention.ci.items.map((r) => r.id), ['RA']);
  assert.equal(snap.attention.ci.count, 1);
  assert.equal(snap.attention.count, 2 + 1 + 1);
  assert.deepEqual(snap.agents.rows.map((r) => r.key).sort(), ['a1', 'a1/t-a1', 'shared', 'shared/t-shared']);
});

test('user B sees B\'s own and what is shared with them at view, but cannot answer the shared session\'s requests', () => {
  const snap = snapshotFor(userActor('u_b'));
  assert.deepEqual(snap.sessions.items.map((s) => s.id).sort(), ['b1', 'shared']);
  // the shared session shows (view) and its tasks read (view), yet its request is A's to decide: not an item waiting on B
  assert.deepEqual(snap.attention.approvals.items.map((a) => a.sessionId), ['b1']);
  assert.equal(snap.attention.approvals.count, 1);
  assert.ok(snap.agents.rows.some((r) => r.key === 'shared/t-shared'), 'the shared session\'s agents are visible at view');
  assert.deepEqual(snap.attention.tickets.items.map((t) => t.id), ['T-2']);
  assert.deepEqual(snap.attention.ci.items.map((r) => r.id), ['RB']);
  assert.ok(!JSON.stringify(snap).includes('a1'), 'nothing of A\'s session ids anywhere in B\'s snapshot');
  assert.ok(!JSON.stringify(snap).includes('Run a command for a1'));
});

test('a third user sees only what is public: the shared session at view and none of its requests; nothing else', () => {
  const snap = snapshotFor(userActor('u_c'));
  assert.deepEqual(snap.sessions.items.map((s) => s.id), ['shared']);
  assert.equal(snap.attention.approvals.count, 0);
  assert.equal(snap.attention.tickets.count, 0);
  assert.equal(snap.attention.ci.count, 0);
});

test('the owner of the portal, the founding user, is a user like the others: no rights on what others own unless the type is ownerless', () => {
  // `u_owner` owns none of these fixtures: with resolvers registered, ownership decides (the seam's single-owner mode only falls back to "everything" for a type with no resolver)
  const snap = snapshotFor(ownerActor());
  assert.deepEqual(snap.sessions.items.map((s) => s.id), ['shared']);
});

test('no one is nobody: an anonymous actor gets an empty, readable snapshot, never an error and never anyone\'s data', () => {
  const snap = snapshotFor(anonymous());
  assert.deepEqual(snap.sessions.items, []);
  assert.equal(snap.attention.count, 0);
  assert.equal(snap.sessions.ok, true);
});

test('an agent\'s token sees only its own session', () => {
  const agent: Actor = { kind: 'agent', userId: 'u_a', tokenId: 'tok', sessionId: 'a1', workspaceId: 'docker/dev' };
  const snap = snapshotFor(agent);
  assert.deepEqual(snap.sessions.items.map((s) => s.id), ['a1']);
  assert.deepEqual(snap.attention.approvals.items.map((a) => a.sessionId), ['a1']);
});

test('a job acting for a user is held to that user\'s rights', () => {
  const snap = snapshotFor(asUser('u_b', 'notify'));
  assert.deepEqual(snap.sessions.items.map((s) => s.id).sort(), ['b1', 'shared']);
});

test('the route is declared: a signed-in route that lists what the actor may see', () => {
  declareGlancePolicies();
  assert.deepEqual(declaredPolicies().get('GET /api/glance'), { kind: 'signed-in', filter: 'session' });
  declareGlancePolicies(); // declaring twice with the same policy is fine
});
