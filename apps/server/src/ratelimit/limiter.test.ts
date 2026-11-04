// PILOT-1138: the portable limiter and its middleware. Limits hit and reset on a fake clock; a refusal is 429 with Retry-After; the audit
// hook fires once per window and never carries the path, the query or a token; the module stays free of `node:` imports (Worker-ready).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Hono } from 'hono';
import { MemoryRateLimitStore, take, type RateLimitStore, type WindowCount } from './limiter.js';
import { rateLimit, type LimitedEvent } from './middleware.js';

const RULE = { name: 'r', limit: 3, windowMs: 10_000 };

test('a key gets `limit` requests per window, then refusals that say how long to wait; the next window starts over', async () => {
  const store = new MemoryRateLimitStore();
  let now = 1_000_000;
  const v = [];
  for (let i = 0; i < 5; i++) v.push(await take(store, RULE, 'a', now));
  assert.deepEqual(v.map((x) => x.ok), [true, true, true, false, false]);
  assert.deepEqual(v.map((x) => x.first), [false, false, false, true, false], 'only the first refusal of the window is "first"');
  assert.equal(v[3]!.retryAfterS, 10);
  now += 4_500;
  assert.equal((await take(store, RULE, 'a', now)).retryAfterS, 6, 'rounded up, never 0');
  assert.equal((await take(store, RULE, 'b', now)).ok, true, 'another key has its own count');
  now += 5_500;
  const fresh = await take(store, RULE, 'a', now);
  assert.equal(fresh.ok, true, 'reset after the window');
  assert.equal(fresh.first, false);
});

test('rules sharing a store do not share counts', async () => {
  const store = new MemoryRateLimitStore();
  for (let i = 0; i < 3; i++) await take(store, RULE, 'a', 0);
  assert.equal((await take(store, RULE, 'a', 0)).ok, false);
  assert.equal((await take(store, { ...RULE, name: 'other' }, 'a', 0)).ok, true);
});

test('the memory store stays bounded: ended windows go first, then the oldest', () => {
  const store = new MemoryRateLimitStore(3);
  store.hit('a', 10, 0);
  store.hit('b', 1_000, 0);
  store.hit('c', 1_000, 0);
  store.hit('d', 1_000, 20);
  assert.equal(store.size, 3, 'the ended window of a made room');
  store.hit('e', 1_000, 20);
  assert.equal(store.size, 3, 'the oldest went when nothing had ended');
});

test('an async store (a Durable Object, a binding) plugs in unchanged', async () => {
  const counts = new Map<string, WindowCount>();
  const asyncStore: RateLimitStore = {
    hit: async (key, windowMs, now) => {
      await new Promise((r) => setTimeout(r, 1));
      const w = counts.get(key) ?? { count: 0, resetAt: now + windowMs };
      w.count++;
      counts.set(key, w);
      return { ...w };
    },
  };
  const app = new Hono();
  app.use('*', rateLimit({ store: asyncStore, rule: RULE, key: () => 'x', now: () => 0 }));
  app.get('/', (c) => c.text('ok'));
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await app.request('/')).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
});

test('middleware: 429 with Retry-After before the route runs; one audit event per window; a null key is not counted', async () => {
  let now = 0;
  let ran = 0;
  const events: LimitedEvent[] = [];
  const app = new Hono();
  app.use('/x/*', rateLimit({ store: new MemoryRateLimitStore(), rule: RULE, key: (c) => c.req.header('x-ip') ?? null, onLimited: (e) => events.push(e), now: () => now }));
  app.all('/x/*', (c) => (ran++, c.text('ok')));
  const call = (ip?: string) => app.request('/x/y', { method: 'POST', headers: ip ? { 'x-ip': ip } : {} });
  for (let i = 0; i < 3; i++) assert.equal((await call('1.2.3.4')).status, 200);
  const refused = await call('1.2.3.4');
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('retry-after'), '10');
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'RATE_LIMITED');
  assert.equal((await call('1.2.3.4')).status, 429);
  assert.equal(ran, 3, 'the route never ran for a refused request');
  assert.deepEqual(events, [{ rule: 'r', method: 'POST', key: '1.2.3.4', retryAfterS: 10 }], 'one event for the window, not one per refusal');
  for (let i = 0; i < 10; i++) assert.equal((await call()).status, 200, 'no key, no count');
  now += 10_000;
  assert.equal((await call('1.2.3.4')).status, 200, 'reset after the window');
});

test('middleware: an audit hook that throws still refuses', async () => {
  const app = new Hono();
  app.use('*', rateLimit({ store: new MemoryRateLimitStore(), rule: { ...RULE, limit: 0 }, key: () => 'k', onLimited: () => { throw new Error('audit down'); } }));
  app.get('/', (c) => c.text('ok'));
  assert.equal((await app.request('/')).status, 429);
});

test('redact: a token in the path, the query or a header never reaches the audit event or the console', async () => {
  const token = ['pmcp', randomUUID().replaceAll('-', '')].join('_'); // built at runtime: no token-shaped literal
  const events: LimitedEvent[] = [];
  const logged: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of ['log', 'warn', 'error', 'info'] as const) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
  try {
    const app = new Hono();
    app.use('*', rateLimit({ store: new MemoryRateLimitStore(), rule: { ...RULE, limit: 1 }, key: () => '203.0.113.9', onLimited: (e) => events.push(e) }));
    app.all('*', (c) => c.text('ok'));
    for (let i = 0; i < 3; i++) await app.request(`/connect/v1/enroll/${token}?token=${token}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  } finally {
    Object.assign(console, saved);
  }
  assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(events).includes(token), 'no token in the audit event');
  assert.ok(!logged.join('\n').includes(token), 'no token in any log line');
});

test('the module is portable: no node: import in limiter.ts or middleware.ts', () => {
  for (const f of ['limiter.ts', 'middleware.ts']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from\s+['"]node:|require\(\s*['"]node:/, f);
  }
});
