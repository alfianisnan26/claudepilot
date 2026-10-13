// The routes through the real app (session guard, Origin check, body limits) and the real platform registration, with two fake users
// (S20): user B cannot read, change, answer or list user A's chat, card, choices or trail; an id of A answers B like an unknown id.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Hono } from 'hono';
import { AUTO_SETTING_KEYS as K } from '@portal/contracts';
import { createApp } from '../app.js';
import { createPlatform } from '../platform/index.js';
import { Portal } from '../portal.js';
import { fakeOwner, freshStore } from '../notify/testkit.js';
import { MoveChat, chatSession, fakeUsage, settingsMap, usage, win } from './testkit.js';

const CODE = '24681357';
const HOST = 'localhost:3235';

async function build() {
  const { store } = await freshStore();
  const chat = new MoveChat();
  chat.sessions.set('s_a', chatSession('s_a'));
  chat.sessions.set('s_b', chatSession('s_b'));
  // This file runs on the real clock: the windows reset three hours from now (the kit's fixed T0 is in the past on any later day).
  const soon = () => new Date(Date.now() + 3 * 3_600_000).toISOString();
  const u = Object.assign(fakeUsage(() => [usage('work', 'Work', [win('session', 92, soon())], { checkedAt: new Date(Date.now() - 60_000).toISOString() }), usage('home', 'Home', [win('session', 60, soon())], { checkedAt: new Date(Date.now() - 60_000).toISOString() })]), { onAlert: () => () => {} });
  const owner = fakeOwner({ 'session:s_a': 'u_a', 'session:s_b': 'u_b' }, { fallback: 'u_a' });
  const settings = settingsMap({ [K.enabled]: true });
  const platform = createPlatform({ store, settings, chat, claudeUsage: u as never, uiUrl: null, pushContact: null, selfOrigin: `http://${HOST}`, owner, tools: false });
  platform.start();
  const portal = new Portal(CODE, 60_000);
  const stub: unknown = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : stub), apply: () => stub, construct: () => stub as object });
  const app = (createApp as unknown as (...a: unknown[]) => Hono)(portal, stub, store, stub, stub, stub, stub, chat, { serveWeb: false, poolService: stub, platform });
  const token = portal.signIn(CODE);
  const call = async (as: string, method: string, path: string, body?: unknown) => {
    owner.caller = as;
    const res = await app.request(`http://${HOST}${path}`, {
      method,
      headers: { Host: HOST, Cookie: `portal_session=${token}`, Origin: `http://${HOST}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string } } | null;
    return { status: res.status, data: json?.data as any, error: json?.error };
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  return { store, chat, owner, platform, app, call, settings, settle };
}

test('the settings view, the user choices and their validation', async () => {
  const b = await build();
  const v = await b.call('u_a', 'GET', '/api/autotransfer');
  assert.equal(v.status, 200);
  assert.equal(v.data.platform.mode, 'ask');
  assert.equal(v.data.effective.thresholdPct, 10);
  assert.deepEqual(v.data.claudes.map((c: { claudeId: string }) => c.claudeId), ['work', 'home']);
  const p = await b.call('u_a', 'PUT', '/api/autotransfer/prefs', { mode: 'auto', thresholdPct: 15 });
  assert.equal(p.status, 200);
  assert.equal(p.data.prefs.mode, 'auto');
  assert.equal(p.data.effective.mode, 'ask'); // never above the platform
  assert.equal(p.data.effective.thresholdPct, 15);
  assert.equal((await b.call('u_a', 'PUT', '/api/autotransfer/prefs', { thresholdPct: 51 })).status, 422);
  assert.equal((await b.call('u_a', 'PUT', '/api/autotransfer/prefs', { mode: 'always' })).status, 422);
  assert.equal((await b.call('u_a', 'PUT', '/api/autotransfer/prefs', 'x'.repeat(5000))).status, 413);
  // B's choices are B's own.
  assert.equal((await b.call('u_b', 'GET', '/api/autotransfer')).data.prefs.mode, null);
  b.platform.stop();
});

test('a Claude’s destinations: other Claudes of the same workspace, each once', async () => {
  const b = await build();
  const ok = await b.call('u_a', 'PUT', '/api/autotransfer/claudes/work', { thresholdPct: 15, destinations: ['home'] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data, { claudeId: 'work', claudeName: 'Work', workspaceId: 'docker/api-dev', thresholdPct: 15, destinations: ['home'] });
  assert.equal((await b.call('u_a', 'PUT', '/api/autotransfer/claudes/work', { destinations: ['work'] })).status, 422);
  assert.equal((await b.call('u_a', 'PUT', '/api/autotransfer/claudes/work', { destinations: ['home', 'home'] })).status, 422);
  assert.equal((await b.call('u_a', 'PUT', '/api/autotransfer/claudes/nope', { thresholdPct: 15 })).status, 404);
  b.platform.stop();
});

test('S20: the card, the chat state and the trail are the owner’s; another user gets 404 and nothing changes', async () => {
  const b = await build();
  b.chat.turnEnds('s_a');
  await b.settle();
  const st = await b.call('u_a', 'GET', '/api/autotransfer/sessions/s_a');
  assert.equal(st.status, 200);
  const sug = st.data.pending;
  assert.ok(sug, 'a card for A');
  assert.match(sug.id, /^sug_[0-9a-f]{12}$/);
  // B: unknown everywhere.
  assert.equal((await b.call('u_b', 'GET', '/api/autotransfer/sessions/s_a')).status, 404);
  assert.equal((await b.call('u_b', 'PUT', '/api/autotransfer/sessions/s_a', { mode: 'off' })).status, 404);
  for (const what of ['move', 'later', 'always']) assert.equal((await b.call('u_b', 'POST', `/api/autotransfer/suggestions/${sug.id}/${what}`)).status, 404, what);
  assert.deepEqual((await b.call('u_b', 'GET', '/api/autotransfer/events')).data, []);
  assert.deepEqual((await b.call('u_b', 'GET', '/api/autotransfer/events?session=s_a')).data, []);
  assert.equal(b.chat.moves.length, 0);
  assert.equal((await b.call('u_a', 'GET', '/api/autotransfer/sessions/s_a')).data.pending.id, sug.id);
  // A answers: Move.
  const moved = await b.call('u_a', 'POST', `/api/autotransfer/suggestions/${sug.id}/move`);
  assert.equal(moved.status, 200);
  await b.settle();
  assert.deepEqual(b.chat.moves, [{ id: 's_a', to: 'home', handoff: 'ask' }]);
  assert.equal((await b.call('u_a', 'POST', `/api/autotransfer/suggestions/${sug.id}/move`)).status, 409);
  const trail = await b.call('u_a', 'GET', '/api/autotransfer/events?session=s_a');
  assert.deepEqual(trail.data.map((e: { kind: string }) => e.kind), ['moved', 'suggested']);
  assert.equal(trail.data[0].actor, 'user:u_a');
  // Only the moves (the Home page's "last move"), still only the caller's; an unknown kind is refused.
  assert.deepEqual((await b.call('u_a', 'GET', '/api/autotransfer/events?kind=moved&limit=1')).data.map((e: { kind: string }) => e.kind), ['moved']);
  assert.deepEqual((await b.call('u_a', 'GET', '/api/autotransfer/events?kind=undone,failed')).data, []);
  assert.deepEqual((await b.call('u_b', 'GET', '/api/autotransfer/events?kind=moved')).data, []);
  assert.equal((await b.call('u_a', 'GET', '/api/autotransfer/events?kind=moved,nope')).status, 422);
  b.platform.stop();
});

test('a chat’s own mode: Off, Ask, Automatic or Default (null); a bad value is 422', async () => {
  const b = await build();
  const off = await b.call('u_a', 'PUT', '/api/autotransfer/sessions/s_a', { mode: 'off' });
  assert.equal(off.status, 200);
  assert.deepEqual([off.data.mode, off.data.effectiveMode], ['off', 'off']);
  const def = await b.call('u_a', 'PUT', '/api/autotransfer/sessions/s_a', { mode: null });
  assert.deepEqual([def.data.mode, def.data.effectiveMode], [null, 'ask']);
  assert.equal((await b.call('u_a', 'PUT', '/api/autotransfer/sessions/s_a', {})).status, 422);
  assert.equal((await b.call('u_a', 'PUT', '/api/autotransfer/sessions/s_a', { mode: 'yes' })).status, 422);
  assert.equal((await b.call('u_a', 'GET', '/api/autotransfer/sessions/..%2Fx')).status, 404);
  b.platform.stop();
});
