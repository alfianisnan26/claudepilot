// QA regression (QA-029): a workspace target or name that is not a plain name never reaches a runtime. The names end up in Docker API
// URLs, tmux session names and shell commands; `..%2f..%2fcontainers` made the Docker daemon answer a redirect that crashed the portal.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp, PLAIN_NAME } from '../app.js';
import { Portal } from '../portal.js';

/** Counts what the app asks of its dependencies, so a refused request can be shown to have touched none of them. */
const touched: string[] = [];
const spy = (what: string): object =>
  new Proxy(function () {}, {
    get: (_t, p) => (p === Symbol.toPrimitive ? () => 'stub' : p === 'then' ? undefined : (touched.push(`${what}.${String(p)}`), spy(`${what}.${String(p)}`))),
    apply: () => (touched.push(`${what}()`), spy(`${what}()`)),
    construct: () => spy(`new ${what}`),
    set: () => true,
  });
const portal = new Portal('24681357', 60_000);
const token = portal.signIn('24681357');
const make = createApp as unknown as (...args: unknown[]) => import('hono').Hono;
// Every optional module is stubbed too, so every route group is mounted and the route list below is the whole API.
const app = make(portal, spy('workspaces'), spy('store'), spy('accounts'), spy('pools'), spy('reconciler'), spy('health'), spy('chat'), {
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
  browser: spy('browser'),
  claudeUsage: spy('claudeUsage'),
});
const env = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const send = (method: string, url: string) =>
  app.request(`http://localhost:3000${url}`, { method, headers: { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: `portal_session=${token}`, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' }, env);

const ROUTES: [string, string][] = [
  ['GET', '/claude-login'], ['POST', '/claude-login'], ['POST', '/claude-login/code'], ['DELETE', '/claude-login'], ['POST', '/claude-logout'],
  ['GET', '/terminals'], ['POST', '/terminals'], ['DELETE', '/terminals/claude-1'], ['GET', '/claudes'], ['PATCH', '/claudes/c1'], ['DELETE', '/claudes/c1'],
  ['PUT', '/account'], ['GET', '/preflight'], ['POST', '/adopt'], ['POST', '/start'], ['POST', '/stop'], ['DELETE', ''],
  ['GET', '/pools'], ['PUT', '/pools/secrets'], ['GET', '/secrets'], ['POST', '/secrets/check'],
];
// (A segment that is exactly `..` or `%2e%2e` is resolved by the URL parser before routing, so a client cannot send it as a name; these can.)
const HOSTILE = [ '..%2f..%2fetc%2fpasswd', 'x%2f..%2f..%2fcontainers', 'a%2fb', 'a%00b', 'a%0ab', 'a%20b', '%F0%9F%98%80', '%', "x'--", 'a%3Fb', 'a%23b', 'x'.repeat(64), '-x', '.hidden', 'a%5Cb'];

test('a name that is not plain is a workspace that does not exist, for every workspace route, and no runtime is asked', async () => {
  touched.length = 0;
  for (const bad of HOSTILE) {
    for (const [method, suffix] of ROUTES) {
      const res = await send(method, `/api/workspaces/docker/${bad}${suffix}`);
      assert.equal(res.status, 404, `${method} name ${bad}${suffix} -> ${res.status}`);
      const res2 = await send(method, `/api/workspaces/${bad}/ws-1${suffix}`);
      assert.equal(res2.status, 404, `${method} target ${bad}${suffix} -> ${res2.status}`);
    }
  }
  assert.deepEqual(touched.filter((t) => !t.startsWith('store.') && !t.startsWith('workspaces.runtimeFor')), [], 'nothing was called on a dependency for a hostile name');
});

test('plain names are what the check lets through', () => {
  for (const good of ['ws-1', 'qa-ws1', 'local', 'My-Laptop', 'a.b_c', 'x'.repeat(63), '0abc', 'docker-host']) assert.ok(PLAIN_NAME.test(good), good);
  for (const bad of ['', '..', 'a/b', 'a b', 'a\0b', 'a\nb', 'x'.repeat(64), '-x', '.x', '_x', 'é', '😀', 'a%2fb', 'a?b', 'a#b', 'a\\b']) assert.equal(PLAIN_NAME.test(bad), false, JSON.stringify(bad));
});

// The routes above are a hand-written list. This one is read off the app itself, so a module that adds `/:target/:name/...` anywhere
// (the MCP sets, skills, personas, lockdown, the portal MCP's agent switches, a later page) is checked without anyone remembering to add it.
test('every route in the API that takes a workspace target and name refuses a name that is not plain, whichever module owns it', async () => {
  const withBoth = app.routes.filter((r) => r.method !== 'ALL' && r.path.includes(':target') && r.path.includes(':name'));
  assert.ok(withBoth.length >= 25, `found only ${withBoth.length} routes with :target and :name; the route list must have changed shape`);
  touched.length = 0;
  const failures: string[] = [];
  const fill = (path: string, target: string, name: string) => path.replace(':target', target).replace(':name', name).replace(/:[A-Za-z]+/g, 'x1');
  for (const route of withBoth) {
    for (const bad of HOSTILE) {
      for (const [target, name] of [['docker', bad], [bad, 'ws-1']] as const) {
        const url = fill(route.path, target, name);
        const res = await send(route.method, url);
        if (res.status !== 404) failures.push(`${route.method} ${url} -> ${res.status}`);
      }
    }
  }
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} requests with a hostile workspace name were not refused as 404 (first 20 shown)`);
  assert.deepEqual(touched.filter((t) => !t.startsWith('store.') && !t.startsWith('workspaces.runtimeFor')), [], 'nothing was called on a dependency for a hostile name');
});

// QA-032: the same ids in a body or a query string (pool assignments, a new chat session, tickets, CI) reached Docker and stayed in the database.
const HOSTILE_IDS = ['docker/x%2f..%2f..%2fcontainers', '../x', 'docker/..%2fx', 'docker/a%00b', "docker/x'--", 'docker/x?force=true', 'docker/a b', 'docker//', 'docker/x/y', `docker/${'x'.repeat(64)}`, 'x', '😀/x'];
const sendJson = (method: string, url: string, body: unknown) =>
  app.request(`http://localhost:3000${url}`, { method, headers: { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: `portal_session=${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);

test('a workspace id that is not <target>/<name> of plain names is refused in any body or query, signed in, before a handler sees it', async () => {
  const mutating = app.routes.filter((r) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && r.path.startsWith('/api/') && !r.path.includes('*') && !/^\/api\/(login|logout)$/.test(r.path));
  assert.ok(mutating.length > 90, `only ${mutating.length} mutating routes found`);
  touched.length = 0;
  const failures: string[] = [];
  for (const route of mutating) {
    const url = route.path.replace(/:[A-Za-z]+/g, 'x1');
    for (const id of HOSTILE_IDS) {
      for (const body of [{ workspaceId: id }, { workspaceIds: ['docker/ws-1', id] }, { workspace: id }, { workspaces: [id] }]) {
        const res = await sendJson(route.method, url, body);
        // 422 from the check; a route under /api/workspaces/:target/:name answers 404 first only when the path itself is not plain, which `x1` is.
        if (res.status !== 422) failures.push(`${route.method} ${url} ${JSON.stringify(body).slice(0, 60)} -> ${res.status}`);
      }
    }
  }
  assert.deepEqual(failures.slice(0, 10), [], `${failures.length} hostile ids were not refused with 422 (first 10 shown)`);
  assert.deepEqual(touched.filter((t) => !t.startsWith('store.') && !t.startsWith('workspaces.runtimeFor')), [], 'nothing was called on a dependency for a hostile id');
  // Query strings, on reads too.
  for (const [url, field] of [['/api/chat/claudes?workspaceId=', 'workspaceId'], ['/api/ci/repos?workspace=', 'workspace'], ['/api/chat/trust?workspaceId=', 'workspaceId']] as const) {
    for (const id of HOSTILE_IDS) {
      const res = await send('GET', `${url}${encodeURIComponent(id)}`);
      assert.equal(res.status, 422, `${url}${id} (${field}) -> ${res.status}`);
    }
  }
});

test('real workspace ids and empty ones still pass the id check', async () => {
  for (const id of ['docker/qa-ws1', 'docker-host/My_Box.1', 'local/this-machine', 'k8s/ws-1']) {
    const res = await sendJson('POST', '/api/pools/secrets/x1/assign', { workspaceIds: [id] });
    assert.notEqual(res.status, 422, `${id} -> ${res.status}`);
  }
  for (const body of [{ workspaceId: '' }, { workspaceId: null }, {}, { workspaceId: 5 }]) {
    const res = await sendJson('POST', '/api/chat/sessions', body);
    assert.notEqual(res.status, 401, JSON.stringify(body));
  }
});
