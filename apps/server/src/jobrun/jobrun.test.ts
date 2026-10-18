// The job-run Mac door (T-1083 S1b-1): its only key is the calling session's own agent token, checked by the real AgentAccess.verify; the
// token's workspace must be on the client list; a cpat_ (even an admin's), a cpmt_ manager token, a cookie, a revoked or ended token and a
// workspace off the list all get the same 404 as a route that does not exist. Then the guards, the slot states, and runs owned by session.
// Every token-shaped value is built here at run time.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  JOBRUN_DOOR_LIMITS,
  JOBRUN_MAC_CLIENTS_SETTING,
  JOBRUN_MAC_WORKSPACE_SETTING,
  PORTAL_MANAGER_TOKEN_PREFIX,
  PORTAL_TOKEN_PREFIX,
  type JobRunMacRun,
} from '@portal/contracts';
import { AgentAccess } from '../portalmcp/agents.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { clientList, jobRunCallerOf, type JobRunCaller } from './authz.js';
import { createJobRunDoor, type MacRunner } from './routes.js';
import { macClientsFrom, macWorkspaceFrom } from './settings.js';

const NOT_FOUND = { ok: false, error: { code: 'NOT_FOUND', message: 'Not found' } };
const rand = (prefix: string) => prefix + randomBytes(32).toString('base64url');

class FakeRunner implements MacRunner {
  runs: (JobRunMacRun & { session: string })[] = [];
  liveCount() {
    return this.runs.filter((r) => r.state !== 'done').length;
  }
  list(session: string) {
    return this.runs.filter((r) => r.session === session).map(({ session: _s, ...r }) => r);
  }
  async start(caller: JobRunCaller, _mac: string, _body: unknown) {
    const run = { id: `r${this.runs.length + 1}`, where: 'mac' as const, chat: caller.session, state: 'running' as const, startedAt: '2030-01-01T00:00:00Z', session: caller.session };
    this.runs.push(run);
    const { session: _s, ...out } = run;
    return out;
  }
  async log(session: string, id: string) {
    return this.runs.some((r) => r.id === id && r.session === session) ? new Response('log of ' + id) : null;
  }
  async stop(session: string, id: string) {
    const r = this.runs.find((x) => x.id === id && x.session === session);
    if (!r) return false;
    r.state = 'done';
    return true;
  }
}

async function world(o: { clients?: string; mac?: string; status?: string | null; runner?: MacRunner } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-jobrun-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  const alive = new Set(['s1', 's2', 's3']);
  const agents = new AgentAccess(store, { alive: (id) => alive.has(id), url: () => 'http://portal.invalid/mcp', now: () => new Date('2030-01-01T00:00:00Z') });
  agents.setEnabled('docker/api', true);
  agents.setEnabled('docker/other', true);
  const settings = new Map<string, unknown>([
    [JOBRUN_MAC_CLIENTS_SETTING, o.clients ?? 'docker/api'],
    [JOBRUN_MAC_WORKSPACE_SETTING, o.mac ?? 'connect/mac'],
  ]);
  const reader = { get: (k: string) => settings.get(k) };
  let t = Date.parse('2030-01-01T00:00:00Z');
  const verified: string[] = [];
  const door = createJobRunDoor({
    verify: (s) => (verified.push(s.slice(0, 5)), agents.verify(s)),
    clients: macClientsFrom(reader),
    macWorkspace: macWorkspaceFrom(reader),
    workspaceStatus: async (id) => (id === 'connect/mac' ? (o.status === undefined ? 'running' : o.status) : null),
    runner: o.runner,
    clientAddress: () => '203.0.113.9',
    now: () => t,
  });
  const token = async (workspaceId: string, sessionId: string) => (await agents.mint({ workspaceId, sessionId }))!.env.PILOT_MCP_TOKEN!;
  const call = (path: string, init: RequestInit & { bearer?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.bearer !== undefined) headers.set('authorization', `Bearer ${init.bearer}`);
    return door.request(`http://portal.test${path}`, { ...init, headers });
  };
  return { agents, alive, settings, verified, token, call, tick: (ms: number) => (t += ms), done: () => (store.close(), rmSync(dataDir, { recursive: true, force: true })) };
}

