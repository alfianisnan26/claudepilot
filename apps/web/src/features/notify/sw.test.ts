import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../../public/sw.js', import.meta.url), 'utf8');
const TOKEN = 'cpna_' + 'A'.repeat(43);
const NOW = 1_800_000_000_000;

interface Calls {
  shown: { title: string; options: Record<string, unknown> }[];
  fetched: { url: string; init: Record<string, unknown> }[];
  opened: string[];
  focused: string[];
  navigated: string[];
  closed: number;
  badge: number[];
  logs: unknown[][];
  listeners: Record<string, (e: unknown) => void>;
}

/** The worker's file evaluated against a fake `self`. */
function load(opts: { respond?: (url: string) => { ok: boolean; status: number; body?: unknown } | Error; windows?: { url: string; focused?: boolean }[]; maxActions?: number } = {}) {
  const calls: Calls = { shown: [], fetched: [], opened: [], focused: [], navigated: [], closed: 0, badge: [], logs: [], listeners: {} };
  const self: Record<string, unknown> = {
    location: { origin: 'https://portal.test' },
    addEventListener: (t: string, fn: (e: unknown) => void) => (calls.listeners[t] = fn),
    registration: { showNotification: async (title: string, options: Record<string, unknown>) => void calls.shown.push({ title, options }), pushManager: {} },
    caches: { open: async () => ({ addAll: async () => undefined }), keys: async () => [], match: async () => undefined },
    clients: {
      claim: async () => undefined,
      matchAll: async () =>
        (opts.windows ?? []).map((w) => ({
          url: w.url,
          focused: !!w.focused,
          visibilityState: 'visible',
          navigate: async (u: string) => void calls.navigated.push(u),
          focus: async () => void calls.focused.push(w.url),
        })),
      openWindow: async (u: string) => void calls.opened.push(u),
    },
    fetch: async (url: string, init: Record<string, unknown>) => {
      calls.fetched.push({ url, init });
      const r = opts.respond?.(url) ?? { ok: true, status: 200 };
      if (r instanceof Error) throw r;
      return { ok: r.ok, status: r.status, json: async () => r.body ?? null };
    },
    navigator: { setAppBadge: async (n: number) => void calls.badge.push(n) },
    Notification: Object.assign(function () {}, { maxActions: opts.maxActions ?? 2 }),
    Intl,
    skipWaiting: async () => undefined,
  };
  self.self = self;
  const ctx = vm.createContext({ ...self, self, console: { log: (...a: unknown[]) => calls.logs.push(a), warn: (...a: unknown[]) => calls.logs.push(a), error: (...a: unknown[]) => calls.logs.push(a) }, Date: class extends Date { static override now() { return NOW; } } });
  vm.runInContext(SRC, ctx);
  const hook = (self as { __pilotPush?: Record<string, (...a: unknown[]) => unknown> }).__pilotPush ?? (vm.runInContext('self.__pilotPush', ctx) as Record<string, (...a: unknown[]) => unknown>);
  return { calls, hook, ctx, self };
}

const payload = (over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) =>
  JSON.stringify({
    web_push: 8030,
    mutable: true,
    notification: { title: 'Approval needed', body: 'api-dev · run a command', navigate: 'https://portal.test/admin/sessions/s_41?request=r_7', tag: 'approval:s_41:r_7', renotify: true, silent: false, data: { v: 1, id: 'evt_1', kind: 'approval', path: '/admin/sessions/s_41?request=r_7', ...data }, ...over },
  });

type Plan = { valid: boolean; title: string; options: { body: string; tag?: string; renotify?: boolean; actions?: { action: string; title: string }[]; data: { path: string; act: unknown } }; badge: number | null };
const plan = (hook: Record<string, (...a: unknown[]) => unknown>, raw: string, max = 2) => JSON.parse(JSON.stringify(hook.plan!(raw, NOW, max))) as Plan;

test('the existing offline behaviour is still registered', () => {
  const { calls } = load();
  for (const t of ['install', 'activate', 'fetch', 'push', 'notificationclick', 'pushsubscriptionchange']) assert.ok(calls.listeners[t], t);
});

test('safePath: only /admin/ paths of the portal, else /admin/', () => {
  const { hook } = load();
  const f = hook.safePath!;
  assert.equal(f('/admin/sessions/s_1?request=r_2'), '/admin/sessions/s_1?request=r_2');
  assert.equal(f('/admin/'), '/admin/');
  for (const bad of ['//evil.test/admin/x', 'https://evil.test/admin/x', '/admin//x', '/admin/../etc', '/login', 'admin/x', '/admin/x\\y', '/admin/\u0000', 'javascript:alert(1)', '/admin/x#<', null, 42, '/admin/' + 'a'.repeat(400)]) assert.equal(f(bad), '/admin/', String(bad));
});

