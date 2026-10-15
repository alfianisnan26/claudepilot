// T-531: every route under `/api/workspaces` goes through the authorization seam. Read off the app's own route table (so a route added later is
// covered without anyone remembering to add it): each one is declared, its declaration matches the PRD's target (the `/api/workspaces` rows of
// docs/prd/authorization.md Appendix A, read from the file, never copied here), and every object check it declares is asked, in order, before its
// handler runs, so a workspace the actor may not see is the same 404 as one that does not exist. The runtime routes (start, stop, adopt, remove,
// preflight) are also checked one by one: refused without touching the runtime, and the owner still gets through, with an audit row.
//
// The app is built with stub dependencies (as in qa/workspacepaths.test.ts), with the modules that mount routes on the workspaces router real.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { OBJECT_TYPES, isObjectType, workspaceRef, type Actor, type ObjectCheck, type ObjectRef, type RoutePolicy, type Verb } from '@portal/contracts';
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
    if (p === 'resolve') return (ref: string) => (ref === ID || ref === STABLE ? { id: STABLE, legacyId: ID, target: 'docker', name: NAME } : null);
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
/** The body every write sends: it names the target `POST /api/workspaces` checks (the other routes ignore it or are refused first). */
const BODY = { target: 'docker' };
const send = async (method: string, url: string) => {
  const res = await app.request(
    `http://localhost:3000${url}`,
    { method, headers: { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: `portal_session=${token}`, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) }, body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(BODY) },
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
/** The value each path parameter takes in a request; a parameter not named here is `x1`. */
const PARAMS: Record<string, string> = { target: 'docker', name: NAME, ref: STABLE };
const fill = (path: string) => path.replace(/:([A-Za-z]+)/g, (_m, k: string) => PARAMS[k] ?? 'x1');
/** The id a check names in that request: a body field, a stable id (asked as the `<target>/<name>` it resolves to), or path parameters joined by `/`. */
const idFor = (c: ObjectCheck): string =>
  c.from === 'body' ? String((BODY as Record<string, unknown>)[c.param]) : c.param === 'ref' ? ID : c.param.split('+').map((k) => PARAMS[k] ?? 'x1').join('/');
/** The verb a route declared on its workspace (the one `target+name` check). */
const declaredVerb = (key: string): Verb | undefined => {
  const p = declaredPolicies().get(key);
  return p?.kind === 'objects' ? p.checks.find((c) => c.type === 'workspace' && c.param === 'target+name')?.verb : undefined;
};

/* ---------- The target: the PRD's Appendix A, read from the file ---------- */

const PRD = readFileSync(new URL('../../../../docs/prd/authorization.md', import.meta.url), 'utf8');
/** §B.2, where every remaining difference must be named. */
const B2 = PRD.slice(PRD.indexOf('### B.2'), PRD.indexOf('## Appendix C'));
/** The `/api/workspaces` rows of Appendix A: route key → its Access cell. */
const TARGET = (() => {
  const rows = new Map<string, string>();
  for (const m of PRD.matchAll(/^\| `((?:GET|POST|PUT|PATCH|DELETE) \/api\/workspaces(?:\/[^`]*)?)` \| ([^|]+) \|/gm)) {
    const [key, access] = [m[1]!, m[2]!.trim()];
    assert.ok(!rows.has(key) || rows.get(key) === access, `${key} has two different rows in the PRD`);
    rows.set(key, access);
  }
  return rows;
})();

/** The text inside the first `obj( … )` of an Access cell, parentheses balanced. */
const objPart = (access: string): string | null => {
  const at = access.indexOf('obj(');
  if (at < 0) return null;
  let depth = 0;
  for (let i = at + 3; i < access.length; i++) {
    if (access[i] === '(') depth++;
    else if (access[i] === ')' && --depth === 0) return access.slice(at + 4, i);
  }
  throw new Error(`unbalanced obj( in ${access}`);
};

/**
 * What an Access cell asks, as sorted `type verb` lines, `list T` and `create T`. A check on a type that is guarded by its parent (`OBJECT_TYPES`:
 * a Claude, a terminal) brings the parent guard (`operate` on the workspace) unless the cell names a check on the parent itself. The team clause
 * of `POST /api/workspaces` is not a check yet (no teams); any other text the parser cannot read fails the test, so the notation cannot drift.
 */
const targetOf = (access: string): string[] => {
  const out = new Set<string>();
  for (const m of access.matchAll(/in:(list|create)\((\w+)\)/g)) out.add(`${m[1]} ${m[2]}`);
  const inner = objPart(access);
  const checks: [string, Verb][] = [];
  for (const seg of inner === null ? [] : inner.split(';').map((s) => s.trim())) {
    const m = /^(\w+) (view|operate|manage)\b/.exec(seg);
    if (m && isObjectType(m[1])) checks.push([m[1]!, m[2] as Verb]);
    else if (!/^team member of /.test(seg)) throw new Error(`cannot read "${seg}" in ${access}`);
  }
  for (const [type, verb] of checks) {
    out.add(`${type} ${verb}`);
    const info = OBJECT_TYPES[type as keyof typeof OBJECT_TYPES];
    if (info.inherit === 'guard' && info.parent && info.guard && !checks.some(([t]) => t === info.parent)) out.add(`${info.parent} ${info.guard}`);
  }
  return [...out].sort();
};

/** What a declaration asks, in the same lines. */
const declaredOf = (p: RoutePolicy | undefined): string[] => {
  if (!p) return ['undeclared'];
  const out = new Set<string>();
  if (p.kind === 'objects') for (const c of p.checks) out.add(`${c.type} ${c.verb}`);
  else if (p.kind === 'signed-in') {
    if (p.filter) out.add(`list ${p.filter}`);
  } else out.add(`kind ${p.kind}`);
  if ((p.kind === 'objects' || p.kind === 'signed-in') && p.creates) out.add(`create ${p.creates}`);
  return [...out].sort();
};

/**
 * Where the code is deliberately not the target, with what it declares instead. Each one must still differ from its row and be named in §B.2
 * (written there as `METHOD …/rest`); the test fails on a difference that is not listed here.
 */
const DIFFERENCES: Record<string, string[]> = {
  // Stricter on the workspace; the Claude check waits for a Claude resolver.
  'POST /api/workspaces/:target/:name/claude-login': ['workspace manage'],
  'POST /api/workspaces/:target/:name/claude-login/code': ['workspace manage'],
  'DELETE /api/workspaces/:target/:name/claude-login': ['workspace manage'],
  'POST /api/workspaces/:target/:name/claude-logout': ['workspace manage'],
  // Stricter: removing a Claude removes its login, so `manage` on the workspace too.
  'DELETE /api/workspaces/:target/:name/claudes/:claude': ['claude manage', 'workspace manage'],
  // The pool ids in the body are not checked yet (T-538).
  'PUT /api/workspaces/:target/:name/account': ['workspace manage'],
  'PUT /api/workspaces/:target/:name/pools/:type': ['workspace manage'],
};
const shortKey = (key: string) => key.replace('/api/workspaces/:target/:name', '…');

afterEach(() => {
  clearResolvers();
  touched.length = 0;
  audits.length = 0;
  runtimeCalls.length = 0;
});

test('every route under /api/workspaces is declared with the seam, and every declaration is a route', () => {
  assert.ok(routes.size >= 45, `found only ${routes.size} routes under /api/workspaces; the route table must have changed shape`);
  const undeclared = [...routes.keys()].filter((key) => !declaredPolicies().has(key as never));
  assert.deepEqual(undeclared, [], 'routes under /api/workspaces with no declaration');
  const stale = [...declaredPolicies().keys()].filter((key) => /^[A-Z]+ \/api\/workspaces(\/|$)/.test(key) && !routes.has(key));
  assert.deepEqual(stale, [], 'declarations under /api/workspaces with no route');
  // The runtime routes: their audit rows.
  for (const [key, audit] of [
    ['POST /api/workspaces/:target/:name/start', 'workspace.start'],
    ['POST /api/workspaces/:target/:name/stop', 'workspace.stop'],
    ['POST /api/workspaces/:target/:name/adopt', 'workspace.adopt'],
    ['DELETE /api/workspaces/:target/:name', 'workspace.remove'],
    ['GET /api/workspaces/:target/:name/preflight', undefined],
  ] as const) {
    assert.equal(WORKSPACE_POLICIES[key as keyof typeof WORKSPACE_POLICIES]?.audit, audit, `${key} audit`);
  }
});

test('every declaration under /api/workspaces matches its row in the PRD target table (Appendix A), or is a difference §B.2 names', () => {
  assert.ok(TARGET.size >= 45, `read only ${TARGET.size} /api/workspaces rows from the PRD; its table must have changed shape`);
  assert.deepEqual([...routes.keys()].filter((k) => !TARGET.has(k)), [], 'routes with no row in Appendix A');
  assert.deepEqual([...TARGET.keys()].filter((k) => !routes.has(k)), [], 'Appendix A rows with no route');
  const failures: string[] = [];
  for (const key of routes.keys()) {
    const declared = declaredOf(declaredPolicies().get(key));
    const target = targetOf(TARGET.get(key)!);
    const listed = DIFFERENCES[key];
    if (listed) {
      if (JSON.stringify(declared) !== JSON.stringify([...listed].sort())) failures.push(`${key}: declares ${declared.join(', ')}, the listed difference says ${listed.join(', ')}`);
      if (JSON.stringify(declared) === JSON.stringify(target)) failures.push(`${key}: listed as a difference but matches the target; take it off the list`);
      if (!B2.includes(`\`${shortKey(key)}\``)) failures.push(`${key}: a difference §B.2 does not name (as \`${shortKey(key)}\`)`);
    } else if (JSON.stringify(declared) !== JSON.stringify(target)) failures.push(`${key}: declares ${declared.join(', ')}; the PRD target is ${target.join(', ')}`);
  }
  for (const key of Object.keys(DIFFERENCES)) if (!routes.has(key)) failures.push(`${key}: a listed difference with no route`);
  assert.deepEqual(failures, []);
  // The ticket's verbs, spelled out (the table above decides; these say what it decided).
  for (const [key, verb] of [
    ['POST /api/workspaces/:target/:name/start', 'operate'],
    ['POST /api/workspaces/:target/:name/stop', 'operate'],
    ['GET /api/workspaces/:target/:name/preflight', 'operate'],
    ['POST /api/workspaces/:target/:name/adopt', 'manage'],
    ['DELETE /api/workspaces/:target/:name', 'manage'],
    ['GET /api/workspaces/:target/:name/terminals', 'operate'],
    ['GET /api/workspaces/:target/:name/secrets', 'operate'],
    ['PUT /api/workspaces/:target/:name/repos/settings', 'manage'],
    ['POST /api/workspaces/:target/:name/browser/install/retry', 'manage'],
  ] as const) assert.equal(declaredVerb(key), verb, key);
});

