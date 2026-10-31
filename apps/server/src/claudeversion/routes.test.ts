// The HTTP routes and the Portal MCP tools of the version module (docs/prd/claude-version-pinning.md §10, FR15, FR16), and the authorization they declare:
// every route has a declared policy (and the other way round), platform-level routes need the platform area, a workspace's upgrade and rollback need
// manage on that workspace, and another user gets the answer a missing thing gets.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { Hono } from 'hono';
import { CLAUDE_VERSION_API, workspaceRef, type Actor } from '@portal/contracts';
import { clearResolvers, declaredPolicies, declaredToolPolicies, registerResolver } from '../authz/seam.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { CLAUDE_VERSION_POLICIES, CLAUDE_VERSION_TOOL_POLICIES, declareClaudeVersionPolicies } from './authz.js';
import { registerClaudeVersionTools } from './portalTools.js';
import { createClaudeVersionRoutes, createWorkspaceClaudeVersionRoutes } from './routes.js';
import { harness, outcome, ref, until, type Harness } from './testkit.js';

let h: Harness | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
  clearResolvers();
});

/** The portal's two route groups behind a stand-in for the sign-in guard: `actor` is who asks (the owner by default). */
function app(x: Harness, actor?: Actor) {
  const a = new Hono<{ Variables: { token: string; actor: Actor } }>();
  a.use(async (c, next) => {
    if (actor) c.set('actor', actor);
    else (c.set('token', 'signed-in'), (c as unknown as { set(k: string, v: unknown): void }).set('actor', { kind: 'user', userId: 'u_owner', loginSessionId: 'legacy', via: 'ui' }));
    await next();
  });
  a.onError((e, c) => (isAppError(e) ? c.json({ error: { code: e.code, message: e.message, details: e.details } }, e.status as 400) : c.json({ error: { code: 'INTERNAL', message: String(e) } }, 500)));
  a.route('/api/claude-version', createClaudeVersionRoutes(x.svc));
  a.route('/api/workspaces', createWorkspaceClaudeVersionRoutes(x.svc));
  return a;
}
const json = (body: unknown, method = 'POST') => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const data = async (res: Response) => ((await res.json()) as { data: any }).data;
const error = async (res: Response) => {
  const body = (await res.json()) as { error?: { code: string; message: string; details?: any } };
  if (!body.error) throw new Error(`expected an error, got ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body.error;
};

test('every route has a declared policy and every declared policy has a route; platform-level ones name the platform area', async () => {
  h = await harness();
  declareClaudeVersionPolicies();
  const routes = new Set(app(h).routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} ${r.path.replace(/\/$/, '')}`));
  assert.deepEqual([...routes].sort(), Object.keys(CLAUDE_VERSION_POLICIES).sort(), 'the declarations are the route table');
  for (const [key, policy] of Object.entries(CLAUDE_VERSION_POLICIES)) {
    assert.equal(declaredPolicies().get(key)?.kind, policy!.kind, `${key} is declared with the seam`);
    if (key.includes('/api/claude-version')) assert.ok(policy!.kind === 'platform' || key === 'GET /api/claude-version/workspaces', key);
    if (key.startsWith('POST') || key.startsWith('PUT')) assert.ok('audit' in policy! || false, `${key} names its audit action`);
  }
  // A mutation needs manage; a read needs view.
  for (const [key, policy] of Object.entries(CLAUDE_VERSION_POLICIES)) {
    const verb = policy!.kind === 'platform' ? policy!.verb : policy!.kind === 'objects' ? policy!.checks[0]!.verb : null;
    if (verb) assert.equal(verb, key.startsWith('GET') ? 'view' : 'manage', key);
  }
  assert.deepEqual(Object.keys(CLAUDE_VERSION_TOOL_POLICIES).sort(), ['claude_minimums', 'claude_versions']);
  for (const name of Object.keys(CLAUDE_VERSION_TOOL_POLICIES)) assert.equal(declaredToolPolicies().get(name)?.kind, 'platform');
});