test('a valid push shows the title, body, tag and renotify, with the path in data', () => {
  const { hook } = load();
  const p = plan(hook, payload());
  assert.equal(p.valid, true);
  assert.equal(p.title, 'Approval needed');
  assert.equal(p.options.body, 'api-dev · run a command');
  assert.equal(p.options.tag, 'approval:s_41:r_7');
  assert.equal(p.options.renotify, true);
  assert.equal(p.options.data.path, '/admin/sessions/s_41?request=r_7');
  assert.equal(p.options.actions, undefined, 'no buttons without data.act');
});

test('renotify needs a tag', () => {
  const { hook } = load();
  const p = plan(hook, payload({ tag: undefined }));
  assert.equal(p.options.renotify, undefined);
  assert.equal(p.options.tag, undefined);
});

test('rejected payloads still show a fixed notification that opens /admin/ (Safari: never silent)', () => {
  const { hook } = load();
  for (const raw of ['not json', '', '{}', payload({}, {}).replace('8030', '8031'), JSON.stringify({ web_push: 8030, notification: { body: 'x' } }), JSON.stringify({ web_push: 8030, notification: 'x' })]) {
    const p = plan(hook, raw);
    assert.equal(p.valid, false, raw);
    assert.equal(p.title, 'Portal');
    assert.equal(p.options.body, 'Open the portal');
    assert.equal(p.options.data.path, '/admin/');
  }
});

test('a bad or hostile path becomes /admin/', () => {
  const { hook } = load();
  for (const path of ['//evil.test', 'https://evil.test/', '/admin//x', '/other', 'javascript:1', '/admin/%2e%2e/..', undefined]) assert.equal(plan(hook, payload({}, { path })).options.data.path, '/admin/', String(path));
});

test('text is clipped: title 120, body 300, tag 120', () => {
  const { hook } = load();
  const p = plan(hook, payload({ title: 't'.repeat(500), body: 'b'.repeat(500), tag: 'g'.repeat(500) }));
  assert.equal(p.title.length, 120);
  assert.equal(p.options.body.length, 300);
  assert.equal(p.options.tag!.length, 120);
});

test('buttons: Deny and Allow only when data.act carries a good token and those decisions', () => {
  const { hook } = load();
  const exp = NOW / 1000 + 300;
  const both = plan(hook, payload({}, { act: { t: TOKEN, d: ['deny', 'allow'], exp } }));
  assert.deepEqual(both.options.actions!.map((a) => a.action), ['deny', 'allow']);
  const wide = plan(hook, payload({}, { act: { t: TOKEN, d: ['deny', 'allow'], exp } }), 3);
  assert.deepEqual(wide.options.actions!.map((a) => a.action), ['deny', 'allow', 'review']);
  const denyOnly = plan(hook, payload({}, { act: { t: TOKEN, d: ['deny'], exp } }), 3);
  assert.deepEqual(denyOnly.options.actions!.map((a) => a.action), ['deny', 'review']);
  for (const act of [{ t: 'nope', d: ['deny'], exp }, { t: TOKEN, d: [], exp }, { t: TOKEN, d: ['approve'], exp }, { t: TOKEN, d: ['deny'], exp: NOW / 1000 - 1 }, { t: TOKEN, d: 'deny', exp }, 'x', null]) {
    assert.equal(plan(hook, payload({}, { act })).options.actions, undefined, JSON.stringify(act));
    assert.equal(plan(hook, payload({}, { act })).options.data.act, null);
  }
});

test('the badge is read only from a string of digits', () => {
  const { hook } = load();
  assert.equal(plan(hook, payload({ app_badge: '3' })).badge, 3);
  for (const b of ['x', '-1', '12345', 3, '']) assert.equal(plan(hook, payload({ app_badge: b })).badge, null);
});

test('push event: always shows, sets the badge, and a throwing data.text() still shows', async () => {
  const { calls, hook } = load();
  await hook.handlePush!({ data: { text: () => payload({ app_badge: '2' }) } });
  assert.equal(calls.shown.length, 1);
  assert.deepEqual(calls.badge, [2]);
  await hook.handlePush!({ data: { text: () => { throw new Error('x'); } } });
  await hook.handlePush!({ data: null });
  assert.equal(calls.shown.length, 3);
  assert.equal(calls.shown[2]!.title, 'Portal');
});

