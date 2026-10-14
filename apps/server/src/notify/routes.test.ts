// The routes through the real app (session guard, Origin check, body limits) with two fake users: B cannot see, list, count, change,
// test, remove, answer or flag A's things; an id of A answers B like an unknown id. Sealing is proven by reading the database file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Hono } from 'hono';
import { createApp } from '../app.js';
import { createPlatform } from '../platform/index.js';
import { Portal } from '../portal.js';
import { createEgress, type Egress } from './egress.js';
import { FakeChat, fakeBrowser, fakeOwner, freshStore, request, session } from './testkit.js';

const CODE = '24681357';
const HOST = 'localhost:3232';

/** The production rules for what may be registered, and a sender that records instead of connecting: nothing leaves this machine. */
function recordingEgress() {
  const real = createEgress();
  const sent: string[] = [];
  const egress: Egress = { precheck: (u, p) => real.precheck(u, p), send: async (r) => (sent.push(r.url), { ok: true, status: 201, error: null, retryAfterS: null }) };
  return Object.assign(egress, { sent });
}

async function build(egress = recordingEgress()) {
  const { store, dataDir } = await freshStore();
  const chat = new FakeChat();
  chat.sessions.set('s_a', session('s_a'));
  chat.sessions.set('s_b', session('s_b'));
  const owner = fakeOwner({ 'session:s_a': 'u_a', 'session:s_b': 'u_b' });
  const platform = createPlatform({ store, settings: null, chat, uiUrl: 'https://pilot.example.test', pushContact: null, selfOrigin: `http://${HOST}`, owner, egress, tools: false });
  platform.start();
  const portal = new Portal(CODE, 60_000);
  const stub: unknown = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : stub), apply: () => stub, construct: () => stub as object });
  const app = (createApp as unknown as (...a: unknown[]) => Hono)(portal, stub, store, stub, stub, stub, stub, chat, { serveWeb: false, poolService: stub, platform });
  const token = portal.signIn(CODE);
  const call = async (as: string, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    owner.caller = as;
    const res = await app.request(`http://${HOST}${path}`, {
      method,
      headers: { Host: HOST, Cookie: `portal_session=${token}`, Origin: `http://${HOST}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
      ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; details?: { reason?: string } } } | null;
    return { status: res.status, data: json?.data as any, error: json?.error };
  };
  return { store, dataDir, chat, owner, platform, app, portal, token, call };
}

const DISCORD = 'https://discord.com/api/webhooks' + '/123456789012345678/CANARYdiscordSECRETabcdefghij0123456789';
const HOOK = 'https://hooks.example.test/in/CANARY-HOOK-PATH?key=CANARY-QUERY';

test('two users: B cannot list, read, change, test, remove, rotate or flag A’s things; ids of A answer like unknown ones', async () => {
  const { call, platform, store } = await build();
  try {
    const browser = fakeBrowser('https://fcm.googleapis.com/fcm/send/CANARY-ENDPOINT');
    const push = await call('u_a', 'POST', '/api/notify/push', { subscription: browser.subscription, name: 'Pixel 8', tz: 'Asia/Jakarta' });
    assert.equal(push.status, 200);
    assert.equal(push.data.hint, 'fcm.googleapis.com');
    assert.equal(push.data.unrecognisedService, false);
    const ch = await call('u_a', 'POST', '/api/notify/destinations', { type: 'webhook', name: 'Ops', url: HOOK, signed: true });
    assert.equal(ch.status, 200);
    assert.match(ch.data.signingSecret, /^cpws_/);
    const id = ch.data.destination.id as string;
    assert.ok(!JSON.stringify(ch.data.destination).includes('CANARY'), 'the URL is never returned');
    // A sees two, B sees none
    assert.equal((await call('u_a', 'GET', '/api/notify/destinations')).data.length, 2);
    assert.equal((await call('u_b', 'GET', '/api/notify/destinations')).data.length, 0);
    assert.equal((await call('u_b', 'GET', '/api/notify')).data.destinations.length, 0);
    for (const [m, p, b] of [
      ['PATCH', `/api/notify/destinations/${id}`, { name: 'mine now' }],
      ['DELETE', `/api/notify/destinations/${id}`, undefined],
      ['POST', `/api/notify/destinations/${id}/test`, undefined],
      ['POST', `/api/notify/destinations/${id}/secret`, undefined],
      ['GET', '/api/notify/sessions/s_a', undefined],
      ['PUT', '/api/notify/sessions/s_a', { done: true }],
      ['GET', '/api/notify/sessions/nope', undefined],
    ] as const) {
      const r = await call('u_b', m, p, b);
      assert.equal(r.status, 404, `${m} ${p} ${JSON.stringify(r.error)}`);
    }
    assert.equal((await call('u_a', 'GET', `/api/notify/destinations`)).data.find((d: { id: string }) => d.id === id).name, 'Ops');
    // history, log and the audit are each user's own
    platform.bus.emit({ kind: 'session_failed', subject: { type: 'session', id: 's_a' }, facts: { workspace: 'docker/a', reason: 'error' } });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal((await call('u_a', 'GET', '/api/notify/history')).data.items.length, 1);
    assert.equal((await call('u_b', 'GET', '/api/notify/history')).data.items.length, 0);
    assert.equal((await call('u_b', 'GET', '/api/notify')).data.unread, 0);
    assert.ok((await call('u_a', 'GET', '/api/notify/log')).data.length >= 1);
    assert.equal((await call('u_b', 'GET', '/api/notify/log')).data.length, 0);
    assert.equal((await call('u_b', 'GET', `/api/notify/log?destination=${id}`)).data.length, 0);
    assert.equal((await call('u_b', 'DELETE', '/api/notify/history')).status, 200);
    assert.equal((await call('u_a', 'GET', '/api/notify/history')).data.items.length, 1, 'B clearing its Inbox does not touch A’s');
    assert.ok((await call('u_a', 'GET', '/api/platform/audit')).data.length >= 1);
    owner_audit: {
      const b = await call('u_b', 'GET', '/api/platform/audit');
      assert.equal(b.data.length, 0, 'B (not an admin) reads only rows about B');
    }
    // "Notify when done": A on A's session
    assert.deepEqual((await call('u_a', 'PUT', '/api/notify/sessions/s_a', { done: true })).data, { done: true });
    assert.deepEqual((await call('u_a', 'GET', '/api/notify/sessions/s_a')).data, { done: true });
    assert.deepEqual((await call('u_b', 'GET', '/api/notify/sessions/s_b')).data, { done: false });
    // A push endpoint belongs to one user at a time: B registering A's browser takes it over (and A is told in the audit)
    const moved = await call('u_b', 'POST', '/api/notify/push', { subscription: browser.subscription, tz: 'UTC' });
    assert.equal(moved.data.id, push.data.id);
    assert.equal((await call('u_a', 'GET', '/api/notify/destinations')).data.length, 1);
    assert.equal(platform.audit.list({ kind: 'notify.device_moved' }, 'u_a').length, 1);
    // sealing: no endpoint, URL, key or secret in clear in the database file
    store.db!.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const file = readFileSync(join(store.dataDir ?? '', 'portal.db')).toString('latin1');
    for (const s of ['CANARY-ENDPOINT', 'CANARY-HOOK-PATH', 'CANARY-QUERY', browser.subscription.keys.p256dh, browser.subscription.keys.auth, ch.data.signingSecret]) assert.ok(!file.includes(s), `sealed: ${s.slice(0, 12)}`);
  } finally {
    platform.stop();
  }
});

test('validation: https only, public addresses, real P-256 keys, 16-byte auth, Discord and Slack shapes, the private tick, limits', async () => {
  const { call, platform } = await build();
  try {
    const sub = fakeBrowser('https://push.example.test/x').subscription;
    const bad = async (body: unknown, path = '/api/notify/push') => (await call('u_a', 'POST', path, body)).status;
    assert.equal(await bad({ subscription: { ...sub, endpoint: 'http://push.example.test/x' }, tz: 'UTC' }), 422);
    assert.equal(await bad({ subscription: { ...sub, endpoint: 'https://127.0.0.1/x' }, tz: 'UTC' }), 422);
    assert.equal(await bad({ subscription: { ...sub, endpoint: 'https://[::ffff:7f00:1]/x' }, tz: 'UTC' }), 422);
    assert.equal(await bad({ subscription: { ...sub, endpoint: `https://push.example.test/${'x'.repeat(500)}` }, tz: 'UTC' }), 422);
    assert.equal(await bad({ subscription: { ...sub, keys: { ...sub.keys, p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url') } }, tz: 'UTC' }), 422);
    assert.equal(await bad({ subscription: { ...sub, keys: { ...sub.keys, auth: 'AAAA' } }, tz: 'UTC' }), 422);
    const ch = '/api/notify/destinations';
    assert.equal(await bad({ type: 'discord', name: 'x', url: 'https://discord.com.evil.test/api/webhooks/1/x' }, ch), 422);
    assert.equal(await bad({ type: 'slack', name: 'x', url: 'https://hooks.slack.com/services/short' }, ch), 422);
    assert.equal(await bad({ type: 'webhook', name: 'x', url: 'https://10.0.0.5/in' }, ch), 422);
    assert.equal(await bad({ type: 'webhook', name: 'x', url: 'https://169.254.169.254/latest', allowPrivateNetwork: true }, ch), 422);
    assert.equal(await bad({ type: 'discord', name: 'x', url: DISCORD, allowPrivateNetwork: true }, ch), 200, 'the tick is ignored for Discord');
    assert.equal(await bad({ type: 'webhook', name: 'x', url: 'https://10.0.0.5/in', allowPrivateNetwork: true }, ch), 200);
    assert.equal(await bad({ type: 'sms', name: 'x', url: HOOK }, ch), 422);
    assert.equal(await bad({ type: 'webhook', name: 'x', url: HOOK, kinds: ['nope'] }, ch), 422);
    for (let i = 0; i < 20; i++) assert.equal(await bad({ subscription: fakeBrowser(`https://push.example.test/d${i}`).subscription, tz: 'UTC' }), 200);
    assert.equal(await bad({ subscription: fakeBrowser('https://push.example.test/d21').subscription, tz: 'UTC' }), 422, 'at most 20 devices');
    const one = (await call('u_a', 'GET', '/api/notify/destinations')).data[0].id;
    assert.equal((await call('u_a', 'PATCH', `/api/notify/destinations/${one}`, { quiet: { enabled: true, start: '25:00', end: '07:00' } })).status, 422);
    assert.equal((await call('u_a', 'PATCH', `/api/notify/destinations/${one}`, { tz: 'Mars/Base' })).status, 422);
    assert.equal((await call('u_a', 'PATCH', `/api/notify/destinations/${one}`, { allowPrivateNetwork: true })).status, 422, 'only a webhook');
  } finally {
    platform.stop();
  }
});

test('guards: no session 401 (a valid token alone answers nothing), foreign Origin 403, 4 KB and 1 KB bodies, prefs need a confirmation, rotation needs the code again', async () => {
  const { call, app, platform, chat } = await build();
  try {
    const browser = fakeBrowser('https://fcm.googleapis.com/fcm/send/x');
    const d = (await call('u_a', 'POST', '/api/notify/push', { subscription: browser.subscription, tz: 'UTC' })).data;
    chat.open.set('s_a', [request('r1', 'Bash', 'npm test')]);
    const t = platform.notify.actions.issue({ ownerId: 'u_a', destinationId: d.id, eventId: 'evt_0', sessionId: 's_a', requestId: 'r1', decisions: ['deny'], toolClass: 'command', request: request('r1', 'Bash', 'npm test') })!.token;
    const noCookie = await app.request('/api/notify/act', { method: 'POST', headers: { Host: HOST, Origin: `http://${HOST}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t, decision: 'deny' }) });
    assert.equal(noCookie.status, 401);
    const stale = await app.request('/api/notify/act', { method: 'POST', headers: { Host: HOST, Origin: `http://${HOST}`, Cookie: 'portal_session=signed-out', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t, decision: 'deny' }) });
    assert.equal(stale.status, 401);
    const csrf = await call('u_a', 'POST', '/api/notify/act', { token: t, decision: 'deny' }, { Origin: 'https://evil.example' });
    assert.equal(csrf.status, 403);
    assert.equal(chat.answers.length, 0);
    assert.equal((await call('u_a', 'POST', '/api/notify/act', { token: t, decision: 'deny', pad: 'x'.repeat(1100) })).status, 413);
    assert.equal((await call('u_a', 'PATCH', `/api/notify/destinations/${d.id}`, { name: 'x'.repeat(5000) })).status, 413);
    const ok = await call('u_a', 'POST', '/api/notify/act', { token: t, decision: 'deny' });
    assert.deepEqual(ok.data, { ok: true, sessionId: 's_a', outcome: 'denied' });
    const again = await call('u_a', 'POST', '/api/notify/act', { token: t, decision: 'deny' });
    assert.deepEqual([again.status, again.error?.details?.reason], [409, 'used']);
    // turning an Allow on needs confirm: true
    const unconfirmed = await call('u_a', 'PUT', '/api/notify/prefs', { allowCommand: true });
    assert.deepEqual([unconfirmed.status, unconfirmed.error?.code], [409, 'CONFIRMATION_REQUIRED']);
    assert.equal((await call('u_a', 'PUT', '/api/notify/prefs', { allowCommand: true, confirm: true })).data.allowCommand, true);
    assert.equal((await call('u_a', 'PUT', '/api/notify/prefs', { allowCommand: false })).data.allowCommand, false, 'turning off needs nothing');
    // rotating a signing secret needs the server code again
    const hook = (await call('u_a', 'POST', '/api/notify/destinations', { type: 'webhook', name: 'x', url: HOOK, signed: true })).data.destination.id;
    const rot = await call('u_a', 'POST', `/api/notify/destinations/${hook}/secret`);
    assert.deepEqual([rot.status, rot.error?.code], [403, 'REAUTH_REQUIRED']);
  } finally {
    platform.stop();
  }
});

test('mute routes: the caller’s own through the seam, 404 for another user’s, an audit row on create, delete and Unmute all', async () => {
  const { call, platform } = await build();
  try {
    const e = platform.bus.emit({ kind: 'session_failed', subject: { type: 'session', id: 's_a', workspaceId: 'docker/api' }, facts: { workspace: 'docker/api', reason: 'error' } })!;
    await platform.notify.pipeline.handle(e);
    const offer = await call('u_a', 'GET', `/api/notify/mutes/offer/${e.id}`);
    assert.deepEqual([offer.status, offer.data?.scope?.type], [200, 'session']);
    assert.equal((await call('u_b', 'GET', `/api/notify/mutes/offer/${e.id}`)).status, 404);
    assert.equal((await call('u_b', 'POST', '/api/notify/mutes', { from: e.id, duration: '1h' })).status, 404);
    const made = await call('u_a', 'POST', '/api/notify/mutes', { from: e.id, duration: '1h' });
    assert.equal(made.status, 200);
    assert.equal((await call('u_a', 'GET', '/api/notify/mutes')).data.length, 1);
    assert.equal((await call('u_b', 'GET', '/api/notify/mutes')).data.length, 0);
    assert.equal((await call('u_b', 'DELETE', `/api/notify/mutes/${made.data.id}`)).status, 404);
    const guarded = await call('u_a', 'POST', '/api/notify/mutes', { kind: 'approval', duration: '1h' });
    assert.deepEqual([guarded.status, guarded.error?.code], [409, 'CONFIRMATION_REQUIRED']);
    assert.equal((await call('u_a', 'POST', '/api/notify/mutes', { kind: 'approval', duration: '1h', confirm: true })).status, 200);
    assert.equal((await call('u_a', 'DELETE', `/api/notify/mutes/${made.data.id}`)).status, 200);
    assert.deepEqual((await call('u_a', 'DELETE', '/api/notify/mutes')).data, { removed: 1 });
    const rows = platform.audit.list({ kind: 'notify.mute' }, 'u_a');
    assert.deepEqual(rows.map((r) => r.detail.action).sort(), ['cleared', 'created', 'created', 'removed']);
    assert.equal(rows.find((r) => r.detail.kind === 'approval')!.severity, 'medium');
    assert.equal(platform.audit.list({ kind: 'notify.mute' }, 'u_b').length, 0);
  } finally {
    platform.stop();
  }
});

test('T-126 "Alert when idle": each person’s own, per Claude; a Claude B may not see answers 404; on or off only', async () => {
  const { call, owner, platform } = await build();
  try {
    // the fake owner: Claude c_a is A's, nobody may see c_b
    const own = owner as unknown as { can: (u: string, v: string, s: { type: string; id: string }) => boolean };
    const can = own.can;
    own.can = (u, v, s) => (s.type === 'claude' ? s.id === 'c_a' && u === 'u_a' : can(u, v, s));
    assert.deepEqual((await call('u_a', 'GET', '/api/notify/quota-watch/c_a')).data, { watch: false });
    assert.deepEqual((await call('u_a', 'PUT', '/api/notify/quota-watch/c_a', { watch: true })).data, { watch: true });
    assert.deepEqual((await call('u_a', 'GET', '/api/notify/quota-watch/c_a')).data, { watch: true });
    assert.equal((await call('u_a', 'PUT', '/api/notify/quota-watch/c_a', { watch: 'yes' })).status, 400);
    assert.equal((await call('u_b', 'GET', '/api/notify/quota-watch/c_a')).status, 404);
    assert.equal((await call('u_b', 'PUT', '/api/notify/quota-watch/c_a', { watch: true })).status, 404);
    assert.equal((await call('u_a', 'GET', '/api/notify/quota-watch/c_b')).status, 404);
  } finally {
    platform.stop();
  }
});
