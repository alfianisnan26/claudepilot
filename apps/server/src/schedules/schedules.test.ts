// The schedules registry, `GET /api/schedules` and `schedules_list` (T-968 S2b, T-965, general-manager PRD §9.2): the registry lists the
// portal's real loops; a heartbeat moves the last run, the result and the next run; a loop that stopped beating for two intervals is
// stale; the route and the tool refuse anyone without `view` on the platform's `system` area with NOT_FOUND, before the list is read.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { Hono } from 'hono';
import { objectRef, type Actor, type TriggerRunState, type UserId } from '@portal/contracts';
import { clearResolvers, declaredPolicies, declaredToolPolicies, registerResolver } from '../authz/seam.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { ORPHAN_LOOP, OrphanSweep } from '../tickets/orphans.js';
import type { TriggerRecord } from '../triggers/store.js';
// The loops, imported for their definitions.
import '../claudeusage/service.js';
import '../claudeversion/service.js';
import '../delivery/reconciler.js';
import '../notify/pipeline.js';
import '../triggers/scheduler.js';
import { declareSchedulesPolicies, SCHEDULES_POLICIES, SCHEDULES_TOOL_POLICIES } from './authz.js';
import { registerSchedulesTools } from './portalTools.js';
import { LoopRegistry, portalLoops } from './registry.js';
import { createSchedulesRoutes } from './routes.js';
import { Schedules } from './service.js';

declareSchedulesPolicies();
after(() => clearResolvers());

/** A credential-shaped value, built at run time (no token-shaped literal in the repository). */
const fakeToken = () => ['cp', 'at_', 'Q7x'.repeat(10)].join('');
const at = (s: number) => new Date(Date.UTC(2026, 9, 17, 12, 0, s));

const REAL_LOOPS = ['delivery-reconcile', 'notify-clock', 'orphan-sweep', 'triggers-cron', 'usage-probe', 'version-canary'];

test('the registry lists the portal\'s real loops, each with its module and interval', () => {
  assert.deepEqual(portalLoops.names().filter((n) => REAL_LOOPS.includes(n)), REAL_LOOPS);
  const rows = new Map(portalLoops.rows().map((r) => [r.name, r]));
  assert.deepEqual([rows.get('orphan-sweep')!.module, rows.get('orphan-sweep')!.interval_ms], ['tickets', 60_000]);
  assert.deepEqual([rows.get('triggers-cron')!.module, rows.get('triggers-cron')!.interval_ms], ['triggers', 30_000]);
  assert.deepEqual([rows.get('version-canary')!.module, rows.get('version-canary')!.interval_ms], ['claudeversion', 15 * 60_000]);
  for (const r of rows.values()) assert.equal(r.kind, 'loop');
});

test('a heartbeat updates the last run, the result and the next run; a failure is kept, cleaned and cut', () => {
  const reg = new LoopRegistry();
  const beat = reg.define({ name: 't-loop', module: 'test', intervalMs: 30_000, description: 'A test loop.' });
  assert.equal(reg.define({ name: 't-loop', module: 'other', intervalMs: 1, description: '' }), beat, 'the same name is the same heartbeat');
  assert.deepEqual(reg.rows(at(0))[0], { id: 'loop:t-loop', kind: 'loop', name: 't-loop', module: 'test', description: 'A test loop.', interval_ms: 30_000, cron: null, last_run: null, last_result: null, last_error: null, next_run: null, state: 'stopped' });
  beat.started(at(0));
  assert.equal(reg.rows(at(1))[0]!.next_run, at(30).toISOString(), 'before the first beat, the next run counts from the start');
  beat.ok(at(10));
  let r = reg.rows(at(11))[0]!;
  assert.deepEqual([r.last_run, r.last_result, r.next_run, r.state], [at(10).toISOString(), 'ok', at(40).toISOString(), 'ok']);
  const secret = fakeToken();
  beat.fail(new Error(`push refused for ${secret} ${'x'.repeat(400)}`), at(40));
  r = reg.rows(at(41))[0]!;
  assert.deepEqual([r.last_run, r.last_result, r.state], [at(40).toISOString(), 'failed', 'failing']);
  assert.ok(!r.last_error!.includes(secret), 'the error is cleaned of credentials');
  assert.ok(r.last_error!.length <= 200);
  beat.ok(at(70));
  assert.deepEqual([reg.rows(at(71))[0]!.state, reg.rows(at(71))[0]!.last_error], ['ok', null]);
});

