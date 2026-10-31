// T-2950 (general-manager PRD §9.2): `schedule_get`, `schedule_set_enabled`, `schedule_run_now`, and why no scheduled pipeline is listed.
// Allowed: an operate token reads a row with its runs, switches a trigger and runs it now, through the trigger service's own calls.
// Denied: a read token never reaches the writes; a seam denial on the platform's `system` area, a trigger of another user and an unknown id
// are the same NOT_FOUND, before anything is changed; an agent's token never reaches them; a loop cannot be switched, a webhook trigger
// cannot be run now.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { objectRef, type TriggerRunState, type UserId } from '@portal/contracts';
import { clearResolvers, declaredToolPolicies, OWNER_ID, registerResolver } from '../authz/seam.js';
import { validatePipeline } from '../ci/spec/validate.js';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import type { FireResult } from '../triggers/runner.js';
import type { TriggerRecord } from '../triggers/store.js';
import { scheduleTriggers, type ScheduleTriggers } from './actions.js';
import { declareSchedulesPolicies, SCHEDULES_TOOL_POLICIES } from './authz.js';
import { HelperRegistry } from './helpers.js';
import { registerScheduleActionTools } from './portalTools.js';
import { LoopRegistry } from './registry.js';
import { Schedules } from './service.js';

declareSchedulesPolicies();
after(() => clearResolvers());

const at = (s: number) => new Date(Date.UTC(2026, 9, 17, 12, 0, s));
const AT = at(0).toISOString();

const record = (o: Partial<TriggerRecord>): TriggerRecord =>
  ({ id: 'trg_a', ownerId: OWNER_ID, name: 'Nightly', enabled: true, source: 'cron', cron: { expr: '0 3 * * *', tz: 'UTC', catchUp: 'skip' }, paused: null, nextRunAt: at(30).toISOString(), lastRunAt: null, action: { type: 'ticket', workspaceId: 'docker/api-dev' }, ...o }) as TriggerRecord;

/** Three triggers (mine, a webhook of mine, another user's) and one loop; every write recorded. */
function world(fire: FireResult['kind'] = 'run') {
  const triggers = new Map<string, TriggerRecord>([
    ['trg_a', record({})],
    ['trg_wh', record({ id: 'trg_wh', name: 'PR opened', source: 'webhook', cron: null, nextRunAt: null })],
    ['trg_bob', record({ id: 'trg_bob', ownerId: 'u_bob', name: 'Bob’s' })],
  ]);
  const calls: string[] = [];
  const store = {
    list: () => [...triggers.values()],
    runs: (f: { triggerId: string }) => ({ rows: f.triggerId === 'trg_a' ? [{ state: 'succeeded' as TriggerRunState }] : [] }),
  };
  const loops = new LoopRegistry();
  loops.define({ name: 'a-loop', module: 'test', intervalMs: 1000, description: 'x' }).started(at(0));
  const schedules = new Schedules({ loops, measured: () => [], helpers: new HelperRegistry(), triggers: store, now: () => at(1) });
  const actions: ScheduleTriggers = {
    get: (id) => triggers.get(id) ?? null,
    runs: (t) => (t.id === 'trg_a' ? [{ id: 'run_1', at: AT, state: 'succeeded', reason: null, sessionId: 's_1', ticketId: null }] : []),
    setEnabled(t, enabled, actor) {
      calls.push(`switch ${t.id} ${enabled} by ${actor}`);
      const next = { ...t, enabled };
      triggers.set(t.id, next);
      return next;
    },
    async runNow(t, actor) {
      calls.push(`run ${t.id} by ${actor}`);
      if (fire !== 'run') return { kind: fire } as FireResult;
      return { kind: 'run', run: { id: 'run_2', at: AT, state: 'starting', reason: null, sessionId: null, ticketId: null } } as unknown as FireResult;
    },
  };
  // Triggers resolve to their owner, as triggers/authz.ts does.
  registerResolver({ type: 'trigger', resolve: (id) => (triggers.has(id) ? { ref: objectRef('trigger', id), owner: { kind: 'user', id: triggers.get(id)!.ownerId as UserId } } : null) });
  return { schedules, actions, calls };
}

async function harness(fire?: FireResult['kind']) {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const w = world(fire);
  registerScheduleActionTools(w.schedules, w.actions, registry);
  return { h, w };
}

type Result = Awaited<ReturnType<Awaited<ReturnType<typeof portalMcpHarness>>['call']>>;
const code = (r: Result) => (r.result?.isError ? r.result.structuredContent?.error?.code : r.error ? `rpc:${r.error.code}` : 'ok');