test('the session’s own agent token opens the door; the slot answers', async () => {
  const w = await world({ runner: new FakeRunner() });
  try {
    const res = await w.call('/slot', { bearer: await w.token('docker/api', 's1') });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, data: { slot: true, free: 2 } });
  } finally {
    w.done();
  }
});

test('every other key is the same 404: cpat_ (even an admin’s), cpmt_, a cookie, none, a revoked, an ended or an unknown cpst_', async () => {
  const w = await world({ runner: new FakeRunner() });
  try {
    const good = await w.token('docker/api', 's1');
    const refusals: [string, Promise<Response>][] = [
      ['cpat_', w.call('/slot', { bearer: rand(PORTAL_TOKEN_PREFIX) })],
      ['cpmt_', w.call('/slot', { bearer: rand(PORTAL_MANAGER_TOKEN_PREFIX) })],
      ['cookie', w.call('/slot', { headers: { cookie: `portal_session=${randomBytes(24).toString('base64url')}` } })],
      ['token in the query', w.call(`/slot?token=${encodeURIComponent(good)}`)],
      ['no bearer', w.call('/slot')],
      ['unknown cpst_', w.call('/slot', { bearer: rand('cpst_') })],
      ['basic', w.call('/slot', { headers: { authorization: `Basic ${Buffer.from(`x:${good}`).toString('base64')}` } })],
    ];
    for (const [why, p] of refusals) {
      const res = await p;
      assert.equal(res.status, 404, why);
      assert.deepEqual(await res.json(), NOT_FOUND, why);
    }
    // Revoked (access turned off), then the session ended: verify refuses, the door says 404.
    w.agents.setEnabled('docker/api', false);
    assert.equal((await w.call('/slot', { bearer: good })).status, 404, 'agent access off');
    w.agents.setEnabled('docker/api', true);
    const live = await w.token('docker/api', 's2');
    assert.equal((await w.call('/slot', { bearer: live })).status, 200);
    w.alive.delete('s2');
    assert.equal((await w.call('/slot', { bearer: live })).status, 404, 'the session ended');
    // verify saw only what came as `Bearer`: the cpat_, the cpmt_, the unknown cpst_ and the three calls above; never the cookie, the query
    // or the Basic header.
    assert.deepEqual([...w.verified].sort(), ['cpat_', 'cpmt_', 'cpst_', 'cpst_', 'cpst_', 'cpst_']);
  } finally {
    w.done();
  }
});

test('a workspace off the list, and an empty list, get the same 404', async () => {
  const w = await world({ runner: new FakeRunner() });
  try {
    const other = await w.token('docker/other', 's3');
    const res = await w.call('/slot', { bearer: other });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), NOT_FOUND);
    const mine = await w.token('docker/api', 's1');
    w.settings.set(JOBRUN_MAC_CLIENTS_SETTING, '');
    assert.equal((await w.call('/slot', { bearer: mine })).status, 404, 'empty list: the door is closed');
    w.settings.set(JOBRUN_MAC_CLIENTS_SETTING, 'docker/other, docker/api');
    assert.equal((await w.call('/slot', { bearer: mine })).status, 200, 'read at each call');
  } finally {
    w.done();
  }
});

test('jobRunCallerOf maps only an ok agent principal on the list, to {kind:jobrun, session, workspaceId}', () => {
  const p = { kind: 'agent' as const, tokenId: 't', label: 'l', scope: 'agent' as const, workspaceId: 'docker/api', sessionId: 's1', expiresAt: '', client: null, vaults: [] };
  assert.deepEqual(jobRunCallerOf({ ok: true, principal: p }, ['docker/api']), { kind: 'jobrun', session: 's1', workspaceId: 'docker/api' });
  assert.equal(jobRunCallerOf({ ok: true, principal: p }, []), null);
  assert.equal(jobRunCallerOf({ ok: true, principal: { ...p, kind: 'user', scope: 'admin' as never } }, ['docker/api']), null);
  assert.equal(jobRunCallerOf({ ok: true, principal: { ...p, kind: 'manager' } }, ['docker/api']), null);
  assert.equal(jobRunCallerOf({ ok: true, principal: { ...p, sessionId: null } }, ['docker/api']), null);
  assert.equal(jobRunCallerOf({ ok: false, reason: 'revoked' }, ['docker/api']), null);
  assert.deepEqual(clientList(' docker/api,kubernetes/x  bad ../y '), ['docker/api', 'kubernetes/x']);
  assert.deepEqual(clientList(42), []);
});

