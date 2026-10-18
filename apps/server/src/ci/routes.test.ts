// The CI routes through the authorization seam, with two fake users (the workspace is A's): B gets the same 404 as for something that does
// not exist, on every route that names A's run or remote; approving a deployment and switching an environment's protection are a person's
// acts (a Portal MCP token or an agent with every right still gets 403); every route is declared in ci/authz.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import { objectRef, type Actor } from '@portal/contracts';
import { Hono } from 'hono';
import { registerResolver } from '../authz/seam.js';
import { CI_POLICIES, registerCiAuthz } from './authz.js';
import { createCiRoutes } from './routes.js';
import type { CiServiceOptions } from './service.js';
import { harness, remote, WS } from './testkit.js';

const DEPLOY = 'on: manual\njobs:\n  build:\n    steps: [{ run: echo b }]\n  release:\n    needs: [build]\n    environment: production\n    steps: [{ run: echo r }]\n';

const user = (id: string): Actor => ({ kind: 'user', userId: id, loginSessionId: 'l1', via: 'ui' });
const ACTORS: Record<string, Actor> = {
  a: user('u_a'),
  b: user('u_b'),
  token: { kind: 'token', userId: 'u_a', tokenId: 't1', scope: 'admin' },
  agent: { kind: 'agent', userId: 'u_a', tokenId: 't2', sessionId: 's1', workspaceId: WS },
};

