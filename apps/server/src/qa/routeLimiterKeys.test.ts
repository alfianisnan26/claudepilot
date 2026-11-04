// PILOT-1168: every route's own per-address limit keys on the visitor (visitor.ts), not on the hop the proxy saw. Behind the Cloudflare
// tunnel that hop is the cloudflared pod for EVERY visitor: keyed on it, one stranger who trips a limit cuts off everyone. And the
// server-code sign-in locks with a growing wait that a restart does not lift.
//
// Each limiter: two visitors behind one hop get their own counts; a CF-Connecting-IP from a public hop (straight from the internet) is the
// client's invention and is ignored, so it does not spread a count over made-up addresses.
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { LOGIN_LIMITS } from '@portal/contracts';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CODE_LOCKOUT, codeLockKey, createApp } from '../app.js';
import { config } from '../config.js';
import { createInstallRoutes } from '../connect/install/routes.js';
import type { InstallDeps } from '../connect/seams.js';
import { lockMsFor, Throttle } from '../identity/throttle.js';
import { Portal } from '../portal.js';
import { clientIp as mcpClientIp } from '../portalmcp/routes.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { visitorOfRequest } from '../visitor.js';

process.env.PORTAL_PASSWORD_COST ??= 'test';

const stub: object = new Proxy(function () {}, {
  get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : stub),
  apply: () => stub,
  construct: () => stub,
  set: () => true,
});
const make = createApp as unknown as (...args: unknown[]) => Hono;
const CODE = '24681357';
const WRONG = '00000000';
const TUNNEL = '10.42.0.17'; // the cloudflared pod: the hop Traefik sees for every visitor behind the tunnel
const PUBLIC_HOP = '192.0.2.200'; // a request that reached Traefik straight from the internet
const MIN = 60_000;

type Init = { body?: unknown; headers?: Record<string, string>; ip?: string };
const via = (visitor: string): Init => ({ ip: TUNNEL, headers: { 'x-forwarded-for': TUNNEL, 'cf-connecting-ip': visitor } });
const forged = (claimed: string): Init => ({ ip: PUBLIC_HOP, headers: { 'x-forwarded-for': PUBLIC_HOP, 'cf-connecting-ip': claimed } });

