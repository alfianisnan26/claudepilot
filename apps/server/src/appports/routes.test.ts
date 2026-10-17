// T-948 S1 (docs/prd/app-ports.md §3, §8): the portal's own routes. The open mints a code for the owner (audited) and is the same 404 as a
// missing workspace when the seam says no; a portal mutation with an app host's Origin is refused (the CSRF guard), so a page on an app host
// can never drive the portal. The app is built with stub dependencies, as in workspaces/routeAuthz.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../app.js';
import { singleOwner, useAuthz } from '../authz/seam.js';
import { Portal } from '../portal.js';
import { AppPortGrants } from './grants.js';
import { AppPorts } from './index.js';

const spy = (): object =>
  new Proxy(function () {}, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : spy()),
    apply: () => spy(),
    construct: () => spy(),
    set: () => true,
  });

const SUFFIX = 'apps.test';
const audits: { kind: string; actor: string; subject?: string | null; detail?: Record<string, unknown> }[] = [];
const execs: string[][] = [];
/**
 * The exec of the list. Its output and its exit come in one fixed order, never by timers racing (FIX4: a 5 ms exit timer beat the output
 * on a loaded node, 4 of 7 runs). `late`: the exit is reported first and the output follows in the same turn, which collect() must still keep.
 */
let late = false;
const wsDeps = {
  runtimeFor: () => undefined,
  exec: async (_t: string, _n: string, command: string[]) => {
    execs.push(command);
    const out = Buffer.from(JSON.stringify([{ port: 8765, process: 'python3' }, { port: 3000 }, { port: 22 }]));
    let data: (d: Buffer) => void = () => undefined;
    return {
      write() {},
      close() {},
      onData: (fn: (d: Buffer) => void) => void (data = fn),
      onExit: (fn: (c: number) => void) =>
        void setImmediate(() => {
          if (late) return void (fn(0), process.nextTick(() => data(out)));
          data(out);
          fn(0);
        }),
    };
  },
  list: async () => [
    { id: 'kubernetes/kohi-event', name: 'kohi-event' },
    { id: 'docker/other', name: 'other' },
  ],
  hooks: { audit: (e: (typeof audits)[number]) => void audits.push(e) },
  resolve: () => null,
};
const grants = new AppPortGrants();
const appPorts = new AppPorts({ suffix: SUFFIX, portalPort: 3000, workspaces: wsDeps as never, sessionValid: () => true, grants, dial: async () => assert.fail('no dial here') });

const portal = new Portal('24681357', 60_000);
const token = portal.signIn('24681357');
const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
const build = (ports?: AppPorts) =>
  make(portal, spy(), spy(), spy(), spy(), spy(), spy(), spy(), {
    serveWeb: false,
    poolService: spy(),
    mcp: spy(),
    skills: spy(),
    personas: spy(),
    settings: spy(),
    portalMcp: spy(),
    tickets: spy(),
    ci: spy(),
    knowledge: spy(),
    repos: spy(),
    claudeVersions: spy(),
    claudeUsage: spy(),
    ...(ports ? { appPorts: ports } : {}),
  });
const app = build(appPorts);
const env = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const PORTAL = `pilot.${SUFFIX}`;

const call = async (a: import('hono').Hono, method: string, path: string, opts: { origin?: string; body?: unknown } = {}) => {
  const res = await a.request(
    `https://${PORTAL}${path}`,
    {
      method,
      headers: { host: PORTAL, cookie: `portal_session=${token}`, ...(opts.origin ? { origin: opts.origin } : {}), ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    },
    env,
  );
  return { status: res.status, json: (await res.json().catch(() => ({}))) as { data?: Record<string, unknown>; error?: { code: string } } };
};

const OPEN = '/api/workspaces/kubernetes/kohi-event/ports/open';
const LIST = '/api/workspaces/kubernetes/kohi-event/ports';

test('the owner opens a port: a URL on the app host with a one-time code, audited, for the Tradingbot on kohi-event', async () => {
  audits.length = 0;
  const before = grants.size.codes;
  const r = await call(app, 'POST', OPEN, { origin: `https://${PORTAL}`, body: { port: 8765, path: '/dash' } });
  assert.equal(r.status, 200);
  const url = new URL(String(r.json.data?.url));
  assert.equal(url.host, `app-kohi-event-8765.${SUFFIX}`);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.pathname, '/__pilot/auth');
  assert.equal(url.searchParams.get('next'), '/dash');
  assert.match(url.searchParams.get('code') ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.equal(r.json.data?.host, `app-kohi-event-8765.${SUFFIX}`);
  assert.equal(grants.size.codes, before + 1);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]!.kind, 'workspace.port.open');
  assert.deepEqual(audits[0]!.detail, { workspace: 'kubernetes/kohi-event', port: 8765 });
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(url.searchParams.get('code')!), 'the code is never in the audit row');
});

test('the list: the listening ports with their process, the portal’s own and low ports not openable', async () => {
  const r = await call(app, 'GET', LIST);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.data, {
    enabled: true,
    ports: [
      { port: 8765, process: 'python3', openable: true },
      { port: 3000, openable: false },
      { port: 22, openable: false },
    ],
  });
  assert.equal(execs.at(-1)![0], 'node');
});

test('the list keeps output that lands just after the exit (a stream a tick behind)', async () => {
  late = true;
  try {
    const r = await call(app, 'GET', LIST);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((r.json.data?.ports as unknown[]).length, 3);
  } finally {
    late = false;
  }
});

test('a seam denial is the same 404 on the open and the list, and mints nothing', async () => {
  const before = grants.size.codes;
  const n = execs.length;
  const was = useAuthz({ ...singleOwner, can: (a, v, o) => (o.type === 'workspace' ? { allow: false, reason: 'not_found', level: 'none' } : singleOwner.can(a, v, o)) });
  try {
    const open = await call(app, 'POST', OPEN, { origin: `https://${PORTAL}`, body: { port: 8765 } });
    assert.equal(open.status, 404);
    assert.equal(open.json.error?.code, 'NOT_FOUND');
    assert.equal((await call(app, 'GET', LIST)).status, 404);
  } finally {
    useAuthz(was);
  }
  assert.equal(grants.size.codes, before);
  assert.equal(execs.length, n, 'the workspace was not touched');
});

test('an app host’s Origin (or any foreign one) is refused on portal mutations', async () => {
  const before = grants.size.codes;
  for (const origin of [`https://app-kohi-event-8765.${SUFFIX}`, `https://app-other-3001.${SUFFIX}`, 'https://evil.test']) {
    const open = await call(app, 'POST', OPEN, { origin, body: { port: 8765 } });
    assert.equal(open.status, 403, origin);
    const stop = await call(app, 'POST', '/api/workspaces/kubernetes/kohi-event/stop', { origin, body: {} });
    assert.equal(stop.status, 403, origin);
  }
  assert.equal(grants.size.codes, before);
});

test('off (no suffix): the list says so, the open is 404', async () => {
  const off = build();
  const list = await call(off, 'GET', LIST);
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.data, { enabled: false, ports: [] });
  assert.equal((await call(off, 'POST', OPEN, { origin: `https://${PORTAL}`, body: { port: 8765 } })).status, 404);
});