test('the contract’s route table is what is mounted', async () => {
  h = await harness();
  const mounted = new Set(app(h).routes.map((r) => r.path.replace(/\/$/, '')));
  const id = ':target/:name';
  for (const path of [CLAUDE_VERSION_API.overview, CLAUDE_VERSION_API.features, CLAUDE_VERSION_API.checks, CLAUDE_VERSION_API.warnings, CLAUDE_VERSION_API.workspaces, CLAUDE_VERSION_API.candidate, CLAUDE_VERSION_API.canary, CLAUDE_VERSION_API.images, CLAUDE_VERSION_API.imagesPrune, CLAUDE_VERSION_API.defaultVersion]) assert.ok(mounted.has(path), path);
  assert.ok(mounted.has('/api/claude-version/canary/:id'));
  for (const f of [CLAUDE_VERSION_API.workspace, CLAUDE_VERSION_API.plan, CLAUDE_VERSION_API.apply, CLAUDE_VERSION_API.rollback, CLAUDE_VERSION_API.history]) assert.ok(mounted.has(f(id).replace('/api/workspaces/', '/api/workspaces/')), f(id));
});

test('reads: the overview, the registry, the checks, a workspace and its plan', async () => {
  h = await harness();
  const a = app(h);
  const overview = await data(await a.request('/api/claude-version'));
  assert.deepEqual([overview.defaultVersion, overview.installed, overview.schedule.everyDays, overview.report.candidateInfo.status], ['2.1.296', '2.1.296', 7, 'same']);
  assert.ok((await data(await a.request('/api/claude-version/features'))).some((f: { id: string }) => f.id === 'mcp-sets'));
  assert.ok((await data(await a.request('/api/claude-version/checks'))).some((c: { id: string }) => c.id === 'update-pin'));
  assert.deepEqual(Object.keys(await data(await a.request('/api/claude-version/workspaces'))), ['docker/api']);
  const one = await data(await a.request('/api/workspaces/docker/api/claude-version'));
  assert.deepEqual([one.info.pinned, one.info.running, one.history], ['2.1.296', '2.1.296', []]);
  const plan = await data(await a.request('/api/workspaces/docker/api/claude-version/plan?version=2.1.300'));
  assert.deepEqual([plan.to, plan.appliable], ['2.1.300', false]);
  assert.equal((await error(await a.request('/api/workspaces/docker/api/claude-version/plan?version=latest'))).code, 'VALIDATION_FAILED');
  assert.equal((await a.request('/api/workspaces/docker/ghost/claude-version')).status, 404);
  assert.deepEqual(await data(await a.request('/api/workspaces/docker/api/claude-version/history')), []);
  assert.deepEqual(await data(await a.request('/api/claude-version/canary')), []);
  assert.equal((await a.request('/api/claude-version/canary/0')).status, 404);
  assert.equal((await a.request('/api/claude-version/canary/abc')).status, 404);
  assert.equal((await data(await a.request('/api/claude-version/candidate'))).version, '2.1.296');
  assert.deepEqual((await data(await a.request('/api/claude-version/images'))).map((i: { ref: string }) => i.ref), [ref('2.1.296')]);
  assert.deepEqual(await data(await a.request('/api/claude-version/warnings')), []);
});

test('mutations validate their bodies, and say 202 for what runs in the background', async () => {
  h = await harness();
  const a = app(h);
  for (const body of [{}, { subject: 'weird' }, { subject: 'target' }, { subject: 'target', version: '^2.1' }]) {
    const res = await a.request('/api/claude-version/canary', json(body));
    assert.equal((await error(res)).code, 'VALIDATION_FAILED', JSON.stringify(body));
  }
  assert.equal((await error(await a.request('/api/claude-version/canary', { method: 'POST', body: 'not json' }))).code, 'BAD_REQUEST');
  let release!: () => void;
  h.control.canary = (t) => new Promise((resolve) => (release = () => resolve(outcome(t.version))));
  const started = await a.request('/api/claude-version/canary', json({ subject: 'installed' }));
  assert.equal(started.status, 202);
  const run = await data(started);
  assert.deepEqual([run.subject, run.trigger, run.actor, run.status], ['installed', 'manual', 'user:u_owner', 'running']);
  assert.equal((await error(await a.request('/api/claude-version/canary', json({ subject: 'installed' })))).code, 'CONFLICT', 'one at a time');
  await until(() => h!.runs.length === 1, 'the runner to start');
  release();
  await until(() => !h!.svc.canaryRunning, 'the run');
  assert.equal((await data(await a.request(`/api/claude-version/canary/${run.id}`))).status, 'done');
  assert.equal((await error(await a.request('/api/claude-version/images', json({ version: 'latest' })))).code, 'VALIDATION_FAILED');
  const build = await a.request('/api/claude-version/images', json({ version: '2.1.300' }));
  assert.equal(build.status, 202);
  assert.equal((await data(build)).ref, ref('2.1.300'));
  await until(() => h!.svc.building().length === 0, 'the build');
  const prune = await data(await a.request('/api/claude-version/images/prune', json({ dryRun: true, refs: [ref('2.1.300'), 12, 'x'.repeat(300)] })));
  assert.deepEqual([prune.dryRun, prune.removed], [true, [ref('2.1.300')]]);
  assert.equal((await error(await a.request('/api/claude-version/default', json({ version: 'nope' }, 'PUT')))).code, 'VALIDATION_FAILED');
  assert.deepEqual(await data(await a.request('/api/claude-version/default', json({ version: '2.1.300' }, 'PUT'))), { defaultVersion: '2.1.300' });
  assert.equal((await error(await a.request('/api/claude-version/images', json({ version: '2.1.300', target: 'x'.repeat(200) })))).code, 'VALIDATION_FAILED');
});

