// T-531: every route under `/api/workspaces` goes through the authorization seam. Read off the app's own route table (so a route added later is
// covered without anyone remembering to add it): each one is declared, each `/:target/:name…` one asks the seam for the verb it declared before
// its handler runs, and a workspace the actor may not see is the same 404 as one that does not exist. The runtime routes (start, stop, adopt,
// remove, preflight) are also checked one by one: refused without touching the runtime, and the owner still gets through, with an audit row.
//
// The app is built with stub dependencies (as in qa/workspacepaths.test.ts), with the modules that mount routes on the workspaces router real.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { workspaceRef, type Actor, type ObjectRef, type Verb } from '@portal/contracts';
import { createApp } from '../app.js';
import { clearResolvers, declaredPolicies, registerResolver, singleOwner, useAuthz, type Authz } from '../authz/seam.js';
import { createBrowserRoutes } from '../browser/routes.js';
import { Portal } from '../portal.js';
import { WORKSPACE_POLICIES } from './authz.js';

/** Counts what the app asks of its dependencies, so a refused request can be shown to have touched none of them. */
const touched: string[] = [];
const spy = (what: string): object =>
  new Proxy(function () {}, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : (touched.push(`${what}.${String(p)}`), spy(`${what}.${String(p)}`))),
    apply: () => (touched.push(`${what}()`), spy(`${what}()`)),
    construct: () => spy(`new ${what}`),
    set: () => true,
  });

const NAME = 'ws-1';
const ID = `docker/${NAME}`;
const STABLE = `ws_${'a'.repeat(12)}`;
const audits: { kind: string; actor: string; subject?: string | null; detail?: Record<string, unknown> }[] = [];
const runtimeCalls: string[] = [];

/** The workspace manager: a stub, except what these routes need to answer and what the test reads back. */
const base = spy('workspaces') as Record<string | symbol, unknown>;
const workspaces = new Proxy(base, {
  get: (t, p) => {
    if (p === 'hooks') return { audit: (e: (typeof audits)[number]) => void audits.push(e) };
    if (p === 'start' || p === 'stop' || p === 'remove') return async (target: string, name: string) => void runtimeCalls.push(`${String(p)} ${target}/${name}`);
    if (p === 'resolve') return (ref: string) => (ref === ID ? { id: STABLE, legacyId: ID, target: 'docker', name: NAME } : null);
    if (p === 'runtimeFor') return () => (runtimeCalls.push('runtimeFor'), undefined);
    if (p === 'list') return async () => [ID, 'docker/mine'].map((id) => ({ id, name: id.split('/')[1], target: 'docker', image: 'img', status: 'running', createdAt: '2026-10-01T00:00:00.000Z' }));
    if (p === 'usage') return async () => [ID, 'docker/mine'].map((id) => ({ id, cpuPercent: 1, memoryBytes: 1 }));
    return t[p];
  },
});
const reconciler = new Proxy(spy('reconciler') as Record<string | symbol, unknown>, {
  get: (t, p) => (p === 'adopt' ? async (id: string) => void runtimeCalls.push(`adopt ${id}`) : t[p]),
});

