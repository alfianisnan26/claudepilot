// PILOT-1138 over HTTP: the per-address ceilings in front of sign-in, /mcp, /connect and the VS Code API answer 429 with Retry-After
// and write ONE `portal.rate_limited` audit row per address and window, with no token in it or in any log line; a route's own 429
// (the server-code limiter) carries Retry-After too.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';
import { ADMIN_SIGNIN_LIMIT, createApp, EDGE_LIMITS, retryAfterOf } from '../app.js';
import { config } from '../config.js';
import { Portal } from '../portal.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';

const stub: object = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
  apply: () => stub,
  construct: () => stub,
  set: () => true,
});
const make = createApp as unknown as (...args: unknown[]) => Hono;
const CODE = '24681357';
const limitOf = (name: string) => EDGE_LIMITS.find(([, r]) => r.name === name)![1].limit;

async function build() {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-edge-limit-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const rows: { kind: string; detail: unknown }[] = [];
  const platform = { audit: { record: (r: { kind: string; detail: unknown }) => void rows.push(r) }, bus: { emit: async () => {} }, useReauth: () => {}, routes: () => [], hooks: new Hono() };
  const app = make(new Portal(CODE, 60_000), stub, store, stub, stub, stub, stub, stub, { serveWeb: false, poolService: stub, mcp: stub, skills: stub, platform });
  const call = (method: string, path: string, init: { body?: unknown; headers?: Record<string, string>; ip?: string } = {}) =>
    app.request(
      `http://localhost:3000${path}`,
      { method, headers: { host: 'localhost:3000', 'content-type': 'application/json', ...init.headers }, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
      { incoming: { socket: { remoteAddress: init.ip ?? '127.0.0.1' } } },
    );
  return { call, rows, done: () => (store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}

test('sign-in: the code limiter refuses with Retry-After; past the ceiling the edge refuses with one audit row', async () => {
  const { call, rows, done } = await build();
  try {
    const statuses: number[] = [];
    let first429: Response | null = null;
    for (let i = 0; i < limitOf('signin') + 2; i++) {
      const r = await call('POST', '/api/login', { body: { code: '00000000' } });
      statuses.push(r.status);
      if (r.status === 429 && !first429) first429 = r;
    }
    assert.ok(first429, 'the code limiter refused');
    assert.equal(first429.headers.get('retry-after'), String(config.loginLimit.windowMs / 1000), "the code lock's own 429 says when to come back (PILOT-1168: its first lock)");
    const edge = await call('POST', '/api/login', { body: { code: CODE } });
    assert.equal(edge.status, 429, 'past the ceiling even the right code is not tried');
    assert.match(edge.headers.get('retry-after') ?? '', /^[1-9]\d*$/);
    const limited = rows.filter((r) => r.kind === 'portal.rate_limited');
    assert.equal(limited.length, 1, 'one row for the window, not one per refusal');
    assert.deepEqual(Object.keys(limited[0]!.detail as object).sort(), ['address', 'method', 'retryAfterS', 'rule']);
    assert.equal((limited[0]!.detail as { rule: string }).rule, 'signin');
    assert.equal((await call('POST', '/api/login', { body: { code: CODE }, ip: '10.9.9.9' })).status, 200, 'another address is not affected');
  } finally {
    done();
  }
});

test('/mcp: a flood with a token in the header and the query is cut off; the token is in no audit row and no log line', async () => {
  const { call, rows, done } = await build();
  const token = ['pmcp', randomUUID().replaceAll('-', '')].join('_'); // built at runtime: no token-shaped literal
  const logged: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const k of ['log', 'warn', 'error', 'info'] as const) console[k] = (...a: unknown[]) => void logged.push(a.map(String).join(' '));
  let last: Response | null = null;
  try {
    for (let i = 0; i <= limitOf('mcp'); i++) last = await call('POST', `/mcp?token=${token}`, { body: {}, headers: { authorization: `Bearer ${token}` }, ip: '198.51.100.7' });
  } finally {
    Object.assign(console, saved);
    done();
  }
  assert.equal(last!.status, 429);
  assert.ok(Number(last!.headers.get('retry-after')) >= 1);
  const limited = rows.filter((r) => r.kind === 'portal.rate_limited');
  assert.equal(limited.length, 1);
  assert.equal((limited[0]!.detail as { address: string }).address, '198.51.100.7');
  assert.ok(!JSON.stringify(rows).includes(token), 'no token in any audit row');
  assert.ok(!logged.join('\n').includes(token), 'no token in any log line');
});

test('/connect and /api/vscode sit behind their ceilings too', async () => {
  const { call, done } = await build();
  try {
    for (const [name, path] of [['connect', '/connect/v1/health'], ['vscode', '/api/vscode/version']] as const) {
      let last: Response | null = null;
      for (let i = 0; i <= limitOf(name); i++) last = await call('GET', path, { ip: `192.0.2.${name.length}` });
      assert.equal(last!.status, 429, name);
      assert.ok(last!.headers.get('retry-after'), name);
    }
  } finally {
    done();
  }
});

test('retryAfterOf: a route detail wins when it is a positive number, else a minute', () => {
  assert.equal(retryAfterOf({ retryAfterS: 600 }), 600);
  assert.equal(retryAfterOf({ retryAfterS: 1.2 }), 2);
  assert.equal(retryAfterOf({ retryAfter: 30 }), 30, 'the identity lockout names its wait `retryAfter`');
  for (const d of [undefined, null, {}, { retryAfterS: 0 }, { retryAfterS: -5 }, { retryAfterS: '9' }, { retryAfterS: Number.NaN }]) assert.equal(retryAfterOf(d), 60);
});

/** Runs `fn` as the cluster does: behind the trusted proxy, with Cloudflare in front (config is read per request). */
async function behindCloudflare<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { trustProxy: config.trustProxy, trustCloudflare: config.trustCloudflare };
  Object.assign(config, { trustProxy: true, trustCloudflare: true });
  try {
    return await fn();
  } finally {
    Object.assign(config, saved);
  }
}

test('review MAJOR: behind the tunnel two visitors on the same hop have their own counts (CF-Connecting-IP), and the audit names the visitor', async () => {
  const { call, rows, done } = await build();
  const tunnel = '10.42.0.17'; // the cloudflared pod: the hop Traefik sees for every visitor
  const via = (visitor: string) => ({ ip: tunnel, headers: { 'x-forwarded-for': tunnel, 'cf-connecting-ip': visitor } });
  try {
    await behindCloudflare(async () => {
      let last: Response | null = null;
      for (let i = 0; i <= limitOf('connect'); i++) last = await call('GET', '/connect/v1/health', via('198.51.100.20'));
      assert.equal(last!.status, 429, 'the flooding visitor is cut off');
      assert.notEqual((await call('GET', '/connect/v1/health', via('203.0.113.44'))).status, 429, 'another visitor behind the same tunnel is not');
      const limited = rows.filter((r) => r.kind === 'portal.rate_limited');
      assert.equal(limited.length, 1);
      assert.equal((limited[0]!.detail as { address: string }).address, '198.51.100.20', 'the visitor, not the tunnel pod');
      // One IPv6 subscriber walking its /64 is one key.
      for (let i = 0; i <= limitOf('connect'); i++) last = await call('GET', '/connect/v1/health', via(`2001:db8:7:9::${(i + 1).toString(16)}`));
      assert.equal(last!.status, 429, 'every address of one /64 counts as one');
      assert.notEqual((await call('GET', '/connect/v1/health', via('2001:db8:7:a::1'))).status, 429, 'the next /64 is another visitor');
    });
    // A CF-Connecting-IP from a public hop (straight from the internet) is the client's invention: ignored, the hop is the key.
    await behindCloudflare(async () => {
      let last: Response | null = null;
      for (let i = 0; i <= limitOf('vscode'); i++) last = await call('GET', '/api/vscode/version', { ip: '192.0.2.200', headers: { 'x-forwarded-for': '192.0.2.200', 'cf-connecting-ip': `198.51.100.${i % 250}` } });
      assert.equal(last!.status, 429, 'a forged header from a public hop does not spread the count');
    });
  } finally {
    done();
  }
});

test('review: the Admin console sign-in (POST /admin-api/session) has its own ceiling; its GET is not counted', async () => {
  const { call, rows, done } = await build();
  try {
    for (let i = 0; i < ADMIN_SIGNIN_LIMIT.limit + 5; i++) await call('GET', '/admin-api/session', { ip: '192.0.2.77' });
    let last: Response | null = null;
    for (let i = 0; i <= ADMIN_SIGNIN_LIMIT.limit; i++) last = await call('POST', '/admin-api/session', { body: {}, ip: '192.0.2.77' });
    assert.equal(last!.status, 429);
    assert.match(last!.headers.get('retry-after') ?? '', /^[1-9]\d*$/);
    assert.equal((rows.find((r) => r.kind === 'portal.rate_limited')!.detail as { rule: string }).rule, 'admin_signin');
  } finally {
    done();
  }
});

test('review MINOR: a locked email answers 429 with the lockout’s own Retry-After, not the default minute', async () => {
  process.env.PORTAL_PASSWORD_COST ??= 'test';
  const { call, done } = await build();
  const password = ['plenty', 'long', 'test', 'pass', 'phrase'].join('-');
  try {
    const signedIn = await call('POST', '/api/login', { body: { code: CODE } });
    const cookie = /portal_session=[^;]+/.exec(signedIn.headers.get('set-cookie') ?? '')![0];
    const created = await call('POST', '/api/admin/users', { body: { email: 'locked@example.com', password }, headers: { cookie } });
    assert.equal(created.status, 201, await created.clone().text());
    let locked: Response | null = null;
    for (let i = 0; i < 12 && !locked; i++) {
      const r = await call('POST', '/api/login', { body: { email: 'locked@example.com', password: `${password}!` }, ip: `192.0.2.${100 + i}` });
      if (r.status === 429) locked = r;
    }
    assert.ok(locked, 'the email locked');
    const wait = Number(locked.headers.get('retry-after'));
    // The first lock is 30 s (identity/throttle.ts, 5 failures); before the fix the header fell back to 60.
    assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= 30, `Retry-After is the lockout's own wait: ${locked.headers.get('retry-after')}`);
  } finally {
    done();
  }
});