test('declared through the seam: get is view, the writes are operate, on the platform’s system area', () => {
  assert.deepEqual(SCHEDULES_TOOL_POLICIES.schedule_get, { kind: 'platform', area: 'system', verb: 'view' });
  assert.deepEqual(SCHEDULES_TOOL_POLICIES.schedule_set_enabled, { kind: 'platform', area: 'system', verb: 'operate', audit: 'trigger.updated' });
  assert.deepEqual(SCHEDULES_TOOL_POLICIES.schedule_run_now, { kind: 'platform', area: 'system', verb: 'operate', audit: 'trigger.fired' });
  for (const n of ['schedule_get', 'schedule_set_enabled', 'schedule_run_now'] as const) assert.deepEqual(declaredToolPolicies().get(n), SCHEDULES_TOOL_POLICIES[n]);
});

test('allowed: an operate token reads a trigger with its runs and a loop, switches the trigger off and on, and runs it now', async () => {
  const { h, w } = await harness();
  try {
    const op = h.token('operate').secret;
    const got = await h.call(op, 'schedule_get', { id: 'trigger:trg_a' });
    assert.equal(code(got), 'ok', JSON.stringify(got.raw));
    const sc = got.result!.structuredContent;
    assert.deepEqual(sc.schedule.name, { untrusted_text: 'Nightly', source: 'trigger' }, 'a trigger’s name is untrusted text');
    assert.deepEqual(sc.runs, [{ id: 'run_1', at: AT, state: 'succeeded', reason: null, session_id: 's_1', ticket_id: null }]);
    const loop = await h.call(op, 'schedule_get', { id: 'loop:a-loop' });
    assert.deepEqual([loop.result!.structuredContent.schedule.name, loop.result!.structuredContent.runs], ['a-loop', []]);

    const off = await h.call(op, 'schedule_set_enabled', { id: 'trigger:trg_a', enabled: false });
    assert.equal(code(off), 'ok', JSON.stringify(off.raw));
    assert.equal(off.result!.structuredContent.schedule.state, 'disabled', 'the answer is the row as it is now');
    assert.match(off.result!.structuredContent.summary, /is off/);
    await h.call(op, 'schedule_set_enabled', { id: 'trigger:trg_a', enabled: true });

    const run = await h.call(op, 'schedule_run_now', { id: 'trigger:trg_a' });
    assert.equal(code(run), 'ok', JSON.stringify(run.raw));
    assert.equal(run.result!.structuredContent.run.id, 'run_2');
    assert.equal(w.calls.length, 3);
    assert.match(w.calls[0]!, /^switch trg_a false by /);
    assert.match(w.calls[1]!, /^switch trg_a true by /);
    assert.match(w.calls[2]!, /^run trg_a by /);
  } finally {
    h.done();
  }
});

test('denied: a read token, a seam denial, another user’s trigger, an unknown id and an agent token change nothing; the refusals read alike', async () => {
  const { h, w } = await harness();
  try {
    const read = h.token('read').secret;
    assert.equal(code(await h.call(read, 'schedule_get', { id: 'trigger:trg_a' })), 'ok', 'a read token may read');
    for (const [tool, args] of [['schedule_set_enabled', { id: 'trigger:trg_a', enabled: false }], ['schedule_run_now', { id: 'trigger:trg_a' }]] as const) {
      const r = await h.call(read, tool, args);
      assert.notEqual(code(r), 'ok', `${tool}: a read token is refused`);
    }

    const op = h.token('operate').secret;
    const unknown = await h.call(op, 'schedule_run_now', { id: 'trigger:trg_nope' });
    const bobs = await h.call(op, 'schedule_run_now', { id: 'trigger:trg_bob' });
    const bobsSwitch = await h.call(op, 'schedule_set_enabled', { id: 'trigger:trg_bob', enabled: false });
    const bobsGet = await h.call(op, 'schedule_get', { id: 'trigger:trg_bob' });
    for (const r of [unknown, bobs, bobsSwitch, bobsGet]) assert.equal(code(r), 'NOT_FOUND');
    assert.equal(bobs.result!.structuredContent.error.message, unknown.result!.structuredContent.error.message, 'another user’s trigger reads like a missing one');

    // The platform's `system` area belongs to someone else: refused at dispatch, before the handler.
    registerResolver({ type: 'platform', resolve: (id) => ({ ref: objectRef('platform', id), owner: { kind: 'user', id: 'u_b' as UserId } }) });
    try {
      for (const [tool, args] of [['schedule_get', { id: 'loop:a-loop' }], ['schedule_set_enabled', { id: 'trigger:trg_a', enabled: false }], ['schedule_run_now', { id: 'trigger:trg_a' }]] as const)
        assert.equal(code(await h.call(op, tool, args)), 'NOT_FOUND', `${tool}: a seam denial is NOT_FOUND`);
    } finally {
      clearResolvers();
      world(); // the trigger resolver again
    }

    const agent = await h.agentToken('docker/api-dev', 's_a');
    for (const tool of ['schedule_get', 'schedule_set_enabled', 'schedule_run_now']) {
      const r = await h.call(agent.secret, tool, { id: 'trigger:trg_a', enabled: false });
      assert.notEqual(code(r), 'ok', `${tool}: an agent token is refused`);
    }
    assert.deepEqual(w.calls, [], 'nothing was switched or run');
  } finally {
    h.done();
  }
});