const portal = new Portal('24681357', 60_000);
const token = portal.signIn('24681357');
const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
const app = make(portal, workspaces, spy('store'), spy('accounts'), spy('pools'), reconciler, spy('health'), spy('chat'), {
  serveWeb: false,
  poolService: spy('poolService'),
  mcp: spy('mcp'),
  skills: spy('skills'),
  personas: spy('personas'),
  settings: spy('settings'),
  portalMcp: spy('portalMcp'),
  tickets: spy('tickets'),
  ci: spy('ci'),
  knowledge: spy('knowledge'),
  browser: { routes: () => createBrowserRoutes(spy('browserService') as never) },
  repos: spy('repos'),
  claudeVersions: spy('claudeVersions'),
  claudeUsage: spy('claudeUsage'),
});
const env = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const send = async (method: string, url: string) => {
  const res = await app.request(
    `http://localhost:3000${url}`,
    { method, headers: { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: `portal_session=${token}`, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' },
    env,
  );
  const text = await res.text();
  let body: { data?: unknown; error?: { code: string; message: string; details?: { verb?: string } } } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    /* not JSON */
  }
  return { status: res.status, body };
};

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** Every route the app answers under /api/workspaces, once each (a route with a guard is listed twice by Hono), keyed as the seam declares. */
const routes = (() => {
  const seen = new Map<string, { method: string; path: string }>();
  for (const r of app.routes) {
    if (!METHODS.has(r.method) || r.path.includes('*')) continue;
    const path = r.path.replace(/\/$/, '');
    if (path !== '/api/workspaces' && !path.startsWith('/api/workspaces/')) continue;
    seen.set(`${r.method} ${path}`, { method: r.method, path });
  }
  return seen;
})();
const onOneWorkspace = [...routes].filter(([, r]) => r.path.includes('/:target/:name'));
const fill = (path: string) => path.replace(':target', 'docker').replace(':name', NAME).replace(/:[A-Za-z]+/g, 'x1');
/** The verb a route declared on its workspace (the one `target+name` check). */
const declaredVerb = (key: string): Verb | undefined => {
  const p = declaredPolicies().get(key);
  return p?.kind === 'objects' ? p.checks.find((c) => c.type === 'workspace' && c.param === 'target+name')?.verb : undefined;
};

afterEach(() => {
  clearResolvers();
  touched.length = 0;
  audits.length = 0;
  runtimeCalls.length = 0;
});

test('every route under /api/workspaces is declared with the seam, and every declaration is a route', () => {
  assert.ok(routes.size >= 45,`found only ${routes.size} routes under /api/workspaces; the route table must have changed shape`);
  const undeclared = [...routes.keys()].filter((key) => !declaredPolicies().has(key as never));
  assert.deepEqual(undeclared, [], 'routes under /api/workspaces with no declaration');
  const stale = [...declaredPolicies().keys()].filter((key) => /^[A-Z]+ \/api\/workspaces(\/|$)/.test(key) && !routes.has(key));
  assert.deepEqual(stale, [], 'declarations under /api/workspaces with no route');
  // The runtime routes, with the verbs the ticket set: start, stop and adopt run it, remove destroys it (the strongest verb), preflight reads.
  for (const [key, verb, audit] of [
    ['POST /api/workspaces/:target/:name/start', 'operate', 'workspace.start'],
    ['POST /api/workspaces/:target/:name/stop', 'operate', 'workspace.stop'],
    ['POST /api/workspaces/:target/:name/adopt', 'operate', 'workspace.adopt'],
    ['DELETE /api/workspaces/:target/:name', 'manage', 'workspace.remove'],
    ['GET /api/workspaces/:target/:name/preflight', 'view', undefined],
  ] as const) {
    assert.equal(declaredVerb(key), verb, key);
    assert.equal(WORKSPACE_POLICIES[key as keyof typeof WORKSPACE_POLICIES]?.audit, audit, `${key} audit`);
  }
});

test('each /:target/:name route asks the seam for exactly the verb it declared, before its handler; a refusal is the same 404 and touches nothing', async () => {
  assert.ok(onOneWorkspace.length >= 35,`found only ${onOneWorkspace.length} workspace routes`);
  const asked: { verb: Verb; object: ObjectRef }[] = [];
  // A layer that refuses everything as "no such object" and writes down what it was asked.
  const refuseAll: Authz = { ...singleOwner, can: (_actor: Actor, verb: Verb, object: ObjectRef) => (asked.push({ verb, object }), { allow: false, reason: 'not_found', level: 'none' }) };
  const was = useAuthz(refuseAll);
  const failures: string[] = [];
  try {
    for (const [key, r] of onOneWorkspace) {
      asked.length = 0;
      touched.length = 0;
      runtimeCalls.length = 0;
      const res = await send(r.method, fill(r.path));
      const verb = declaredVerb(key);
      const onIt = asked.filter((a) => a.object.type === 'workspace' && a.object.id === ID).map((a) => a.verb);
      if (res.status !== 404 || res.body.error?.code !== 'NOT_FOUND' || res.body.error.message !== 'Not found.') failures.push(`${key}: ${res.status} ${res.body.error?.code} ${res.body.error?.message}`);
      if (!verb || onIt[0] !== verb) failures.push(`${key}: asked ${JSON.stringify(onIt)}, declared ${verb}`);
      const reached = [...touched.filter((t) => !t.startsWith('store.') && !t.startsWith('workspaces.resolve')), ...runtimeCalls];
      if (reached.length) failures.push(`${key}: reached ${reached.slice(0, 3).join(', ')}`);
    }
  } finally {
    useAuthz(was);
  }
  assert.deepEqual(failures, []);
});

test('a signed-in user who may not see the workspace gets the 404 for start, stop, remove, adopt and preflight, and the runtime is never asked', async () => {
  // The workspace is someone else's: the single-owner seam decides by the resolver (how a module tests default deny today).
  registerResolver({ type: 'workspace', resolve: (id) => (id === ID ? { ref: workspaceRef(id), owner: { kind: 'user', id: 'u_b' } } : null) });
  const missing = await send('GET', '/api/workspaces/docker/nope');
  for (const [method, suffix] of [['POST', '/start'], ['POST', '/stop'], ['DELETE', ''], ['POST', '/adopt'], ['GET', '/preflight']] as const) {
    const res = await send(method, `/api/workspaces/${ID}${suffix}`);
    assert.deepEqual([res.status, res.body.error?.code, res.body.error?.message], [404, 'NOT_FOUND', 'Not found.'], `${method} ${suffix}`);
    assert.deepEqual([res.status, res.body.error], [missing.status, missing.body.error], `${method} ${suffix}: the same answer as a workspace that does not exist`);
  }
  assert.deepEqual(runtimeCalls, [], 'nothing reached the runtime or the reconciler');
  assert.deepEqual(audits, [], 'and nothing was audited');
});

test('a user who sees the workspace without the right verb is refused before the runtime (403, as the seam answers it)', async () => {
  registerResolver({ type: 'workspace', resolve: (id) => (id === ID ? { ref: workspaceRef(id), owner: { kind: 'user', id: 'u_b' }, publicLevel: 'operate' } : null) });
  const removed = await send('DELETE', `/api/workspaces/${ID}`);
  assert.deepEqual([removed.status, removed.body.error?.code, removed.body.error?.details?.verb], [403, 'FORBIDDEN', 'manage'], 'remove needs manage');
  const started = await send('POST', `/api/workspaces/${ID}/start`);
  assert.equal(started.status, 200, 'operate is enough to start');
  assert.deepEqual(runtimeCalls, [`start ${ID}`]);
});

test('the owner still starts, stops, adopts, removes and runs the preflight; each runtime action writes its audit row', async () => {
  for (const [method, suffix] of [['POST', '/start'], ['POST', '/stop'], ['POST', '/adopt'], ['GET', '/preflight'], ['DELETE', '']] as const) {
    const res = await send(method, `/api/workspaces/${ID}${suffix}`);
    assert.equal(res.status, 200, `${method} ${suffix}: ${JSON.stringify(res.body.error)}`);
  }
  assert.deepEqual(runtimeCalls, [`start ${ID}`, `stop ${ID}`, `adopt ${ID}`, 'runtimeFor', `remove ${ID}`]);
  assert.deepEqual(
    audits.map((a) => [a.kind, a.actor, a.subject, a.detail?.workspace]),
    ['workspace.start', 'workspace.stop', 'workspace.adopt', 'workspace.remove'].map((kind) => [kind, 'user:u_owner', STABLE, ID]),
  );
});

test('the workspace lists keep what the actor may view', async () => {
  registerResolver({ type: 'workspace', resolve: (id) => ({ ref: workspaceRef(id), owner: { kind: 'user', id: id === ID ? 'u_b' : 'u_owner' } }) });
  const list = await send('GET', '/api/workspaces');
  assert.deepEqual([list.status, (list.body.data as { id: string }[]).map((w) => w.id)], [200, ['docker/mine']]);
  const usage = await send('GET', '/api/workspaces/usage');
  assert.deepEqual([usage.status, (usage.body.data as { id: string }[]).map((w) => w.id)], [200, ['docker/mine']]);
});
