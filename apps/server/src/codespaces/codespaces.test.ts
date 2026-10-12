// Codespaces POC (docs/prd/codespaces-poc.md §14): connections, the device flow, the lifecycle and the no-secret-anywhere rule, all against the
// fake GitHub (standin.ts). No real GitHub, no real token.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, describe, it } from 'node:test';
import { isAppError } from '@isnanme/core';
import { GITHUB_CODESPACE_STATES, type Actor, type CodespaceView, type DeviceFlowView, type GitHubConnection } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { clearResolvers, registerResolver } from '../authz/seam.js';
import { PlatformAudit } from '../platform/audit.js';
import { secretsHarness } from '../secrets/testkit.js';
import { GitHubClient } from './github.js';
import { createBody, phaseOf, PHASE_OF } from './provider.js';
import { createCodespacesRoutes } from './routes.js';
import { Codespaces } from './service.js';
import { startGitHubStandIn, type FakeToken, type GitHubStandIn } from './standin.js';
import { TOKEN_ENTRY, secretsVault } from './vault.js';

const OWNER: Actor = { kind: 'user', userId: 'u_owner', loginSessionId: 's1', via: 'ui' };
const ALL: FakeToken['permissions'] = ['codespaces:write', 'lifecycle:write', 'metadata:read'];
const CANARY = 'github_pat_' + '11CANARY0000000000000_canaryCANARYcanaryCANARYcanaryCANARYcanaryCANARY99';

async function harness(opts: { clientId?: string | null; standin?: Parameters<typeof startGitHubStandIn>[0] } = {}) {
  const h = await secretsHarness();
  const gh = await startGitHubStandIn({ interval: 0, ...opts.standin });
  const client = new GitHubClient({ endpoints: { web: gh.url, api: gh.url }, allowOtherHosts: true });
  const audit = new PlatformAudit(h.store);
  const cs = new Codespaces({
    gh: client,
    host: new URL(gh.url).host,
    vault: secretsVault(h.service, h.kind.values),
    dataFile: `${h.dataDir}/codespaces.json`,
    clientId: opts.clientId === undefined ? 'Iv1.standin' : opts.clientId,
    scopes: ['codespace'],
    audit: (e) => audit.record(e),
    timeScale: 0.001,
  });
  const app = new Hono<{ Variables: { actor: Actor } }>();
  let actor: Actor = OWNER;
  app.use(async (c, next) => {
    c.set('actor', actor);
    await next();
  });
  app.route('/api/codespaces', createCodespacesRoutes(cs));
  app.onError((e, c) => (isAppError(e) ? c.json(e.toJSON(), e.status as ContentfulStatusCode) : c.json({ error: String(e) }, 500)));
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/codespaces${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };
  const done = async () => {
    cs.stop();
    await gh.close();
    h.done();
  };
  return { h, gh, cs, call, as: (a: Actor) => (actor = a), done, auditRows: () => h.store.db!.prepare('SELECT * FROM platform_audit').all() as Record<string, unknown>[] };
}

