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
import { createApp, EDGE_LIMITS, retryAfterOf } from '../app.js';
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
    assert.equal(first429.headers.get('retry-after'), '60', "the route's own 429 says when to come back");
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
  for (const d of [undefined, null, {}, { retryAfterS: 0 }, { retryAfterS: -5 }, { retryAfterS: '9' }, { retryAfterS: Number.NaN }]) assert.equal(retryAfterOf(d), 60);
});
