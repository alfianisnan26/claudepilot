import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type { Actor, ChatServerMessage, ChatSession, GlanceSnapshot } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { actorString, actorUserId, asUser, ownerActor } from '../authz/seam.js';
import { changesGlance, createGlance, glanceSources } from './index.js';
import { createGlanceRoutes } from './routes.js';
import { Glance, fingerprint } from './service.js';
import { fakeCi, HOUR, NOW, request, run, session, sources, ticket, userActor } from './testkit.js';

const OWNER = ownerActor();
type Vars = { Variables: { token?: string; actor?: Actor } };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A glance over a list of sessions that a test can change, counting the pushes. */
function harness(opts: { watching?: () => boolean } = {}) {
  let sessions: ChatSession[] = [session({ id: 'a', state: 'working' })];
  const src = sources({});
  src.sessions = () => (src.reads.sessions++, sessions);
  const pushes: number[] = [];
  const glance = new Glance(src, { notify: () => pushes.push(Date.now()), debounceMs: 10, now: () => NOW, watching: opts.watching });
  return { glance, src, pushes, set: (next: ChatSession[]) => (sessions = next) };
}

test('the snapshot is built once however many ask, and again only after something changed', () => {
  const h = harness();
  const first = h.glance.snapshot();
  assert.equal(first.sessions.running, 1);
  h.glance.snapshot();
  h.glance.snapshot();
  assert.equal(h.src.reads.sessions, 1);
  h.set([session({ id: 'a', state: 'idle' })]);
  assert.equal(h.glance.snapshot().sessions.running, 1, 'nothing said it changed: the same snapshot');
  h.glance.changed();
  assert.equal(h.glance.snapshot().sessions.running, 0, 'changed(): the next ask builds it again');
  assert.equal(h.src.reads.sessions, 2);
  h.glance.stop();
});

test('a burst of changes is one build and one push, and nothing is pushed when what a page would draw is the same', async () => {
  const h = harness();
  h.glance.snapshot();
  const before = h.src.reads.sessions;
  h.set([session({ id: 'a', state: 'waiting', waiting: 1 })]);
  h.glance.changed();
  h.glance.changed();
  h.glance.changed();
  await sleep(60);
  assert.equal(h.src.reads.sessions - before, 1, 'one build for three changes');
  assert.equal(h.pushes.length, 1);
  // The same state again (a turn counter moved, say): built, compared, not pushed.
  h.glance.changed();
  await sleep(60);
  assert.equal(h.pushes.length, 1, 'same snapshot: no push');
  // A real change pushes again.
  h.set([session({ id: 'a', state: 'idle' })]);
  h.glance.changed();
  await sleep(60);
  assert.equal(h.pushes.length, 2);
  h.glance.stop();
});

test('while no page watches the topic a change does no work; the next request builds it', async () => {
  let watched = false;
  const h = harness({ watching: () => watched });
  h.glance.snapshot();
  const before = h.src.reads.sessions;
  h.set([session({ id: 'a', state: 'idle' })]);
  h.glance.changed();
  await sleep(60);
  assert.equal(h.src.reads.sessions, before, 'not built');
  assert.equal(h.pushes.length, 0);
  assert.equal(h.glance.snapshot().sessions.running, 0, 'a page that opens now gets the truth');
  watched = true;
  h.set([session({ id: 'a', state: 'working' })]);
  h.glance.changed();
  await sleep(60);
  assert.equal(h.pushes.length, 1, 'watched again: pushed');
  h.glance.stop();
});

test('stop() ends the pending build and undoes what was subscribed', async () => {
  const h = harness();
  let undone = 0;
  h.glance.onStop(() => undone++);
  h.set([session({ id: 'a', state: 'idle' })]);
  h.glance.changed();
  h.glance.stop();
  await sleep(40);
  assert.equal(h.pushes.length, 0, 'the pending push never fires');
  assert.equal(undone, 1);
  h.glance.changed();
  await sleep(40);
  assert.equal(h.pushes.length, 0, 'and a later change is ignored');
});

test('the fingerprint ignores when the snapshot was built', () => {
  const a = harness().glance.snapshot();
  const b: GlanceSnapshot = { ...a, at: '2030-01-01T00:00:00.000Z' };
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, sessions: { ...a.sessions, running: 5 } }));
});