const until = async (check: () => boolean | Promise<boolean>, ms = 2000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('codespaces: state mapping and validation', () => {
  it('maps every GitHub state, and an unknown string to unknown (never running)', () => {
    for (const s of GITHUB_CODESPACE_STATES) assert.ok(PHASE_OF[s], s);
    assert.equal(phaseOf('Available').phase, 'running');
    assert.equal(phaseOf('Shutdown').phase, 'stopped');
    assert.equal(phaseOf('Archived').phase, 'stopped');
    assert.equal(phaseOf('Provisioning').phase, 'creating');
    assert.equal(phaseOf('Failed').phase, 'error');
    assert.deepEqual(phaseOf('SomethingNew'), { state: 'Unknown', phase: 'unknown' });
  });

  it('keeps create requests inside GitHub’s documented limits', () => {
    assert.deepEqual(createBody({ repo: 'o/r', idleTimeoutMinutes: 30, retentionPeriodMinutes: 0 }, 7), { repository_id: 7, idle_timeout_minutes: 30, retention_period_minutes: 0 });
    for (const bad of [{ idleTimeoutMinutes: 4 }, { idleTimeoutMinutes: 241 }, { retentionPeriodMinutes: 43_201 }, { machine: 'a b' }, { devcontainerPath: '../x.json' }, { ref: 'a..b' }, { displayName: 'x'.repeat(49) }])
      assert.throws(() => createBody({ repo: 'o/r', ...bad } as never, 7), /Use|Pick|not a branch/);
  });
});

describe('codespaces: connections (manual token)', () => {
  let t: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => {
    t?.done && (await t.done().catch(() => {}));
    t = await harness();
  });
  after(async () => t && (await t.done()));

  it('connects a fine-grained token: real check, sealed secret, nothing of the token in the file', async () => {
    t.gh.addToken(CANARY, { login: 'octocat', kind: 'fine-grained', permissions: ALL });
    const r = await t.call('POST', '/connections', { method: 'token', token: CANARY });
    assert.equal(r.status, 201, r.text);
    const c = r.json.data as GitHubConnection;
    assert.equal(c.check.state, 'connected');
    assert.equal(c.login, 'octocat');
    assert.equal(c.tokenType, 'github_pat');
    assert.equal(c.scopes, null); // fine-grained tokens carry no scope header
    assert.equal(c.secret.entryName, TOKEN_ENTRY);
    assert.equal(c.secret.madeHere, true);
    assert.match(c.secret.hint ?? '', /^github_pat_…/);
    assert.equal(secretsVault(t.h.service, t.h.kind.values).open(c.secret.poolId, TOKEN_ENTRY), CANARY);
    assert.ok(!readFileSync(`${t.h.dataDir}/codespaces.json`, 'utf8').includes(CANARY));
    // connecting the same account again makes a new version of the same secret, not a second connection
    const again = await t.call('POST', '/connections', { method: 'token', token: CANARY });
    assert.equal(again.json.data.id, c.id);
    assert.equal((await t.call('GET', '')).json.data.connections.length, 1);
  });

  it('refuses a token GitHub refuses, and stores nothing', async () => {
    const r = await t.call('POST', '/connections', { method: 'token', token: 'github_pat_' + '11BOGUS000000000000000000000' });
    assert.equal(r.status, 422);
    assert.equal(t.h.service.list('secrets').length, 0);
  });

  it('says "limited" for a token without the Codespaces permission, and reads classic scopes', async () => {
    t.gh.addToken('github_pat_' + '11NOPERM00000000000000000000', { login: 'octocat', kind: 'fine-grained', permissions: [] });
    const lim = (await t.call('POST', '/connections', { method: 'token', token: 'github_pat_' + '11NOPERM00000000000000000000' })).json.data as GitHubConnection;
    assert.equal(lim.check.state, 'limited');
    assert.match(lim.check.detail ?? '', /Codespaces permission/);
    t.gh.addToken('ghp_' + 'classic000000000000000000000000000', { login: 'hubot', kind: 'classic', scopes: ['codespace', 'read:user'] });
    const cl = (await t.call('POST', '/connections', { method: 'token', token: 'ghp_' + 'classic000000000000000000000000000' })).json.data as GitHubConnection;
    assert.equal(cl.check.state, 'connected');
    assert.deepEqual(cl.scopes, ['codespace', 'read:user']);
    assert.equal(cl.tokenType, 'ghp');
  });

  it('re-checks for real: a token revoked at GitHub turns invalid; a deleted secret too', async () => {
    t.gh.addToken(CANARY, { login: 'octocat', kind: 'fine-grained', permissions: ALL });
    const c = (await t.call('POST', '/connections', { method: 'token', token: CANARY })).json.data as GitHubConnection;
    t.gh.addToken(CANARY, undefined as never); // GitHub forgets it
    const r = await t.call('POST', `/connections/${c.id}/check`);
    assert.equal(r.json.data.check.state, 'invalid');
    t.h.service.delete(c.secret.poolId);
    assert.equal((await t.call('GET', '')).json.data.connections[0].check.state, 'invalid');
  });

  it('disconnects, and deletes the set it made only when asked', async () => {
    t.gh.addToken(CANARY, { login: 'octocat', kind: 'fine-grained', permissions: ALL });
    const c = (await t.call('POST', '/connections', { method: 'token', token: CANARY })).json.data as GitHubConnection;
    const r = await t.call('DELETE', `/connections/${c.id}`, { deleteSecret: true });
    assert.deepEqual(r.json.data, { secretDeleted: true });
    assert.equal(t.h.service.list('secrets').length, 0);
    assert.equal((await t.call('GET', '')).json.data.connections.length, 0);
  });

  it('connects from an existing secret the person may operate', async () => {
    t.gh.addToken(CANARY, { login: 'octocat', kind: 'fine-grained', permissions: ALL });
    const p = t.h.service.create('secrets', { name: 'Mine', content: { entries: [{ kind: 'secret', name: 'GH', newValue: CANARY }] } });
    const c = (await t.call('POST', '/connections', { method: 'secret', poolId: p.id, entryName: 'GH' })).json.data as GitHubConnection;
    assert.equal(c.check.state, 'connected');
    assert.equal(c.secret.madeHere, false);
    assert.equal((await t.call('DELETE', `/connections/${c.id}`, { deleteSecret: true })).status, 409);
  });
});