test('apply and rollback over HTTP: the confirmation, the accepted items and the 202', async () => {
  h = await harness();
  const a = app(h);
  await a.request('/api/claude-version/images', json({ version: '2.1.300' }));
  await until(() => h!.svc.building().length === 0, 'the build');
  h.control.canary = () => outcome('2.1.300', ['get-usage']);
  const run = await data(await a.request('/api/claude-version/canary', json({ subject: 'target', version: '2.1.300' })));
  await until(() => !h!.svc.canaryRunning, 'the canary');
  const apply = (body: unknown) => a.request('/api/workspaces/docker/api/claude-version/apply', json(body));
  assert.equal((await error(await apply({ version: '2.1.300', canaryRunId: run.id, confirm: true }))).code, 'CONFLICT');
  assert.equal((await error(await apply({ version: '2.1.300', canaryRunId: run.id, acceptFailed: ['get-usage'] }))).code, 'CONFIRMATION_REQUIRED');
  assert.equal((await error(await apply({ version: '2.1.300', canaryRunId: run.id, acceptFailed: ['get-usage'], confirm: 'yes' }))).code, 'CONFIRMATION_REQUIRED', 'only the boolean true confirms');
  assert.deepEqual(h.recreated, []);
  const res = await apply({ version: '2.1.300', canaryRunId: run.id, acceptFailed: ['get-usage', 7, 'x'.repeat(100)], confirm: true });
  assert.equal(res.status, 202);
  const op = await data(res);
  assert.deepEqual([op.kind, op.to], ['upgrade', '2.1.300']);
  await until(() => h!.svc.history('docker/api').length === 1, 'the upgrade');
  const roll = await a.request('/api/workspaces/docker/api/claude-version/rollback', json({}));
  assert.equal((await error(roll)).code, 'CONFIRMATION_REQUIRED');
  const done = await a.request('/api/workspaces/docker/api/claude-version/rollback', json({ confirm: true }));
  assert.equal(done.status, 202);
  await until(() => h!.svc.history('docker/api').length === 2, 'the rollback');
  assert.deepEqual((await data(await a.request('/api/workspaces/docker/api/claude-version/history'))).map((x: { kind: string }) => x.kind), ['rollback', 'upgrade']);
});