test('the click state machine: body and review open; deny and allow answer only with a live matching token', () => {
  const { hook } = load();
  const data = { path: '/admin/sessions/s_1?request=r_1', act: { t: TOKEN, d: ['deny'], exp: NOW / 1000 + 60 } };
  const f = (a: string, d: unknown) => JSON.parse(JSON.stringify(hook.clickPlan!(a, d, NOW)));
  assert.deepEqual(f('', data), { kind: 'open', path: data.path });
  assert.deepEqual(f('review', data), { kind: 'open', path: data.path });
  assert.deepEqual(f('deny', data), { kind: 'act', decision: 'deny', token: TOKEN, path: data.path });
  assert.deepEqual(f('allow', data), { kind: 'open', path: data.path }, 'a decision the token does not carry only opens');
  assert.deepEqual(f('deny', { ...data, act: { ...data.act, exp: NOW / 1000 - 5 } }), { kind: 'open', path: data.path }, 'expired');
  assert.deepEqual(f('deny', { path: '//x' }), { kind: 'open', path: '/admin/' });
  assert.deepEqual(f('deny', null), { kind: 'open', path: '/admin/' });
  assert.deepEqual(f('delete', data), { kind: 'open', path: data.path });
});

test('the act request: POST, same-origin credentials, token only in the JSON body', () => {
  const { hook } = load();
  const r = JSON.parse(JSON.stringify(hook.actRequest!(TOKEN, 'deny'))) as { url: string; init: { method: string; credentials: string; headers: Record<string, string>; body: string } };
  assert.equal(r.url, '/api/notify/act');
  assert.equal(r.init.method, 'POST');
  assert.equal(r.init.credentials, 'same-origin');
  assert.equal(r.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(r.init.body), { token: TOKEN, decision: 'deny' });
  assert.ok(!r.url.includes('cpna'));
});

test('every refusal is one fixed line', () => {
  const { hook } = load();
  const f = (status: number, reason?: string) => hook.refusalLine!(status, reason ? { error: { details: { reason } } } : null);
  const lines = new Map([
    ['expired', 'It took too long'],
    ['used', 'Already answered'],
    ['closed', 'The request is closed'],
    ['not_allowed', 'Not allowed from a notification'],
    ['disabled', 'Answers are switched off'],
    ['device_removed', 'This device was removed'],
    ['rate_limited', 'Too many tries'],
    ['locked', 'The portal is locked'],
    ['unknown', 'Not recognised'],
  ]);
  for (const [reason, line] of lines) assert.equal(f(403, reason), line);
  assert.equal(f(401), 'Sign in again');
  assert.equal(f(429), 'Too many tries');
  assert.equal(f(0), 'Could not reach the portal');
  assert.equal(f(500, 'Robert\'); DROP TABLE'), 'Could not reach the portal', 'a reason the worker does not know is never shown');
  assert.equal(f(403, '__proto__'), 'Could not reach the portal');
});

test('clicking Deny posts, closes the notification and shows nothing on success', async () => {
  const { calls, hook } = load();
  let closed = 0;
  await hook.handleClick!({ action: 'deny', notification: { close: () => closed++, data: { path: '/admin/sessions/s_1', tag: 't', act: { t: TOKEN, d: ['deny'], exp: NOW / 1000 + 60 } } } });
  assert.equal(closed, 1);
  assert.equal(calls.fetched.length, 1);
  assert.equal(calls.fetched[0]!.url, '/api/notify/act');
  assert.equal(calls.shown.length, 0);
  assert.equal(calls.opened.length + calls.focused.length, 0);
});

test('a refused answer shows "Couldn\'t answer · open" with the reason and the deep link, and no token anywhere', async () => {
  const { calls, hook } = load({ respond: () => ({ ok: false, status: 409, body: { error: { code: 'CONFLICT', details: { reason: 'used' } } } }) });
  await hook.handleClick!({ action: 'deny', notification: { close: () => undefined, data: { path: '/admin/sessions/s_1?request=r_1', tag: 'approval:s_1:r_1', act: { t: TOKEN, d: ['deny'], exp: NOW / 1000 + 60 } } } });
  assert.equal(calls.shown.length, 1);
  assert.equal(calls.shown[0]!.title, 'Couldn’t answer · open');
  assert.equal(calls.shown[0]!.options.body, 'Already answered');
  assert.equal((calls.shown[0]!.options.data as { path: string }).path, '/admin/sessions/s_1?request=r_1');
  assert.ok(!JSON.stringify(calls.shown).includes('cpna_'));
  assert.ok(!JSON.stringify(calls.logs).includes('cpna_'));
});