describe('codespaces: device flow (client ID only)', () => {
  let t: Awaited<ReturnType<typeof harness>>;
  afterEachDone();
  function afterEachDone() {
    beforeEach(async () => t && (await t.done().catch(() => {})));
  }
  after(async () => t && (await t.done()));

  it('is unavailable without a client ID, and says so', async () => {
    t = await harness({ clientId: null });
    const s = (await t.call('GET', '')).json.data;
    assert.equal(s.device.available, false);
    assert.match(s.device.reason, /PORTAL_GITHUB_CLIENT_ID/);
    assert.equal((await t.call('POST', '/device')).status, 409);
  });

  it('shows a code and link, polls server-side, stores the token sealed, never sends a client secret', async () => {
    t = await harness();
    const f = (await t.call('POST', '/device')).json.data as DeviceFlowView;
    assert.equal(f.state, 'pending');
    assert.match(f.userCode ?? '', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(f.verificationUri, `${t.gh.url}/login/device`);
    assert.deepEqual(f.requestedScopes, ['codespace']);
    assert.ok(!JSON.stringify(f).includes('device_code') && !('deviceCode' in f));
    // a second start returns the pending one
    assert.equal((await t.call('POST', '/device')).json.data.id, f.id);
    t.gh.approve(f.userCode!, 'octocat');
    await until(async () => (await t.call('GET', `/device/${f.id}`)).json.data.state !== 'pending');
    const end = (await t.call('GET', `/device/${f.id}`)).json.data as DeviceFlowView;
    assert.equal(end.state, 'connected', end.detail ?? '');
    assert.equal(end.userCode, null);
    const conn = (await t.call('GET', '')).json.data.connections[0] as GitHubConnection;
    assert.equal(conn.id, end.connectionId);
    assert.equal(conn.method, 'device');
    assert.equal(conn.tokenType, 'gho');
    assert.deepEqual(conn.scopes, ['codespace']);
    const issued = t.gh.issued()[0]!;
    assert.equal(secretsVault(t.h.service, t.h.kind.values).open(conn.secret.poolId, TOKEN_ENTRY), issued);
    assert.ok(t.gh.calls.every((c) => !c.keys.includes('client_secret')));
    assert.ok(t.gh.calls.some((c) => c.path === '/login/oauth/access_token' && c.keys.includes('device_code')));
    for (const row of t.auditRows()) assert.ok(!JSON.stringify(row).includes(issued));
  });

  it('handles denied, cancel, expiry, slow_down and a disabled device flow', async () => {
    t = await harness();
    const f = (await t.call('POST', '/device')).json.data as DeviceFlowView;
    t.gh.deny(f.userCode!);
    await until(async () => (await t.call('GET', `/device/${f.id}`)).json.data.state === 'denied');
    const g = (await t.call('POST', '/device')).json.data as DeviceFlowView;
    assert.equal((await t.call('DELETE', `/device/${g.id}`)).json.data.state, 'cancelled');
    await t.done();

    t = await harness({ standin: { expiresIn: 1, interval: 0 } });
    const e = (await t.call('POST', '/device')).json.data as DeviceFlowView;
    t.gh.advance(5_000);
    await until(async () => (await t.call('GET', `/device/${e.id}`)).json.data.state === 'expired');
    await t.done();

    t = await harness({ standin: { interval: 1 } });
    const s = (await t.call('POST', '/device')).json.data as DeviceFlowView;
    await until(async () => (await t.call('GET', `/device/${s.id}`)).json.data.interval > 1);
    await t.call('DELETE', `/device/${s.id}`);
    await t.done();

    t = await harness({ standin: { deviceDisabled: true } });
    const d = await t.call('POST', '/device');
    assert.equal(d.status, 409);
    assert.match(d.json.error?.message ?? d.text, /Device flow is off/);
  });

  it('a flow belongs to the person who started it', async () => {
    t = await harness();
    const f = (await t.call('POST', '/device')).json.data as DeviceFlowView;
    t.as({ kind: 'user', userId: 'u_b', loginSessionId: 's2', via: 'ui' });
    assert.equal((await t.call('GET', `/device/${f.id}`)).status, 404);
    assert.equal((await t.call('DELETE', `/device/${f.id}`)).status, 404);
  });
});

describe('codespaces: lifecycle against the fake GitHub', () => {
  let t: Awaited<ReturnType<typeof harness>>;
  let conn: GitHubConnection;
  before(async () => {
    t = await harness();
    t.gh.addToken(CANARY, { login: 'octocat', kind: 'fine-grained', permissions: ALL });
    conn = (await t.call('POST', '/connections', { method: 'token', token: CANARY })).json.data;
  });
  after(async () => t.done());

  it('lists repos, devcontainers and machines', async () => {
    const repos = (await t.call('GET', `/connections/${conn.id}/repos?q=app`)).json.data;
    assert.deepEqual(repos.map((r: { fullName: string }) => r.fullName), ['octo/app']);
    const o = (await t.call('GET', `/connections/${conn.id}/repos/octo/app/options`)).json.data;
    assert.equal(o.devcontainers.length, 2);
    assert.equal(o.machines[0].name, 'basicLinux32gb');
    assert.equal(o.defaults.location, 'WestEurope');
    assert.equal(o.limits.idleTimeoutMinutes.max, 240);
    assert.equal((await t.call('GET', `/connections/${conn.id}/billing`)).json.data.available, false);
  });

  it('creates, polls to running, stops, starts, detaches (stays at GitHub) and deletes (gone)', async () => {
    const r = await t.call('POST', `/connections/${conn.id}/codespaces`, { repo: 'octo/app', ref: 'main', machine: 'standardLinux32gb', devcontainerPath: '.devcontainer/claudepilot/devcontainer.json', idleTimeoutMinutes: 15, retentionPeriodMinutes: 1440 });
    assert.equal(r.status, 201, r.text);
    const cs = r.json.data as CodespaceView;
    assert.equal(cs.phase, 'creating');
    assert.equal(cs.attached, true);
    assert.equal(cs.idleTimeoutMinutes, 15);
    t.gh.advance(3_500);
    const ready = await t.cs.waitFor(OWNER, conn.id, cs.name, { sleep: async () => void t.gh.advance(2_000) });
    assert.equal(ready.phase, 'running');
    assert.equal((await t.call('POST', `/connections/${conn.id}/codespaces/${cs.name}/stop`)).json.data.phase, 'stopping');
    const stopped = await t.cs.waitFor(OWNER, conn.id, cs.name, { sleep: async () => void t.gh.advance(1_000) });
    assert.equal(stopped.phase, 'stopped');
    assert.ok(stopped.retentionExpiresAt);
    assert.equal((await t.call('POST', `/connections/${conn.id}/codespaces/${cs.name}/start`)).json.data.phase, 'starting');
    // detach: the portal forgets, GitHub keeps it
    assert.equal((await t.call('POST', `/connections/${conn.id}/codespaces/${cs.name}/detach`)).status, 200);
    const list = (await t.call('GET', `/connections/${conn.id}/codespaces`)).json.data as CodespaceView[];
    assert.equal(list.find((x) => x.name === cs.name)?.attached, false);
    assert.equal(t.gh.codespaces().length, 1);
    assert.equal((await t.call('POST', `/connections/${conn.id}/codespaces/${cs.name}/attach`)).json.data.attached, true);
    // delete needs the name typed
    assert.equal((await t.call('DELETE', `/connections/${conn.id}/codespaces/${cs.name}`, { confirm: 'nope' })).status, 422);
    assert.equal((await t.call('DELETE', `/connections/${conn.id}/codespaces/${cs.name}`, { confirm: cs.name })).status, 200);
    assert.equal(t.gh.codespaces().length, 0);
    assert.equal(t.cs.attached(OWNER).length, 0);
  });

  it('maps GitHub refusals: missing permission, spending limit, rate limit, bad input', async () => {
    // another GitHub account (the same account connected again would replace this connection's token: one connection per account)
    t.gh.addToken('github_pat_' + '11NOLIFECYCLE000000000000000', { login: 'monalisa', kind: 'fine-grained', permissions: ['codespaces:write', 'metadata:read'] });
    const c2 = (await t.call('POST', '/connections', { method: 'token', token: 'github_pat_' + '11NOLIFECYCLE000000000000000' })).json.data as GitHubConnection;
    const made = (await t.call('POST', `/connections/${c2.id}/codespaces`, { repo: 'octo/app' })).json.data as CodespaceView;
    const noStart = await t.call('POST', `/connections/${c2.id}/codespaces/${made.name}/stop`);
    assert.equal(noStart.status, 403);
    assert.match(noStart.text, /lacks a permission/);
    t.gh.set({ spendingLimit: true });
    const mine = (await t.call('POST', `/connections/${conn.id}/codespaces`, { repo: 'octo/app' })).json.data as CodespaceView;
    const pay = await t.call('POST', `/connections/${conn.id}/codespaces/${mine.name}/start`);
    assert.equal(pay.status, 403);
    assert.match(pay.text, /spending limit/);
    t.gh.set({ spendingLimit: false, rateLimitAfter: 0 });
    const rl = await t.call('GET', `/connections/${conn.id}/codespaces`);
    assert.equal(rl.status, 429);
    assert.ok(rl.json.error?.details?.retryAt ?? rl.text.includes('retryAt'));
    t.gh.set({ rateLimitAfter: null });
    assert.equal((await t.call('POST', `/connections/${conn.id}/codespaces`, { repo: 'not a repo' })).status, 422);
    assert.equal((await t.call('GET', `/connections/${conn.id}/codespaces/bad..name`)).status, 422);
  });
});

describe('codespaces: who may use a token (multi-user rule)', () => {
  let t: Awaited<ReturnType<typeof harness>>;
  after(async () => {
    clearResolvers();
    await t.done();
  });

  it('only the connector (and the seam) may use a connection; agents and tokens never', async () => {
    t = await harness();
    const A: Actor = { kind: 'user', userId: 'u_a', loginSessionId: 'sa', via: 'ui' };
    const B: Actor = { kind: 'user', userId: 'u_b', loginSessionId: 'sb', via: 'ui' };
    // Two fake users: secret sets are owned by whoever the resolver says (here: everything by u_a).
    registerResolver({ type: 'pool', resolve: (id) => ({ ref: { type: 'pool', id, poolType: 'secrets' }, owner: { kind: 'user', id: 'u_a' } }) });
    t.gh.addToken(CANARY, { login: 'octocat', kind: 'fine-grained', permissions: ALL });
    t.as(A);
    const c = (await t.call('POST', '/connections', { method: 'token', token: CANARY })).json.data as GitHubConnection;
    assert.equal(c.ownerId, 'u_a');
    assert.equal((await t.call('GET', `/connections/${c.id}/codespaces`)).status, 200);
    t.as(B);
    assert.equal((await t.call('GET', '')).json.data.connections.length, 0);
    assert.equal((await t.call('GET', `/connections/${c.id}/codespaces`)).status, 404);
    assert.equal((await t.call('POST', `/connections/${c.id}/codespaces`, { repo: 'octo/app' })).status, 404);
    t.as({ kind: 'agent', userId: 'u_a', tokenId: 't', sessionId: 's', workspaceId: 'docker/x' });
    assert.equal((await t.call('GET', `/connections/${c.id}/codespaces`)).status, 403);
    t.as({ kind: 'token', userId: 'u_a', tokenId: 't', scope: 'admin' });
    assert.equal((await t.call('POST', '/device')).status, 403);
  });
});

describe('codespaces: a canary token reaches no log, response, audit row or file', () => {
  it('runs every path with a planted canary and finds it nowhere', async () => {
    const seen: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
    for (const k of Object.keys(orig) as (keyof typeof orig)[]) console[k] = (...a: unknown[]) => void seen.push(a.map(String).join(' '));
    const t = await harness();
    try {
      t.gh.addToken(CANARY, { login: 'octocat', kind: 'fine-grained', permissions: ALL });
      const bodies: string[] = [];
      const go = async (m: string, p: string, b?: unknown) => {
        const r = await t.call(m, p, b);
        bodies.push(r.text);
        return r;
      };
      const c = (await go('POST', '/connections', { method: 'token', token: CANARY })).json.data as GitHubConnection;
      await go('GET', '');
      await go('POST', `/connections/${c.id}/check`);
      await go('GET', `/connections/${c.id}/repos`);
      await go('GET', `/connections/${c.id}/repos/octo/app/options`);
      const cs = (await go('POST', `/connections/${c.id}/codespaces`, { repo: 'octo/app' })).json.data as CodespaceView;
      await go('GET', `/connections/${c.id}/codespaces/${cs.name}`);
      await go('POST', `/connections/${c.id}/codespaces/${cs.name}/stop`);
      t.gh.set({ rateLimitAfter: 0 });
      await go('GET', `/connections/${c.id}/codespaces`);
      t.gh.set({ rateLimitAfter: null });
      t.gh.addToken(CANARY, undefined as never);
      await go('POST', `/connections/${c.id}/check`);
      await go('POST', '/connections', { method: 'token', token: CANARY }); // refused: the error must not echo it
      await go('DELETE', `/connections/${c.id}/codespaces/${cs.name}`, { confirm: cs.name });
      const files = readFileSync(`${t.h.dataDir}/codespaces.json`, 'utf8');
      const audit = JSON.stringify(t.auditRows());
      assert.ok(t.auditRows().length >= 3);
      for (const [where, text] of [['responses', bodies.join('\n')], ['console', seen.join('\n')], ['audit', audit], ['codespaces.json', files], ['stand-in log', JSON.stringify(t.gh.calls)]] as const)
        assert.ok(!text.includes(CANARY) && !text.includes(CANARY.slice(12, 40)), `canary found in ${where}`);
    } finally {
      Object.assign(console, orig);
      await t.done();
    }
  });
});