test('a real loop beats: the orphan sweep\'s pass moves its last run; stop marks it stopped', () => {
  const timer: { fn: (() => void) | null } = { fn: null };
  let now = at(0);
  const sweep = new OrphanSweep({ sweepOrphans: () => 0 as never, orphanLastRun: () => null }, { now: () => now, random: () => 0, setTimer: (fn) => ((timer.fn = fn), {}), clearTimer: () => undefined });
  sweep.start();
  now = at(5);
  timer.fn!();
  const row = () => portalLoops.rows(now).find((r) => r.name === ORPHAN_LOOP.name)!;
  assert.deepEqual([row().last_run, row().last_result, row().state], [at(5).toISOString(), 'ok', 'ok']);
  sweep.stop();
  assert.deepEqual([row().state, row().next_run], ['stopped', null]);
});

test('a loop that has not beaten for two intervals is stale; a stopped one never is', () => {
  const reg = new LoopRegistry();
  const beat = reg.define({ name: 't-stale', module: 'test', intervalMs: 30_000, description: 'x' });
  beat.started(at(0));
  assert.equal(reg.rows(at(60))[0]!.state, 'ok', 'exactly two intervals is not late yet');
  assert.equal(reg.rows(at(61))[0]!.state, 'stale', 'never beaten since the start, past two intervals');
  beat.ok(at(61));
  assert.equal(reg.rows(at(100))[0]!.state, 'ok');
  assert.equal(reg.rows(at(122))[0]!.state, 'stale');
  beat.fail(new Error('boom'), at(122));
  assert.equal(reg.rows(at(183))[0]!.state, 'stale', 'late wins over failing: the loop no longer runs');
  beat.stopped();
  assert.equal(reg.rows(at(500))[0]!.state, 'stopped');
});

const trigger = (o: Partial<TriggerRecord>): TriggerRecord =>
  ({ id: 'trg_a', ownerId: 'u_a', name: 'Nightly', enabled: true, source: 'cron', cron: { expr: '0 3 * * *', tz: 'Asia/Jakarta', catchUp: 'skip' }, paused: null, nextRunAt: at(30).toISOString(), lastRunAt: at(0).toISOString(), ...o }) as TriggerRecord;

function schedules(reached: { n: number }, runs: Record<string, TriggerRunState> = {}) {
  const loops = new LoopRegistry();
  loops.define({ name: 'a-loop', module: 'test', intervalMs: 1000, description: 'x' }).started(at(0));
  const triggers = {
    bySource: () => [trigger({}), trigger({ id: 'trg_b', name: `key ${fakeToken()}`, enabled: false }), trigger({ id: 'trg_c', name: 'Weekly' })],
    runs: (f: { triggerId: string }) => ({ rows: runs[f.triggerId] ? [{ state: runs[f.triggerId]! }] : [] }),
  };
  const s = new Schedules({ loops, triggers, now: () => at(1) });
  return { list: () => (reached.n++, s.list()) };
}

test('the list: loops, then the cron triggers with their times and how their last run ended', () => {
  const rows = schedules({ n: 0 }, { trg_a: 'succeeded', trg_c: 'failed' }).list();
  assert.deepEqual(rows.map((r) => [r.id, r.kind, r.state, r.last_result, r.next_run]), [
    ['loop:a-loop', 'loop', 'ok', null, at(1).toISOString()],
    ['trigger:trg_a', 'trigger', 'ok', 'ok', at(30).toISOString()],
    ['trigger:trg_b', 'trigger', 'disabled', null, null],
    ['trigger:trg_c', 'trigger', 'failing', 'failed', at(30).toISOString()],
  ]);
  assert.deepEqual(rows[1]!.cron, { expr: '0 3 * * *', tz: 'Asia/Jakarta' });
  assert.ok(!JSON.stringify(rows).includes(fakeToken()), 'a credential-shaped trigger name is cleaned');
});