test('a network failure is a refusal too', async () => {
  const { calls, hook } = load({ respond: () => new Error('offline') });
  await hook.handleClick!({ action: 'allow', notification: { close: () => undefined, data: { path: '/admin/', tag: 't', act: { t: TOKEN, d: ['deny', 'allow'], exp: NOW / 1000 + 60 } } } });
  assert.equal(calls.shown[0]!.options.body, 'Could not reach the portal');
});

test('a body click focuses a window of this origin (taking it to the path) or opens one; never another origin', async () => {
  const none = load();
  await none.hook.handleClick!({ action: '', notification: { close: () => undefined, data: { path: '/admin/sessions/s_1' } } });
  assert.deepEqual(none.calls.opened, ['https://portal.test/admin/sessions/s_1']);
  const one = load({ windows: [{ url: 'https://other.test/admin/x', focused: true }, { url: 'https://portal.test/admin/usage' }] });
  await one.hook.handleClick!({ action: 'review', notification: { close: () => undefined, data: { path: '/admin/sessions/s_1?request=r_1' } } });
  assert.deepEqual(one.calls.navigated, ['https://portal.test/admin/sessions/s_1?request=r_1']);
  assert.deepEqual(one.calls.focused, ['https://portal.test/admin/usage']);
  assert.deepEqual(one.calls.opened, []);
  const evil = load();
  await evil.hook.handleClick!({ action: '', notification: { close: () => undefined, data: { path: 'https://evil.test/' } } });
  assert.deepEqual(evil.calls.opened, ['https://portal.test/admin/']);
});

test('subscription change: posts the new subscription with the zone, and never throws', async () => {
  const { calls, hook } = load();
  const sub = { toJSON: () => ({ endpoint: 'https://push.test/e', keys: { p256dh: 'k', auth: 'a' } }) };
  await hook.resubscribe!({ newSubscription: sub });
  assert.equal(calls.fetched[0]!.url, '/api/notify/push');
  const body = JSON.parse(calls.fetched[0]!.init.body as string) as { subscription: { endpoint: string }; tz: string };
  assert.equal(body.subscription.endpoint, 'https://push.test/e');
  assert.ok(body.tz);
  assert.equal(calls.fetched[0]!.init.credentials, 'same-origin');
  const bad = load({ respond: () => new Error('x') });
  await bad.hook.resubscribe!({ newSubscription: sub });
  await bad.hook.resubscribe!({ oldSubscription: null });
});

test('the worker never intercepts /api, /hooks or sockets: its fetch handler only answers page loads', () => {
  const calls = load().calls;
  let responded = false;
  calls.listeners.fetch!({ request: { method: 'POST', mode: 'cors', url: 'https://portal.test/api/notify/act' }, respondWith: () => (responded = true) });
  calls.listeners.fetch!({ request: { method: 'GET', mode: 'cors', url: 'https://portal.test/api/live' }, respondWith: () => (responded = true) });
  assert.equal(responded, false);
});

test('Mute: a button only when the server offered it, on a well-formed event id, never on approvals or deploy waits; it opens the mute sheet', () => {
  const { hook } = load();
  const ID = 'evt_' + '0123456789abcdef';
  const mute = [{ action: 'mute', title: 'Mute', navigate: `https://portal.test/admin/notifications?mute=${ID}` }];
  const ci = (data: Record<string, unknown>, over: Record<string, unknown> = { actions: mute }) => plan(hook, payload({ title: 'CI failed', ...over }, { kind: 'ci_failed', id: ID, path: '/admin/ci/runs/r_1', ...data }));
  assert.deepEqual(ci({}).options.actions, [{ action: 'mute', title: 'Mute' }]);
  assert.equal(ci({}, {}).options.actions, undefined, 'not offered: no button');
  assert.equal(ci({ id: 'evt_x' }).options.actions, undefined, 'a bad id: no button');
  assert.equal(ci({ kind: 'approval' }).options.actions, undefined);
  assert.equal(ci({ kind: 'ci_waiting' }).options.actions, undefined);
  const f = (a: string, d: unknown) => JSON.parse(JSON.stringify(hook.clickPlan!(a, d, NOW)));
  assert.deepEqual(f('mute', { id: ID, path: '/admin/ci/runs/r_1' }), { kind: 'open', path: `/admin/notifications?mute=${ID}` });
  assert.deepEqual(f('mute', { id: '../x', path: '/admin/ci/runs/r_1' }), { kind: 'open', path: '/admin/ci/runs/r_1' });
});