async function build(at?: { dataDir: string; key: string }, mcp?: Awaited<ReturnType<typeof portalMcpHarness>>) {
  const dataDir = at?.dataDir ?? mkdtempSync(join(tmpdir(), 'cp-route-keys-'));
  const key = at?.key ?? generateSecretKey();
  const store = mcp?.store ?? (await Store.open({ dataDir, secretKey: parseSecretKey(key) }));
  const rows: { kind: string; detail: unknown }[] = [];
  const platform = { audit: { record: (r: { kind: string; detail: unknown }) => void rows.push(r) }, bus: { emit: async () => {} }, useReauth: () => {}, routes: () => [], hooks: new Hono() };
  // The VS Code routes are mounted only with a Portal MCP module (their tokens are its tokens).
  const app = make(new Portal(CODE, 60_000), stub, store, stub, stub, stub, stub, stub, { serveWeb: false, poolService: stub, mcp: stub, skills: stub, platform, ...(mcp ? { portalMcp: mcp.module } : {}) });
  const call = (method: string, path: string, init: Init = {}) =>
    app.request(
      `http://localhost:3000${path}`,
      { method, headers: { host: 'localhost:3000', 'content-type': 'application/json', ...init.headers }, body: init.body === undefined ? undefined : JSON.stringify(init.body) },
      { incoming: { socket: { remoteAddress: init.ip ?? '127.0.0.1' } } },
    );
  const done = () => {
    if (mcp) mcp.done();
    else store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { call, rows, dataDir, key, close: () => store.close(), done };
}

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

const login = (call: Awaited<ReturnType<typeof build>>['call'], code: string, init: Init = {}) => call('POST', '/api/login', { ...init, body: { code } });

test('code sign-in: the lock grows (doubling, a day at most), and the window outlasts the longest lock', () => {
  const n = config.loginLimit.attempts;
  assert.equal(lockMsFor(CODE_LOCKOUT, n - 1), 0, 'below the threshold: no lock');
  assert.equal(lockMsFor(CODE_LOCKOUT, n), config.loginLimit.windowMs, 'the first lock is the old window (10 min)');
  assert.equal(lockMsFor(CODE_LOCKOUT, n + 1), 2 * config.loginLimit.windowMs);
  assert.equal(lockMsFor(CODE_LOCKOUT, n + 3), 8 * config.loginLimit.windowMs);
  assert.equal(lockMsFor(CODE_LOCKOUT, n + 40), 24 * 60 * MIN, 'the ceiling is a day');
  assert.ok(CODE_LOCKOUT.windowMs >= CODE_LOCKOUT.maxLockMs, 'waiting a lock out does not start the count over');
  assert.notEqual(codeLockKey('192.0.2.1'), codeLockKey('192.0.2.2'));
  assert.match(codeLockKey('192.0.2.1'), /^code:[0-9a-f]{32}$/, 'a fingerprint, apart from the email lockout’s bare per-address keys');
});

test('code sign-in: a guesser who waits each lock out gets a longer one every time (a clock that moves)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-code-lock-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  let now = Date.UTC(2030, 0, 1);
  const throttle = new Throttle(() => store.db, () => now);
  const key = codeLockKey('198.51.100.9');
  try {
    let lock = 0;
    for (let i = 0; i < config.loginLimit.attempts; i++) lock = throttle.fail('ip', key, CODE_LOCKOUT);
    assert.equal(lock, config.loginLimit.windowMs);
    const waits: number[] = [];
    for (let round = 0; round < 3; round++) {
      now += throttle.retryAfter('ip', key) * 1000 + 1000; // wait the lock out
      assert.equal(throttle.retryAfter('ip', key), 0);
      waits.push(throttle.fail('ip', key, CODE_LOCKOUT));
    }
    assert.deepEqual(waits, [2, 4, 8].map((k) => k * config.loginLimit.windowMs), 'each wrong code after a lock doubles it');
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('code sign-in: the lock answers 429 with its own Retry-After, refuses even the right code, is audited, and survives a restart', async () => {
  const first = await build();
  let second: Awaited<ReturnType<typeof build>> | null = null;
  try {
    for (let i = 1; i < config.loginLimit.attempts; i++) assert.equal((await login(first.call, WRONG)).status, 401, `wrong code ${i}`);
    const locked = await login(first.call, WRONG);
    assert.equal(locked.status, 429, 'the threshold-th wrong code locks');
    assert.equal(locked.headers.get('retry-after'), String(config.loginLimit.windowMs / 1000));
    const right = await login(first.call, CODE);
    assert.equal(right.status, 429, 'while locked even the right code is not tried');
    const wait = Number(right.headers.get('retry-after'));
    assert.ok(wait >= 1 && wait <= config.loginLimit.windowMs / 1000, `the remaining wait: ${wait}`);
    const audited = first.rows.filter((r) => r.kind === 'portal.signin_locked');
    assert.equal(audited.length, 1, 'one row when the lock starts, none per refusal');
    assert.deepEqual(audited[0]!.detail, { method: 'code', address: '127.0.0.1', lockS: config.loginLimit.windowMs / 1000 });
    assert.equal((await login(first.call, CODE, { ip: '10.9.9.9' })).status, 200, 'another address is not affected');

    first.close();
    second = await build({ dataDir: first.dataDir, key: first.key });
    assert.equal((await login(second.call, CODE)).status, 429, 'a restart does not lift the lock (auth_throttle)');
  } finally {
    if (second) second.done();
    else first.done();
  }
});

test('code sign-in behind the tunnel: two visitors on one hop have their own locks; a forged header from a public hop is ignored', async () => {
  const { call, done } = await build();
  try {
    await behindCloudflare(async () => {
      for (let i = 0; i < config.loginLimit.attempts; i++) await login(call, WRONG, via('198.51.100.20'));
      assert.equal((await login(call, CODE, via('198.51.100.20'))).status, 429, 'the guessing visitor is locked');
      assert.equal((await login(call, CODE, via('203.0.113.44'))).status, 200, 'another visitor behind the same tunnel is not');

      let last: Response | null = null;
      for (let i = 0; i <= config.loginLimit.attempts; i++) last = await login(call, WRONG, forged(`198.51.100.${100 + i}`));
      assert.equal(last!.status, 429, 'made-up CF-Connecting-IP values from a public hop are one key: the hop');
    });
  } finally {
    done();
  }
});

test('email sign-in behind the tunnel: the per-address lockout counts per visitor; a forged header from a public hop is ignored', async () => {
  const { call, done } = await build();
  // Another email every time, so the per-email lock (5) never trips: only the per-address one (20) does.
  let n = 0;
  const wrong = (init: Init) => call('POST', '/api/login', { ...init, body: { email: `nobody-${n++}@example.test`, password: 'not-the-password-at-all' } });
  try {
    await behindCloudflare(async () => {
      for (let i = 0; i < LOGIN_LIMITS.perIp.failures; i++) assert.equal((await wrong(via('198.51.100.30'))).status, 401);
      assert.equal((await wrong(via('198.51.100.30'))).status, 429, 'the visitor’s address is locked');
      assert.equal((await wrong(via('203.0.113.55'))).status, 401, 'another visitor behind the same tunnel is not');

      let last: Response | null = null;
      for (let i = 0; i <= LOGIN_LIMITS.perIp.failures; i++) last = await wrong(forged(`198.51.100.${100 + i}`));
      assert.equal(last!.status, 429, 'made-up CF-Connecting-IP values from a public hop are one key: the hop');
    });
  } finally {
    done();
  }
});

test('VS Code device sign-ins behind the tunnel: the per-address start limit counts per visitor; a forged header is ignored', async () => {
  // The start limit is 10 per address in 10 minutes (vscode/routes.ts). Its own message tells it apart from the pending cap (20 codes
  // waiting at once), so each half gets a fresh portal.
  const vscodeOn = async () => {
    const mcp = await portalMcpHarness();
    mcp.module.settings.update({ enabled: true, sessionControl: true });
    return mcp;
  };
  const fromHere = async (r: Response) => r.status === 429 && /from here/.test(((await r.json()) as { error: { message: string } }).error.message);
  const one = await build(undefined, await vscodeOn());
  const start = (call: typeof one.call, init: Init) => call('POST', '/api/vscode/device', { ...init, body: { client: 'vscode' } });
  try {
    await behindCloudflare(async () => {
      let last: Response | null = null;
      for (let i = 0; i <= 10; i++) last = await start(one.call, via('198.51.100.40'));
      assert.ok(await fromHere(last!), 'the visitor ran out of starts');
      assert.notEqual((await start(one.call, via('203.0.113.66'))).status, 429, 'another visitor behind the same tunnel did not');
    });
  } finally {
    one.done();
  }
  const two = await build(undefined, await vscodeOn());
  try {
    await behindCloudflare(async () => {
      let last: Response | null = null;
      for (let i = 0; i <= 10; i++) last = await start(two.call, forged(`198.51.100.${100 + i}`));
      assert.ok(await fromHere(last!), 'made-up CF-Connecting-IP values from a public hop are one key: the hop');
    });
  } finally {
    two.done();
  }
});

test('connect installer routes: wrong tokens count per visitor behind the tunnel (the default address), not per hop', async () => {
  const failed: string[] = [];
  const deps = { enrollments: { lookup: () => null }, log: () => {} } as unknown as InstallDeps;
  const app = new Hono();
  app.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    return c.json(err.toJSON(), err.status as ContentfulStatusCode);
  });
  app.route('/', createInstallRoutes(deps, { limiter: { blocked: () => false, fail: (ip) => void failed.push(ip) } }));
  const get = (init: Init) => app.request('/connect/v1/plan', { headers: { authorization: 'Bearer nope', ...init.headers } }, { incoming: { socket: { remoteAddress: init.ip } } });
  await behindCloudflare(async () => {
    assert.equal((await get(via('198.51.100.50'))).status, 401);
    assert.equal((await get(via('203.0.113.77'))).status, 401);
    assert.equal((await get(forged('198.51.100.51'))).status, 401);
  });
  assert.deepEqual(failed, ['198.51.100.50', '203.0.113.77', PUBLIC_HOP]);
});

test('/mcp and the connect module read the same visitor key: CF-Connecting-IP only from a private hop, with both trusts on', async () => {
  const ctx = (init: Init) => ({ req: { header: (n: string) => init.headers?.[n] }, env: { incoming: { socket: { remoteAddress: init.ip } } } }) as unknown as Context;
  const req = (init: Init) => ({ headers: init.headers ?? {}, socket: { remoteAddress: init.ip } }) as unknown as IncomingMessage;
  await behindCloudflare(async () => {
    assert.equal(mcpClientIp(ctx(via('198.51.100.60'))), '198.51.100.60');
    assert.equal(mcpClientIp(ctx(forged('198.51.100.61'))), PUBLIC_HOP);
    assert.equal(visitorOfRequest(req(via('198.51.100.62'))), '198.51.100.62');
    assert.equal(visitorOfRequest(req(forged('198.51.100.63'))), PUBLIC_HOP);
    assert.equal(visitorOfRequest(req(via('not-an-address'))), TUNNEL, 'a header that is not an address is ignored');
    assert.equal(visitorOfRequest(req(via('198.51.100.64')), false), TUNNEL, "connect's own trustProxy off: the socket, no header");
  });
  // Cloudflare not trusted (the default): the header is ignored even from the tunnel.
  const saved = { trustProxy: config.trustProxy, trustCloudflare: config.trustCloudflare };
  Object.assign(config, { trustProxy: true, trustCloudflare: false });
  try {
    assert.equal(mcpClientIp(ctx(via('198.51.100.65'))), TUNNEL);
    assert.equal(visitorOfRequest(req(via('198.51.100.66'))), TUNNEL);
  } finally {
    Object.assign(config, saved);
  }
});