test('only a trigger is switched or run; a webhook trigger is not run now; a run the portal drops says so', async () => {
  const { h, w } = await harness('dropped');
  try {
    const op = h.token('operate').secret;
    const loop = await h.call(op, 'schedule_set_enabled', { id: 'loop:a-loop', enabled: false });
    assert.equal(code(loop), 'CONFLICT');
    assert.equal(code(await h.call(op, 'schedule_run_now', { id: 'loop:a-loop' })), 'CONFLICT');
    assert.equal(code(await h.call(op, 'schedule_run_now', { id: 'trigger:trg_wh' })), 'CONFLICT');
    assert.deepEqual(w.calls, []);
    assert.equal(code(await h.call(op, 'schedule_run_now', { id: 'trigger:trg_a' })), 'SERVICE_UNAVAILABLE');
  } finally {
    h.done();
  }
});

test('scheduleTriggers: the switch goes through the trigger service’s update with an audit row and a live push; Run now fires a manual, unfiltered event', async () => {
  const seen: unknown[] = [];
  const t = record({});
  const a = scheduleTriggers({
    service: {
      update: (r: TriggerRecord, input: unknown) => (seen.push(['update', r.id, input]), { ...r, enabled: false }),
      store: { get: () => t, runs: () => ({ rows: [], next: null }), view: () => ({}) } as never,
    },
    runner: { fire: async (r: TriggerRecord, input: unknown) => (seen.push(['fire', r.id, input]), { kind: 'dropped' }) as FireResult },
    audit: { record: (e: unknown) => void seen.push(['audit', e]) },
    publish: () => void seen.push(['publish']),
    now: () => at(5),
  });
  a.setEnabled(t, false, 'my-token');
  await a.runNow(t, 'my-token');
  assert.deepEqual(seen[0], ['update', 'trg_a', { enabled: false }]);
  assert.equal((seen[1] as [string, { kind: string; subject: string; actor: string }])[1].kind, 'trigger.updated');
  assert.equal((seen[1] as [string, { subject: string }])[1].subject, 'trigger:trg_a');
  assert.deepEqual(seen[2], ['publish']);
  const fire = seen[3] as [string, string, { actor: string; unfiltered: boolean; facts: { event: string; at: string } }];
  assert.deepEqual([fire[0], fire[1], fire[2].actor, fire[2].unfiltered, fire[2].facts.event, fire[2].facts.at], ['fire', 'trg_a', 'my-token', true, 'schedule', at(5).toISOString()]);
});

test('scheduled pipelines (item 1): CI refuses `on: schedule` as not yet, so the list has no pipeline rows; a manual pipeline is valid', () => {
  const sched = validatePipeline('.pilot/nightly.yml', 'on:\n  schedule: [{cron: "0 3 * * *"}]\njobs:\n  a:\n    steps: [{run: x}]\n');
  assert.ok(sched.info.diagnostics.some((d) => d.severity === 'error' && d.code === 'not-yet'), 'refused as not yet');
  assert.deepEqual(sched.info.triggers, [], 'no schedule trigger reaches the plan');
  const manual = validatePipeline('.pilot/nightly.yml', 'on: manual\njobs:\n  a:\n    steps: [{run: x}]\n');
  assert.deepEqual(manual.info.diagnostics, []);
  const kinds = new Set(world().schedules.list().map((r) => r.kind));
  assert.deepEqual([...kinds].sort(), ['loop', 'trigger']);
});
