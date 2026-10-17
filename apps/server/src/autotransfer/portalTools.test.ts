// `autotransfer_events` over the real Portal MCP endpoint (T-968 S2a, general-manager PRD §9.1). Allowed: a read token sees its trail
// newest first, whether its latest move can still be undone, and the cards waiting. Denied: a chat of another user answers exactly like a
// missing one (NOT_FOUND, same bytes), and no row of such a chat is listed even when the trail holds one (each row goes through can());
// an agent's token never reaches it.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { FOUNDING_USER_ID, objectRef, type AutoSessionState, type AutoTransferEvent, type UserId } from '@portal/contracts';
import { clearResolvers, registerResolver } from '../authz/seam.js';
import { fakeOwner } from '../notify/testkit.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { AUTOTRANSFER_TOOL_POLICIES, declareAutoTransferPolicies } from './authz.js';
import { registerAutoTransferTools } from './portalTools.js';
import { AutoStore } from './store.js';

declareAutoTransferPolicies();
after(() => clearResolvers());

const U_B = 'u_b' as UserId;
const T0 = Date.parse('2026-10-17T12:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function owners(rows: Record<string, UserId>) {
  registerResolver({ type: 'session', resolve: (id) => (rows[id] ? { ref: objectRef('session', id), owner: { kind: 'user', id: rows[id]! }, attrs: { workspaceId: 'docker/dev' } } : null) });
}

async function build(undoOk: Record<string, boolean> = {}) {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const store = new AutoStore(h.store, () => new Date(T0));
  const looked: string[] = [];
  const engine = {
    async state(sessionId: string) {
      looked.push(sessionId);
      const [last] = store.events(FOUNDING_USER_ID, { session: sessionId, kinds: ['moved'], limit: 1 });
      return { lastMove: last ? { event: last, undo: { ok: undoOk[sessionId] ?? false, reason: null } } : null } as AutoSessionState;
    },
  };
  registerAutoTransferTools({ engine, store, owner: fakeOwner({}) }, registry);
  const event = (sessionId: string, kind: AutoTransferEvent['kind'], min: number) =>
    store.addEvent({ at: at(min), userId: FOUNDING_USER_ID, sessionId, workspaceId: 'docker/dev', kind, mode: 'auto', reason: 'low', from: { id: 'work', name: 'Work' }, to: { id: 'home', name: 'Home' }, facts: null, handoff: null, handoffId: null, code: null, actor: 'portal:autotransfer' });
  const card = (sessionId: string) =>
    store.addSuggestion({ ownerId: FOUNDING_USER_ID, sessionId, reason: 'low', from: { id: 'work', name: 'Work' }, to: { id: 'home', name: 'Home' }, alternatives: [], facts: {} as never, handoff: 'ask', dropped: { approvals: 0, queued: 0, agents: 0 }, why: null });
  return { h, event, card, looked };
}

test('allowed: the trail newest first, only the latest move undoable, and the cards waiting', async () => {
  const { h, event, card } = await build({ s_1: true });
  try {
    owners({ s_1: FOUNDING_USER_ID, s_2: FOUNDING_USER_ID });
    event('s_1', 'moved', -50);
    event('s_1', 'moved', -10);
    event('s_2', 'declined', -5);
    const c = card('s_2');
    const read = h.token('read').secret;
    const r = await h.call(read, 'autotransfer_events', {});
    assert.equal(r.result?.isError, undefined, JSON.stringify(r.raw));
    const rows = r.result!.structuredContent.events as { session_id: string; kind: string; undoable: boolean | null; from: string; to: string }[];
    assert.deepEqual(rows.map((x) => [x.session_id, x.kind, x.undoable]), [['s_2', 'declined', null], ['s_1', 'moved', true], ['s_1', 'moved', false]]);
    assert.deepEqual([rows[0]!.from, rows[0]!.to], ['Work', 'Home']);
    assert.deepEqual(r.result!.structuredContent.cards, [{ id: c.id, session_id: 's_2', at: c.at, reason: 'low', from: 'Work', to: 'Home' }]);
    assert.match(r.result!.structuredContent.summary, /3 events, 1 card waiting, a move can be undone/);
    const one = await h.call(read, 'autotransfer_events', { session_id: 's_1', limit: 1 });
    assert.deepEqual((one.result!.structuredContent.events as { kind: string }[]).map((x) => x.kind), ['moved']);
    assert.deepEqual(one.result!.structuredContent.cards, []);
  } finally {
    h.done();
    clearResolvers();
  }
});

test('denied: another user\'s chat reads exactly like a missing one, its rows never show, the engine is never asked; an agent never reaches it', async () => {
  const { h, event, card, looked } = await build({ s_theirs: true });
  try {
    owners({ s_mine: FOUNDING_USER_ID, s_theirs: U_B });
    // The trail holds rows of a chat that is now another user's (a handed-over chat): they must not be listed.
    event('s_theirs', 'moved', -10);
    card('s_theirs');
    event('s_mine', 'warned', -3);
    const read = h.token('read').secret;
    const theirs = await h.call(read, 'autotransfer_events', { session_id: 's_theirs' });
    assert.equal(theirs.result?.structuredContent.error.code, 'NOT_FOUND');
    assert.deepEqual(theirs.result, (await h.call(read, 'autotransfer_events', { session_id: 's_nosuch' })).result);
    const all = await h.call(read, 'autotransfer_events', {});
    assert.deepEqual((all.result!.structuredContent.events as { session_id: string }[]).map((x) => x.session_id), ['s_mine']);
    assert.deepEqual(all.result!.structuredContent.cards, []);
    assert.ok(!JSON.stringify(all.raw).includes('s_theirs'));
    assert.deepEqual(looked, [], 'nothing was looked up for a chat the caller may not view');
    const agent = await h.agentToken('docker/dev', 's_mine');
    const fromAgent = await h.call(agent.secret, 'autotransfer_events', {});
    assert.ok(fromAgent.result?.isError === true || !!fromAgent.error, 'an agent token is refused');
  } finally {
    h.done();
    clearResolvers();
  }
});

test('declared through the seam: view on the session, optional, the same text as a missing one', () => {
  assert.deepEqual(AUTOTRANSFER_TOOL_POLICIES.autotransfer_events, {
    kind: 'objects',
    checks: [{ type: 'session', verb: 'view', arg: 'session_id', optional: true, notFound: 'No such session.' }],
    filter: 'session',
  });
});