test('what in the chat controller counts as a glance change: state, requests, tasks, deletions; never the token stream', () => {
  const s = session({ id: 'a' });
  const yes: ChatServerMessage[] = [
    { type: 'session', session: s },
    { type: 'removed', session: 'a' },
    { type: 'tasks', session: 'a', tasks: [] },
    { type: 'events', session: 'a', items: [{ seq: 1, at: '', kind: 'request', request: request({ requestId: 'r' }) }] },
    { type: 'events', session: 'a', items: [{ seq: 2, at: '', kind: 'resolved', requestId: 'r', outcome: 'denied' }] },
  ];
  const no: ChatServerMessage[] = [
    { type: 'delta', session: 'a', agentLabel: null, text: 'hello' },
    { type: 'events', session: 'a', items: [{ seq: 3, at: '', kind: 'assistant', text: 'hi' }] },
    { type: 'input', session: 'a', uuid: 'u', state: 'started' },
    { type: 'ack', uuid: 'u', ok: true },
    { type: 'error', message: 'x' },
  ];
  assert.deepEqual(yes.map(changesGlance), yes.map(() => true));
  assert.deepEqual(no.map(changesGlance), no.map(() => false));
});

test('createGlance follows the controller: a session event pushes once, a delta does not, stop() unsubscribes', async () => {
  const listeners = new Set<(id: string, msg: ChatServerMessage) => void>();
  let sessions = [session({ id: 'a', state: 'idle' })];
  const pushes: number[] = [];
  const glance = createGlance({
    chat: {
      list: () => sessions,
      openRequests: () => [],
      runningTasks: () => [],
      onEvent: (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    },
    tickets: { list: () => ({ items: [], total: 0, counts: { byStatus: {} as never, needsYou: 0, unassigned: 0, total: 0 } }) },
    ci: fakeCi([]),
    notify: () => pushes.push(1),
    debounceMs: 10,
  });
  assert.equal(listeners.size, 1);
  glance.snapshot(); // a page's first request: pushes are only for people who have asked
  const emit = (msg: ChatServerMessage) => listeners.forEach((cb) => cb('a', msg));
  emit({ type: 'delta', session: 'a', agentLabel: null, text: 'tok' });
  await sleep(60);
  assert.equal(pushes.length, 0);
  sessions = [session({ id: 'a', state: 'working' })];
  emit({ type: 'session', session: sessions[0]! });
  await sleep(60);
  assert.equal(pushes.length, 1);
  glance.stop();
  assert.equal(listeners.size, 0);
});

test('glanceSources: tickets are the ones assigned to a person, asked as the person; a session gone between the listing and its tasks has none', () => {
  const asked: unknown[] = [];
  const chat = {
    list: () => [],
    openRequests: () => [],
    runningTasks: () => {
      throw new Error('No such session.');
    },
  };
  const src = glanceSources({
    chat,
    tickets: {
      list: (caller, filter) => {
        asked.push([caller, filter]);
        return { items: [ticket({ id: 'T-1' })], total: 4, counts: { byStatus: {} as never, needsYou: 4, unassigned: 0, total: 9 } };
      },
    },
    ci: fakeCi([run({ id: 'F', repoId: 'r', pipeline: 'ci', branch: 'main', status: 'failed', created: 2 * HOUR, finished: HOUR })]),
  });
  assert.deepEqual(src.tickets(OWNER).count, 4);
  assert.deepEqual(asked, [[{ kind: 'ui' }, { assignee: 'user', limit: 5 }]]);
  assert.deepEqual(src.runningTasks(OWNER, 'gone'), []);
  const ci = src.failedRuns(OWNER, NOW);
  assert.deepEqual([ci.count, ci.items.map((r) => r.id)], [1, ['F']]);
});

test('GET returns the snapshot in the usual envelope', async () => {
  const h = harness();
  h.glance.snapshot();
  const app = new Hono<Vars>();
  app.use('*', async (c, next) => (c.set('token', 't'), next())); // what requireSession does
  app.onError((e, c) => (isAppError(e) ? c.json(e.toJSON(), e.status as ContentfulStatusCode) : c.json({ error: String(e) }, 500)));
  app.route('/api/glance', createGlanceRoutes(h.glance));
  const res = await app.request('/api/glance');
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: GlanceSnapshot };
  assert.equal(body.data.sessions.running, 1);
  assert.equal(body.data.at, new Date(NOW).toISOString());
  assert.equal(body.data.attention.count, 0);
  assert.equal((await app.request('/api/glance', { method: 'POST' })).status, 404, 'read-only');
  h.glance.stop();
});