test('the slot: no-mac, mac-not-running, no-runtime, free, mac-full', async () => {
  const slot = async (o: Parameters<typeof world>[0]) => {
    const w = await world(o);
    try {
      return ((await (await w.call('/slot', { bearer: await w.token('docker/api', 's1') })).json()) as { data: unknown }).data;
    } finally {
      w.done();
    }
  };
  assert.deepEqual(await slot({ mac: '', runner: new FakeRunner() }), { slot: false, reason: 'no-mac' });
  assert.deepEqual(await slot({ status: 'stopped', runner: new FakeRunner() }), { slot: false, reason: 'mac-not-running' });
  assert.deepEqual(await slot({ status: null, runner: new FakeRunner() }), { slot: false, reason: 'mac-not-running' });
  assert.deepEqual(await slot({}), { slot: false, reason: 'no-runtime' });
  const full = new FakeRunner();
  await full.start({ kind: 'jobrun', session: 'x', workspaceId: 'docker/api' }, 'connect/mac', {});
  assert.deepEqual(await slot({ runner: full }), { slot: true, free: 1 });
  await full.start({ kind: 'jobrun', session: 'y', workspaceId: 'docker/api' }, 'connect/mac', {});
  assert.deepEqual(await slot({ runner: full }), { slot: false, reason: 'mac-full' });
});

test('a run is seen, read and stopped only by the session that started it; no runtime is 503', async () => {
  const runner = new FakeRunner();
  const w = await world({ runner });
  try {
    const a = await w.token('docker/api', 's1');
    const b = await w.token('docker/api', 's2');
    const made = await w.call('/runs', { method: 'POST', bearer: a, body: JSON.stringify({ job: 'x' }) });
    assert.equal(made.status, 201);
    const run = ((await made.json()) as { data: JobRunMacRun }).data;
    assert.equal(run.where, 'mac');
    assert.equal(((await (await w.call('/runs', { bearer: a })).json()) as { data: { items: unknown[] } }).data.items.length, 1);
    assert.equal(((await (await w.call('/runs', { bearer: b })).json()) as { data: { items: unknown[] } }).data.items.length, 0);
    assert.equal((await w.call(`/runs/${run.id}/log`, { bearer: b })).status, 404, 'another session’s log');
    assert.equal(await (await w.call(`/runs/${run.id}/log`, { bearer: a })).text(), `log of ${run.id}`);
    assert.equal((await w.call(`/runs/${run.id}`, { method: 'DELETE', bearer: b })).status, 404, 'another session’s run');
    assert.equal((await w.call(`/runs/${run.id}`, { method: 'DELETE', bearer: a })).status, 200);
    assert.equal((await w.call('/runs', { method: 'POST', bearer: a, body: 'not json' })).status, 400);
    assert.equal((await w.call('/nothing', { bearer: a })).status, 404);
  } finally {
    w.done();
  }
  const bare = await world({});
  try {
    assert.equal((await bare.call('/runs', { method: 'POST', bearer: await bare.token('docker/api', 's1'), body: '{}' })).status, 503);
  } finally {
    bare.done();
  }
});

test('guards: a body over 64 KiB is 413 before the key; 30 refusals a minute per address, then 429; 120 calls a minute per session', async () => {
  const w = await world({ runner: new FakeRunner() });
  try {
    const good = await w.token('docker/api', 's1');
    const big = await w.call('/runs', { method: 'POST', bearer: good, body: 'x'.repeat(JOBRUN_DOOR_LIMITS.bodyMaxBytes + 1) });
    assert.equal(big.status, 413);
    for (let i = 0; i < JOBRUN_DOOR_LIMITS.refusedMinute; i++) assert.equal((await w.call('/slot')).status, 404);
    const limited = await w.call('/slot', { bearer: good });
    assert.equal(limited.status, 429, 'the address is held, even with a good key');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    w.tick(60_001);
    for (let i = 0; i < JOBRUN_DOOR_LIMITS.sessionMinute; i++) assert.equal((await w.call('/slot', { bearer: good })).status, 200);
    assert.equal((await w.call('/slot', { bearer: good })).status, 429);
    w.tick(60_001);
    assert.equal((await w.call('/slot', { bearer: good })).status, 200);
  } finally {
    w.done();
  }
});