function app(list: { list: () => unknown[] }, actor?: Actor) {
  const a = new Hono<{ Variables: { token: string; actor: Actor } }>();
  a.use(async (c, next) => {
    if (actor) c.set('actor', actor);
    else c.set('token', 'signed-in');
    await next();
  });
  a.onError((e, c) => (isAppError(e) ? c.json({ error: { code: e.code, message: e.message } }, e.status as 404) : c.json({ error: { code: 'INTERNAL' } }, 500)));
  a.route('/api/schedules', createSchedulesRoutes(list as never));
  return a;
}

test('GET /api/schedules: the owner reads the list; another user is told it does not exist and the list is never read', async () => {
  const reached = { n: 0 };
  const list = schedules(reached);
  const ok = await app(list).request('/api/schedules');
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { data: { items: unknown[] } }).data.items.length, 4);
  const before = reached.n;
  const bob = { kind: 'user', userId: 'u_bob', loginSessionId: 'x', via: 'ui' } as Actor;
  const denied = await app(list, bob).request('/api/schedules');
  assert.equal(denied.status, 404);
  assert.equal(((await denied.json()) as { error: { code: string } }).error.code, 'NOT_FOUND');
  assert.equal(reached.n, before, 'the handler never read the list for a refused call');
});

test('schedules_list: a read token sees loops and triggers, a trigger\'s name as untrusted text; denied is NOT_FOUND before the handler; an agent never reaches it', async () => {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const reached = { n: 0 };
  registerSchedulesTools(schedules(reached, { trg_c: 'failed' }), registry);
  try {
    const read = h.token('read').secret;
    const all = await h.call(read, 'schedules_list', {});
    assert.equal(all.result?.isError, undefined, JSON.stringify(all.raw));
    const rows = all.result!.structuredContent.schedules as { id: string; name: unknown }[];
    assert.deepEqual(rows.map((r) => r.id), ['loop:a-loop', 'trigger:trg_a', 'trigger:trg_b', 'trigger:trg_c']);
    assert.equal(rows[0]!.name, 'a-loop');
    assert.deepEqual(rows[1]!.name, { untrusted_text: 'Nightly', source: 'trigger' });
    assert.match(all.result!.structuredContent.summary, /4 schedules, 1 failing/);
    const attention = await h.call(read, 'schedules_list', { attention: true });
    assert.deepEqual((attention.result!.structuredContent.schedules as { id: string }[]).map((r) => r.id), ['trigger:trg_c']);
    const before = reached.n;
    registerResolver({ type: 'platform', resolve: (id) => ({ ref: objectRef('platform', id), owner: { kind: 'user', id: 'u_b' as UserId } }) });
    try {
      const denied = await h.call(read, 'schedules_list', {});
      assert.equal(denied.result?.isError, true);
      assert.equal(denied.result!.structuredContent.error.code, 'NOT_FOUND');
      assert.equal(reached.n, before, 'the handler never ran for a refused call');
    } finally {
      clearResolvers();
    }
    const agent = await h.agentToken('docker/api-dev', 's_a');
    const fromAgent = await h.call(agent.secret, 'schedules_list', {});
    assert.ok(fromAgent.result?.isError === true || !!fromAgent.error, 'an agent token is refused');
    assert.equal(reached.n, before, 'nor did the agent\'s');
  } finally {
    h.done();
  }
});

test('declared through the seam: view on the platform\'s system area, for the route and the tool', () => {
  assert.deepEqual(SCHEDULES_POLICIES, { 'GET /api/schedules': { kind: 'platform', area: 'system', verb: 'view' } });
  assert.deepEqual(SCHEDULES_TOOL_POLICIES, { schedules_list: { kind: 'platform', area: 'system', verb: 'view' } });
  assert.deepEqual(declaredPolicies().get('GET /api/schedules'), SCHEDULES_POLICIES['GET /api/schedules']);
  assert.deepEqual(declaredToolPolicies().get('schedules_list'), SCHEDULES_TOOL_POLICIES.schedules_list);
});