async function build(opts: CiServiceOptions = {}) {
  const h = await harness(opts);
  const routes = createCiRoutes(h.svc);
  // The workspace belongs to A (single-owner production answers the founding user).
  registerCiAuthz(h.svc, (ws) => (ws === WS ? 'u_a' : 'u_owner'));
  const app = new Hono<{ Variables: { actor: Actor } }>();
  app.use('*', async (c, next) => {
    const who = c.req.header('x-as');
    if (who) c.set('actor', ACTORS[who]!);
    await next();
  });
  app.route('/api/ci', routes);
  app.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', (e as Error).message);
    return c.json(err.toJSON(), err.status as 500);
  });
  const call = async (as: string | null, method: string, path: string, body?: unknown) => {
    const res = await app.request(`http://x${path}`, { method, headers: { ...(as ? { 'x-as': as } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = (await res.json().catch(() => null)) as { data?: unknown; error?: { code: string; message: string } } | null;
    return { status: res.status, data: json?.data as any, error: json?.error };
  };
  return { h, app, routes, call };
}

test('two users: B can not see or touch A’s runs, remotes or environments; ids of A answer like unknown ones', async () => {
  const { h, call } = await build();
  try {
    const repo = await remote(h, { '.pilot/deploy.yml': DEPLOY });
    const start = await call('a', 'POST', '/api/ci/runs', { repoId: repo.id, pipeline: 'deploy', ref: 'main' });
    assert.equal(start.status, 201, JSON.stringify(start.error));
    const runId = start.data.id as string;
    await h.until('the release to wait', () => h.svc.get(runId).deployments.some((d) => d.approval === 'waiting'));

    assert.equal((await call('a', 'GET', '/api/ci/runs')).data.items.length, 1);
    const listB = (await call('b', 'GET', '/api/ci/runs')).data;
    assert.deepEqual([listB.items.length, listB.total, listB.active], [0, 0, 0], 'B’s list counts nothing of A’s');
    assert.deepEqual((await call('b', 'GET', '/api/ci/repos')).data, []);

    const probes: [string, string, unknown?][] = [
      ['GET', `/api/ci/runs/${runId}`],
      ['GET', `/api/ci/runs/${runId}/log?job=build&step=0`],
      ['POST', `/api/ci/runs/${runId}/cancel`],
      ['POST', `/api/ci/runs/${runId}/rerun`],
      ['GET', `/api/ci/runs/${runId}/bump`],
      ['POST', `/api/ci/runs/${runId}/bump`, { sessionId: 's1', mode: 'ask' }],
      ['POST', `/api/ci/runs/${runId}/approve`, { job: 'release' }],
      ['POST', `/api/ci/runs/${runId}/reject`, { job: 'release' }],
      ['POST', '/api/ci/runs', { repoId: repo.id, pipeline: 'deploy', ref: 'main' }],
      ['PATCH', `/api/ci/repos/${repo.id}`, { protected: [] }],
      ['PATCH', `/api/ci/repos/${repo.id}`, { upstream: { url: 'https://upstream.test/x.git' } }],
      ['POST', `/api/ci/repos/${repo.id}/sync`],
      ['DELETE', `/api/ci/repos/${repo.id}`],
      ['POST', `/api/ci/repos/${repo.id}/connect`, { path: '/tmp/x' }],
      ['GET', `/api/ci/repos/${repo.id}/branches`],
      ['GET', `/api/ci/repos/${repo.id}/pipelines`],
      ['POST', `/api/ci/repos/${repo.id}/merge`, { source: 'a', target: 'main' }],
      ['GET', `/api/ci/repos/${repo.id}/environments`],
      ['PUT', `/api/ci/repos/${repo.id}/environments/production`, { protected: false }],
      ['PUT', `/api/ci/repos/${repo.id}/environments/production/auto-approve`, { mode: 'dry' }],
      ['PUT', `/api/ci/repos/${repo.id}/environments/production/auto-approve`, { mode: 'on' }],
    ];
    for (const [method, path, body] of probes) {
      const b = await call('b', method, path, body);
      const ghost = await call('b', method, path.replace(runId, 'rnosuchrun0001').replace(repo.id, 'pnosuchrepo0001'), body);
      assert.equal(b.status, 404, `${method} ${path}: ${JSON.stringify(b.error)}`);
      assert.deepEqual(b.error, ghost.error, `${method} ${path}: the same answer as a missing one`);
    }
    assert.equal((await call(null, 'GET', `/api/ci/runs/${runId}`)).status, 401, 'nobody signed in');

    // Nothing B tried changed anything.
    const still = h.svc.get(runId);
    assert.deepEqual([still.status, still.deployments[0]!.approval], ['running', 'waiting']);
    assert.equal(h.svc.environments(repo.id)[0]!.protected, true);

    // A token with every right, and the agent of that very workspace: not a person, so no approval and no protection change.
    for (const who of ['token', 'agent']) {
      for (const d of ['approve', 'reject']) assert.equal((await call(who, 'POST', `/api/ci/runs/${runId}/${d}`, { job: 'release' })).status, 403, `${who} ${d}`);
      assert.equal((await call(who, 'PUT', `/api/ci/repos/${repo.id}/environments/production`, { protected: false })).status, 403, `${who} protection`);
      assert.equal((await call(who, 'PUT', `/api/ci/repos/${repo.id}/environments/production/auto-approve`, { mode: 'dry' })).status, 403, `${who} auto-approve`);
      assert.equal((await call(who, 'PUT', `/api/ci/repos/${repo.id}/environments/production/auto-approve`, { mode: 'on' })).status, 403, `${who} auto-approve on`);
      // T-486: the upstream a remote follows (and the secret name that reads it) is a person's setting.
      assert.equal((await call(who, 'PATCH', `/api/ci/repos/${repo.id}`, { upstream: { url: 'https://upstream.test/x.git' } })).status, 403, `${who} upstream`);
      assert.equal((await call(who, 'PATCH', `/api/ci/repos/${repo.id}`, { upstream: null })).status, 403, `${who} upstream cleared`);
    }
    assert.equal((await h.svc.repo(repo.id)).upstream, null, 'no upstream was set by anyone but a person');
    assert.equal(h.svc.environments(repo.id)[0]!.autoApprove, 'off', 'nobody but a person with manage set the rule');
    assert.equal(h.svc.get(runId).deployments[0]!.approval, 'waiting');

    // A, a person who manages it: sees the environment, approves.
    const envs = await call('a', 'GET', `/api/ci/repos/${repo.id}/environments`);
    assert.deepEqual(envs.data.map((e: { name: string; protected: boolean }) => [e.name, e.protected]), [['production', true]]);
    assert.equal((await call('a', 'POST', `/api/ci/runs/${runId}/approve`, {})).status, 422, 'which job');
    const ok = await call('a', 'POST', `/api/ci/runs/${runId}/approve`, { job: 'release' });
    assert.equal(ok.status, 200, JSON.stringify(ok.error));
    assert.equal(ok.data.deployments[0].decidedBy, 'user:u_a');
    assert.ok(!JSON.stringify(ok.data).includes('gate_key'));
    await h.until('the run to pass', () => h.svc.get(runId).status === 'passed');
    const prot = await call('a', 'PUT', `/api/ci/repos/${repo.id}/environments/production`, { protected: false });
    assert.deepEqual([prot.status, prot.data.protected, prot.data.updatedBy], [200, false, 'user:u_a']);
    // The auto-approve rule (T-110): A sets dry; `on` only while the approval (protection) is on.
    assert.equal((await call('a', 'PUT', `/api/ci/repos/${repo.id}/environments/production/auto-approve`, { mode: 'on' })).status, 422, 'on needs protection');
    const dry = await call('a', 'PUT', `/api/ci/repos/${repo.id}/environments/production/auto-approve`, { mode: 'dry' });
    assert.deepEqual([dry.status, dry.data.autoApprove, dry.data.updatedBy], [200, 'dry', 'user:u_a']);
    assert.equal((await call('a', 'PUT', `/api/ci/repos/${repo.id}/environments/production`, { protected: true })).status, 200);
    const on = await call('a', 'PUT', `/api/ci/repos/${repo.id}/environments/production/auto-approve`, { mode: 'on', window: '06:00-18:00' });
    assert.deepEqual([on.status, on.data.autoApprove, on.data.autoApproveWindow, on.data.updatedBy], [200, 'on', '06:00-18:00', 'user:u_a']);
  } finally {
    h.done();
  }
});

// T-591: release reports. The setting names a vault the portal later writes into as `system`, so it is checked at the route, as the person.
test('release report routes: person only, 404 on a vault the person may not write, input checks, audit, and the 409 of the backfill', async () => {
  const audits: { kind: string; actor: string; detail?: Record<string, unknown> }[] = [];
  const { h, call } = await build({ audit: (e) => void audits.push(e) });
  try {
    // Two vaults: `vmine` is A's, `vtheirs` belongs to someone else (A may not even see it). `vgone` does not exist.
    registerResolver({
      type: 'vault',
      resolve: (id) => (id === 'vmine' ? { ref: objectRef('vault', id), owner: { kind: 'user', id: 'u_a' } } : id === 'vtheirs' ? { ref: objectRef('vault', id), owner: { kind: 'user', id: 'u_owner' } } : null),
    });
    const sink = { exists: (v: string) => v === 'vmine' || v === 'vtheirs', read: () => null, put: () => ({ created: true, unchanged: false }) };
    h.svc.releaseNotes = sink;
    const repo = await remote(h, { '.pilot/deploy.yml': DEPLOY });
    const url = `/api/ci/repos/${repo.id}/release-report`;
    const good = { setting: { pipeline: 'deploy', vaultId: 'vmine', folder: 'Releases' } };

    // A token with every right and the agent of that workspace are not a person: 403, nothing stored.
    for (const who of ['token', 'agent']) assert.equal((await call(who, 'PUT', url, good)).status, 403, `${who} PUT`);
    assert.equal((await call('a', 'GET', url)).data, null, 'nothing was set by a token or an agent');
    // B does not see A's remote at all: 404.
    assert.equal((await call('b', 'PUT', url, good)).status, 404);

    // A vault A may not write, and one that does not exist: the same 404, and nothing is stored.
    const denied = await call('a', 'PUT', url, { setting: { ...good.setting, vaultId: 'vtheirs' } });
    const ghost = await call('a', 'PUT', url, { setting: { ...good.setting, vaultId: 'vgone' } });
    assert.equal(denied.status, 404, JSON.stringify(denied.error));
    assert.deepEqual(denied.error, ghost.error, 'the same answer as a vault that does not exist');
    assert.equal((await call('a', 'GET', url)).data, null);
    assert.equal(audits.length, 0, 'a refused setting leaves no audit row');
    h.svc.releaseNotes = undefined;
    assert.equal((await call('a', 'PUT', url, good)).status, 404, 'no vault connected: fails closed');
    h.svc.releaseNotes = sink;

    // Input checks.
    for (const [what, setting] of [
      ['folder with ..', { ...good.setting, folder: 'Releases/../x' }],
      ['empty folder', { ...good.setting, folder: '' }],
      ['bad vault id', { ...good.setting, vaultId: 'a b/c' }],
      ['bad pipeline', { ...good.setting, pipeline: '../deploy' }],
    ] as const) assert.equal((await call('a', 'PUT', url, { setting })).status, 422, what);
    assert.equal((await call('a', 'PUT', url, {})).status, 422, 'no setting key');
    assert.equal((await call('a', 'PUT', url, { setting: 'x' })).status, 422, 'not an object');
    assert.equal((await call('a', 'GET', url)).data, null, 'nothing stored by a bad request');

    // A may write `vmine`: stored (trimmed), audited as the person, readable back; null turns it off.
    const ok = await call('a', 'PUT', url, { setting: { pipeline: ' deploy ', vaultId: 'vmine', folder: '/Releases/' } });
    assert.deepEqual([ok.status, ok.data], [200, { pipeline: 'deploy', vaultId: 'vmine', folder: 'Releases' }]);
    assert.deepEqual((await call('a', 'GET', url)).data, ok.data);
    assert.deepEqual(audits.map((e) => [e.kind, e.actor, e.detail?.vault]), [['ci.release_report_setting', 'user:u_a', 'vmine']]);

    // T-1079 S3, the branch backfill: a person with manage only, 404 for B, the count checked, 409 on a setting of kind pipeline.
    const back = `${url}/backfill`;
    for (const who of ['token', 'agent']) assert.equal((await call(who, 'POST', back, { count: 1 })).status, 403, `${who} backfill`);
    assert.equal((await call('b', 'POST', back, { count: 1 })).status, 404);
    for (const count of [0, 21, 'x']) assert.equal((await call('a', 'POST', back, { count })).status, 422, `count ${count}`);
    const pipelineKind = await call('a', 'POST', back, {});
    assert.equal(pipelineKind.status, 409, JSON.stringify(pipelineKind.error));
    assert.match(pipelineKind.error!.message, /no release report of kind branch/);

    // The backfill: a person only, 404 for B, and 409 with the reason for a run that gets no report.
    const start = await call('a', 'POST', '/api/ci/runs', { repoId: repo.id, pipeline: 'deploy', ref: 'main' });
    assert.equal(start.status, 201, JSON.stringify(start.error));
    const post = `/api/ci/runs/${start.data.id}/release-report`;
    for (const who of ['token', 'agent']) assert.equal((await call(who, 'POST', post)).status, 403, `${who} POST`);
    assert.equal((await call('b', 'POST', post)).status, 404);
    const running = await call('a', 'POST', post);
    assert.equal(running.status, 409, JSON.stringify(running.error));
    assert.equal((await call('a', 'PUT', url, { setting: null })).status, 200);
    const off = await call('a', 'POST', post);
    assert.equal(off.status, 409);
    assert.match(off.error!.message, /no release report is set/);
  } finally {
    h.done();
  }
});

test('every CI route is declared, and every declaration names a real route', async () => {
  const { h, routes } = await build();
  try {
    const listed = new Set(routes.routes.filter((r) => r.method !== 'ALL').map((r) => `${r.method} /api/ci${r.path}`));
    const declared = new Set(Object.keys(CI_POLICIES));
    assert.deepEqual([...listed].filter((k) => !declared.has(k)), [], 'undeclared routes');
    assert.deepEqual([...declared].filter((k) => !listed.has(k)), [], 'declarations without a route');
  } finally {
    h.done();
  }
});