test('the PRD reader reads the notation, and fails on what it cannot read', () => {
  assert.deepEqual(targetOf('obj(claude manage path claude)'), ['claude manage', 'workspace operate'], 'a Claude brings its parent guard');
  assert.deepEqual(targetOf('obj(workspace operate path target+name; claude manage query claude (default Claude when absent))'), ['claude manage', 'workspace operate']);
  assert.deepEqual(targetOf('obj(target operate body target; team member of body ownerTeamId when set) in:create(workspace)'), ['create workspace', 'target operate']);
  assert.deepEqual(targetOf('in:list(workspace)'), ['list workspace']);
  assert.throws(() => targetOf('obj(workspace whatever path target+name)'));
});

test('every declared object check is asked, in order, before the handler; a refusal at any one is the same 404 and touches nothing (/:target/:name, /:ref and POST /)', async () => {
  const guarded = [...routes].filter(([key]) => declaredPolicies().get(key)?.kind === 'objects');
  assert.ok(guarded.length >= 44, `found only ${guarded.length} routes with object checks`);
  for (const must of ['GET /api/workspaces/:ref', 'PATCH /api/workspaces/:ref', 'GET /api/workspaces/:ref/resources', 'PATCH /api/workspaces/:ref/resources', 'POST /api/workspaces'])
    assert.ok(guarded.some(([key]) => key === must), `${must} is covered`);
  const asked: string[] = [];
  let refuse = '';
  // A layer that writes down what it was asked, refuses one object as "no such object" and allows the rest.
  const layer: Authz = {
    ...singleOwner,
    can: (_actor: Actor, verb: Verb, object: ObjectRef) => {
      asked.push(`${object.type} ${verb} ${object.id}`);
      return `${object.type} ${object.id}` === refuse ? { allow: false, reason: 'not_found', level: 'none' } : { allow: true, level: 'manage' };
    },
  };
  const was = useAuthz(layer);
  const failures: string[] = [];
  try {
    for (const [key, r] of guarded) {
      const policy = declaredPolicies().get(key);
      const checks = policy?.kind === 'objects' ? policy.checks : [];
      const expected = checks.map((c) => `${c.type} ${c.verb} ${idFor(c)}`);
      for (let i = 0; i < checks.length; i++) {
        asked.length = 0;
        touched.length = 0;
        runtimeCalls.length = 0;
        refuse = `${checks[i]!.type} ${idFor(checks[i]!)}`;
        const res = await send(r.method, fill(r.path));
        const at = `${key} [refused at ${refuse}]`;
        if (res.status !== 404 || res.body.error?.code !== 'NOT_FOUND' || res.body.error.message !== 'Not found.') failures.push(`${at}: ${res.status} ${res.body.error?.code} ${res.body.error?.message}`);
        if (JSON.stringify(asked) !== JSON.stringify(expected.slice(0, i + 1))) failures.push(`${at}: asked ${JSON.stringify(asked)}, declared ${JSON.stringify(expected.slice(0, i + 1))}`);
        const reached = [...touched.filter((t) => !t.startsWith('store.') && !t.startsWith('workspaces.resolve')), ...runtimeCalls];
        if (reached.length) failures.push(`${at}: reached ${reached.slice(0, 3).join(', ')}`);
      }
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
  // The stable-id form too, before the manager is asked.
  touched.length = 0;
  const byRef = await send('GET', `/api/workspaces/${STABLE}`);
  assert.deepEqual([byRef.status, byRef.body.error?.message], [404, 'Not found.'], 'GET /:ref');
  assert.deepEqual(touched.filter((t) => !t.startsWith('store.') && !t.startsWith('workspaces.resolve')), [], 'the manager was not asked');
  assert.deepEqual(runtimeCalls, [], 'nothing reached the runtime or the reconciler');
  assert.deepEqual(audits, [], 'and nothing was audited');
});

test('a viewer may not run the preflight, list terminals or read the secrets names; an operator may not adopt or remove (403, as the seam answers it)', async () => {
  let level: 'view' | 'operate' = 'view';
  registerResolver({ type: 'workspace', resolve: (id) => (id === ID ? { ref: workspaceRef(id), owner: { kind: 'user', id: 'u_b' }, publicLevel: level } : null) });
  for (const suffix of ['/preflight', '/terminals', '/secrets']) {
    const res = await send('GET', `/api/workspaces/${ID}${suffix}`);
    assert.deepEqual([res.status, res.body.error?.code, res.body.error?.details?.verb], [403, 'FORBIDDEN', 'operate'], `a viewer: GET ${suffix}`);
  }
  assert.deepEqual(runtimeCalls, [], 'the preflight never looked for the runtime');
  level = 'operate';
  for (const [method, suffix] of [['DELETE', ''], ['POST', '/adopt']] as const) {
    const res = await send(method, `/api/workspaces/${ID}${suffix}`);
    assert.deepEqual([res.status, res.body.error?.code, res.body.error?.details?.verb], [403, 'FORBIDDEN', 'manage'], `an operator: ${method} ${suffix}`);
  }
  const started = await send('POST', `/api/workspaces/${ID}/start`);
  assert.equal(started.status, 200, 'operate is enough to start');
  const checked = await send('GET', `/api/workspaces/${ID}/preflight`);
  assert.equal(checked.status, 200, 'and to run the preflight');
  assert.deepEqual(runtimeCalls, [`start ${ID}`, 'runtimeFor']);
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
