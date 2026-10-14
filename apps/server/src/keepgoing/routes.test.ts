// The Keep going routes through the real app (session guard, Origin check, body limit) and the real platform registration, with two fake
// users: a person sets a policy on their own chat (audited, on the session payload); another user's chat answers like an unknown one; an
// agent (its own chat or another) and a token below admin are refused; an admin token is not; the fields are checked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hono } from 'hono';
import { KEEPGOING_BOUNDS, type Actor, type ChatKeepGoing } from '@portal/contracts';
import { createApp } from '../app.js';
import { createPlatform } from '../platform/index.js';
import { Portal } from '../portal.js';
import { fakeOwner, freshStore } from '../notify/testkit.js';
import { KgChat, fakeClock, settingsMap } from './testkit.js';

const CODE = '13572468';
const HOST = 'localhost:3236';

async function build() {
  const { store } = await freshStore();
  const chat = new KgChat(fakeClock(Date.now()));
  chat.put('s_a');
  chat.put('s_b');
  const owner = fakeOwner({ 'session:s_a': 'u_a', 'session:s_b': 'u_b' }, { fallback: 'u_a' });
  let as: Actor | null = null;
  const realActorOf = owner.actorOf.bind(owner);
  owner.actorOf = ((c: never) => (as ? { actor: as, userId: 'u_a', admin: false, label: `${as.kind}:test` } : realActorOf(c))) as typeof owner.actorOf;
  const platform = createPlatform({ store, settings: settingsMap(), chat, uiUrl: null, pushContact: null, selfOrigin: `http://${HOST}`, owner, tools: false });
  platform.start();
  const portal = new Portal(CODE, 60_000);
  const stub: unknown = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : stub), apply: () => stub, construct: () => stub as object });
  const app = (createApp as unknown as (...a: unknown[]) => Hono)(portal, stub, store, stub, stub, stub, stub, chat, { serveWeb: false, poolService: stub, platform });
  const token = portal.signIn(CODE);
  const call = async (user: string, method: string, path: string, body?: unknown, actor: Actor | null = null) => {
    owner.caller = user;
    as = actor;
    const res = await app.request(`http://${HOST}${path}`, {
      method,
      headers: { Host: HOST, Cookie: `portal_session=${token}`, Origin: `http://${HOST}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string } } | null;
    return { status: res.status, data: json?.data as ChatKeepGoing | null, error: json?.error };
  };
  return { store, chat, platform, call };
}

test('a person turns Keep going on for their chat: the policy, the payload hook, one trail row and one audit row; GET reads it', async () => {
  const b = await build();
  assert.equal((await b.call('u_a', 'GET', '/api/chat/sessions/s_a/keep-going')).data, null, 'no policy yet');
  const on = await b.call('u_a', 'PUT', '/api/chat/sessions/s_a/keep-going', { enabled: true, nudgeAfterMin: 6 });
  assert.equal(on.status, 200);
  assert.equal(on.data!.enabled, true);
  assert.equal(on.data!.nudgeAfterMin, 6);
  assert.equal(on.data!.maxNudgesPerDay, KEEPGOING_BOUNDS.maxNudgesPerDay.default);
  assert.equal(on.data!.prompt, null, 'the default prompt');
  assert.equal(on.data!.last?.kind, 'set');
  const got = await b.call('u_a', 'GET', '/api/chat/sessions/s_a/keep-going');
  assert.equal(got.data!.enabled, true);
  // The controller's session payload reads it through the hook the module installed.
  assert.equal((b.chat.keepGoingOf?.('s_a') as ChatKeepGoing).enabled, true);
  assert.ok(b.chat.emittedFor.includes('s_a'), 'its tabs hear the change');
  const rows = b.platform.audit.list({ kind: 'keepgoing.set' }, null);
  assert.equal(rows.length, 1);
  b.platform.stop();
});

test('another user’s chat answers like an unknown one; an agent and a narrow token are refused; an admin token is not', async () => {
  const b = await build();
  assert.equal((await b.call('u_b', 'PUT', '/api/chat/sessions/s_a/keep-going', { enabled: true })).status, 404);
  assert.equal((await b.call('u_b', 'GET', '/api/chat/sessions/s_a/keep-going')).status, 404);
  assert.equal((await b.call('u_a', 'PUT', '/api/chat/sessions/nope/keep-going', { enabled: true })).status, 404);
  const own = { kind: 'agent', userId: 'u_a', tokenId: 't1', sessionId: 's_a', workspaceId: 'docker/api-dev' } as Actor;
  const self = await b.call('u_a', 'PUT', '/api/chat/sessions/s_a/keep-going', { enabled: true }, own);
  assert.equal(self.status, 403, 'a chat never keeps itself going');
  const other = await b.call('u_a', 'PUT', '/api/chat/sessions/s_a/keep-going', { enabled: true }, { ...own, sessionId: 's_x' } as Actor);
  assert.equal(other.status, 404, 'an agent is boxed to its own chat');
  const narrow = await b.call('u_a', 'PUT', '/api/chat/sessions/s_a/keep-going', { enabled: true }, { kind: 'token', userId: 'u_a', tokenId: 't2', scope: 'operate' } as Actor);
  assert.equal(narrow.status, 403);
  assert.equal((b.chat.keepGoingOf?.('s_a') as ChatKeepGoing | null) ?? null, null, 'nothing was set');
  const admin = await b.call('u_a', 'PUT', '/api/chat/sessions/s_a/keep-going', { enabled: true }, { kind: 'token', userId: 'u_a', tokenId: 't3', scope: 'admin' } as Actor);
  assert.equal(admin.status, 200);
  b.platform.stop();
});

test('the fields are checked: bounds, types, unknown fields, the status file inside the folder, the prompt back to the default', async () => {
  const b = await build();
  const put = (body: unknown) => b.call('u_a', 'PUT', '/api/chat/sessions/s_a/keep-going', body);
  assert.equal((await put({ nudgeAfterMin: 0 })).status, 422);
  assert.equal((await put({ nudgeAfterMin: 2.5 })).status, 422);
  assert.equal((await put({ maxNudgesPerDay: 501 })).status, 422);
  assert.equal((await put({ enabled: 'yes' })).status, 422);
  assert.equal((await put({ owner: 'u_b' })).status, 422);
  assert.equal((await put({ statusFile: '../../etc/passwd' })).status, 422);
  assert.equal((await put({ statusFile: '/abs' })).status, 422);
  assert.equal((await put({ prompt: 'x'.repeat(KEEPGOING_BOUNDS.promptMax + 1) })).status, 422);
  assert.equal((await put('not json')).status, 400);
  const custom = await put({ prompt: 'Carry on with {ticket}.', statusFile: 'docs/status.md' });
  assert.equal(custom.status, 200);
  assert.equal(custom.data!.prompt, 'Carry on with {ticket}.');
  assert.equal(custom.data!.enabled, false, 'absent fields stay (off by default)');
  const back = await put({ prompt: null, statusFile: '' });
  assert.equal(back.data!.prompt, null);
  assert.equal(back.data!.statusFile, null);
  b.platform.stop();
});