test('each person\'s snapshot is built from what they may see and kept apart; one push tells the pages when any of them changed', async () => {
  // Two people (multi-user): u_a has a session working, u_b has none. Today only the owner exists; the sources take the actor so that a
  // later narrowing happens in them alone.
  const seen: Record<string, ChatSession[]> = { u_a: [session({ id: 'a1', state: 'working' })], u_b: [] };
  const asked: string[] = [];
  const src = { ...sources({}), sessions: (actor: Actor) => (asked.push(actorString(actor)), seen[actor.kind === 'user' ? actor.userId : ''] ?? []) };
  const pushes: number[] = [];
  const glance = new Glance(src, { notify: () => pushes.push(1), debounceMs: 10, now: () => NOW });
  const [a, b] = [userActor('u_a'), userActor('u_b')];
  assert.equal(glance.snapshot(a).sessions.running, 1);
  assert.equal(glance.snapshot(b).sessions.running, 0);
  assert.equal(glance.snapshot(a).sessions.running, 1);
  assert.deepEqual(asked, ['user:u_a', 'user:u_b'], 'each was built once, for whoever asked');
  // u_b gets a session: both are compared, and the pages are told once
  seen.u_b = [session({ id: 'b1', state: 'working' }), session({ id: 'b2', state: 'working' })];
  glance.changed();
  await sleep(60);
  assert.equal(pushes.length, 1);
  assert.equal(glance.snapshot(b).sessions.running, 2);
  assert.equal(glance.snapshot(a).sessions.running, 1, 'u_a is unchanged, and u_b\'s sessions never reach it');
  assert.deepEqual(glance.snapshot(a).sessions.items.map((x) => x.id), ['a1']);
  // nothing differs for either: nothing is pushed
  glance.changed();
  await sleep(60);
  assert.equal(pushes.length, 1);
  glance.stop();
});

test('two users\' jobs of the same name never share a snapshot', () => {
  const seen: Record<string, ChatSession[]> = { u_a: [session({ id: 'a1' })], u_b: [] };
  const src = { ...sources({}), sessions: (actor: Actor) => seen[actorUserId(actor) ?? ''] ?? [] };
  const glance = new Glance(src, { notify: () => undefined, now: () => NOW });
  assert.equal(glance.snapshot(asUser('u_a', 'check')).sessions.open, 1);
  assert.equal(glance.snapshot(asUser('u_b', 'check')).sessions.open, 0, 'same job name, another user: its own snapshot');
  glance.stop();
});

test('GET asks on behalf of the signed-in actor the seam names, and the owner for a request that passed the session guard; anonymous is refused', async () => {
  const seen: string[] = [];
  const src = { ...sources({}), sessions: (actor: Actor) => (seen.push(actorString(actor)), actor.kind === 'user' && actor.userId === 'u_b' ? [session({ id: 'x', state: 'working' })] : []) };
  const glance = new Glance(src, { notify: () => undefined, now: () => NOW });
  // What `requireSession` does today: it sets the sign-in's token on the context; the seam reads the owner from it.
  const signedIn = new Hono<Vars>();
  signedIn.use('*', async (c, next) => (c.set('token', 't'), next()));
  signedIn.route('/api/glance', createGlanceRoutes(glance));
  // What the real layer does later: it sets the actor itself.
  const asUserApp = new Hono<Vars>();
  asUserApp.use('*', async (c, next) => (c.set('actor', userActor(c.req.header('x-test-user') ?? 'u_none')), next()));
  asUserApp.route('/api/glance', createGlanceRoutes(glance));
  const bare = new Hono();
  bare.onError((e, c) => (isAppError(e) ? c.json(e.toJSON(), e.status as ContentfulStatusCode) : c.json({ error: String(e) }, 500)));
  bare.route('/api/glance', createGlanceRoutes(glance));
  const running = async (app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }, headers: Record<string, string> = {}) => ((await (await app.request('/api/glance', { headers })).json()) as { data: GlanceSnapshot }).data.sessions.running;
  assert.equal(await running(signedIn), 0);
  assert.equal(await running(asUserApp, { 'x-test-user': 'u_b' }), 1);
  assert.equal(await running(asUserApp, { 'x-test-user': 'u_c' }), 0);
  assert.deepEqual(seen, ['user:u_owner', 'user:u_b', 'user:u_c']);
  // a header is never an identity: without the seam's actor the request is nobody's
  assert.equal((await bare.request('/api/glance', { headers: { 'x-test-user': 'u_b' } })).status, 401);
  glance.stop();
});