test('multi-user: a user who is not the owner is told a workspace that is not theirs does not exist, and cannot use a platform route', async () => {
  h = await harness({ workspaces: [{ name: 'mine' }, { name: 'theirs' }] });
  registerResolver({ type: 'workspace', resolve: (id) => ({ ref: workspaceRef(id), owner: { kind: 'user', id: id === 'docker/theirs' ? 'u_alice' : 'u_bob' } }) });
  const bob: Actor = { kind: 'user', userId: 'u_bob', loginSessionId: 'x', via: 'ui' } as Actor;
  const a = app(h, bob);
  // Another user's workspace: every route answers as a missing one (no existence leak), for a read and for a change.
  for (const [path, init] of [
    ['/api/workspaces/docker/theirs/claude-version', undefined],
    ['/api/workspaces/docker/theirs/claude-version/history', undefined],
    ['/api/workspaces/docker/theirs/claude-version/plan?version=2.1.300', undefined],
    ['/api/workspaces/docker/theirs/claude-version/apply', json({ version: '2.1.300', confirm: true })],
    ['/api/workspaces/docker/theirs/claude-version/rollback', json({ confirm: true })],
  ] as const) {
    const res = await a.request(path, init);
    assert.equal(res.status, 404, path);
    assert.equal((await error(res)).code, 'NOT_FOUND', path);
  }
  assert.deepEqual(h.recreated, []);
  // Their own is fine, and the list carries only theirs.
  assert.equal((await a.request('/api/workspaces/docker/mine/claude-version')).status, 200);
  assert.deepEqual(Object.keys(await data(await a.request('/api/claude-version/workspaces'))), ['docker/mine']);
  // The platform area belongs to the platform's admin: a plain user cannot start a canary, build, prune or change the default.
  for (const [path, init] of [
    ['/api/claude-version', undefined],
    ['/api/claude-version/canary', json({ subject: 'installed' })],
    ['/api/claude-version/images', json({ version: '2.1.300' })],
    ['/api/claude-version/images/prune', json({})],
    ['/api/claude-version/default', json({ version: '2.1.296' }, 'PUT')],
    ['/api/claude-version/candidate', json({})],
  ] as const) {
    const res = await a.request(path, init);
    assert.ok([403, 404].includes(res.status), `${path} answered ${res.status}`);
  }
  assert.equal(h.runs.length + h.built.length, 0, 'nothing ran');
  // Not signed in at all: nothing.
  const anon = new Hono();
  anon.onError((e, c) => c.json({ error: { code: isAppError(e) ? e.code : 'INTERNAL' } }, isAppError(e) ? (e.status as 401) : 500));
  anon.route('/api/claude-version', createClaudeVersionRoutes(h.svc));
  assert.equal((await anon.request('/api/claude-version')).status, 401);
});

test('the Portal MCP tools: reads of the platform area; versions per workspace, the registry, and nothing that changes anything', async () => {
  h = await harness({ workspaces: [{ name: 'api' }, { name: 'old', running: '2.1.280', doctor: 'Auto-updates: enabled' }] });
  const registry = new ToolRegistry();
  registerClaudeVersionTools(h.svc, registry);
  assert.deepEqual(registry.list().map((t) => [t.name, t.scope, t.hints?.readOnly]), [['claude_versions', 'read', true], ['claude_minimums', 'read', true]]);
  const principal = { kind: 'user', userId: 'u_owner', tokenId: 't1', label: 'x', scope: 'read', workspaceId: null, sessionId: null, expiresAt: '', client: null, vaults: null } as never;
  const ctx = { principal, assertWorkspace: () => undefined } as never;
  const versions = (await registry.get('claude_versions')!.handler(ctx, {} as never)) as any;
  assert.match(versions.summary, /2 workspace\(s\); default pin 2\.1\.296; candidate 2\.1\.296/);
  const old = versions.workspaces.find((w: { workspace_id: string }) => w.workspace_id === 'docker/old');
  assert.deepEqual([old.pinned, old.running, old.auto_update, old.flags, old.below_minimum.some((b: { feature: string }) => b.feature === 'mcp-sets')], ['2.1.296', '2.1.280', 'on', ['differs', 'below-minimum', 'auto-update-on', 'untested'], true]);
  assert.equal((await registry.get('claude_versions')!.handler(ctx, { workspace_id: 'docker/api' } as never) as any).workspaces.length, 1);
  await assert.rejects(async () => registry.get('claude_versions')!.handler(ctx, { workspace_id: 'docker/zzz' } as never), (e: unknown) => isAppError(e) && e.code === 'NOT_FOUND');
  const minimums = (await registry.get('claude_minimums')!.handler(ctx, { version: '2.1.280' } as never)) as any;
  assert.ok(minimums.features.some((f: { id: string; needs: string; basis: string }) => f.id === 'mcp-sets' && f.needs === '2.1.296' && f.basis === 'observed'));
  assert.ok(minimums.below.some((b: { feature: string }) => b.feature === 'mcp-sets'));
  await assert.rejects(async () => registry.get('claude_minimums')!.handler(ctx, { version: 'latest' } as never), (e: unknown) => isAppError(e) && e.code === 'VALIDATION_FAILED');
  // No secret, no workspace text: ids, versions and fixed words.
  assert.ok(!/token|secret|password/i.test(JSON.stringify(versions).replace(/"claude_versions"/g, '')));
});
