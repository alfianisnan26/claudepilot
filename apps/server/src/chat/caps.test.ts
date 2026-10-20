// Caps on running sessions (chat-sessions PRD FR39): the plan for making room, and the controller keeping to it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { capError, makeRoom, SESSION_CAP, weightOf } from './caps.js';
import { line, liveSession, sleep, until, type Live } from './testkit.js';

const live = (...rows: [string, string, number?][]) => rows.map(([id, workspaceId, weight = 1]) => ({ id, workspaceId, weight }));
const idle = (...rows: [string, number][]) => rows.map(([id, since]) => ({ id, since }));

test('makeRoom: nothing to do under the caps; the longest-idle session of the workspace sleeps first; the total is eased by the longest-idle anywhere', () => {
  const caps = { perWorkspace: 2, total: 4 };
  assert.deepEqual(makeRoom(live(['a', 'w1']), idle(['a', 1]), 'w1', 1, caps), { sleep: [] });
  assert.deepEqual(makeRoom(live(['a', 'w1'], ['b', 'w1']), idle(['a', 5], ['b', 2]), 'w1', 1, caps), { sleep: ['b'] }, 'b has been idle longer');
  // Another workspace's idle session doesn't ease this workspace's cap.
  assert.deepEqual(makeRoom(live(['a', 'w1'], ['b', 'w1'], ['c', 'w2']), idle(['c', 1]), 'w1', 1, caps), { refuse: { scope: 'workspace', limit: 2, running: 2 } });
  // The total: w3 has room of its own, the portal doesn't; the longest-idle anywhere sleeps.
  const full = live(['a', 'w1'], ['b', 'w1'], ['c', 'w2'], ['d', 'w2']);
  assert.deepEqual(makeRoom(full, idle(['b', 9], ['c', 3]), 'w3', 1, caps), { sleep: ['c'] });
  assert.deepEqual(makeRoom(full, idle(), 'w3', 1, caps), { refuse: { scope: 'total', limit: 4, running: 4 } });
  // Ultracode counts as two, on either side.
  assert.equal(weightOf({ ultracode: 1 }), 2);
  assert.deepEqual(makeRoom(live(['a', 'w1', 2]), idle(), 'w1', 1, { perWorkspace: 2, total: 9 }), { refuse: { scope: 'workspace', limit: 2, running: 2 } });
  assert.deepEqual(makeRoom(live(['a', 'w1']), idle(['a', 1]), 'w1', 2, { perWorkspace: 2, total: 9 }), { sleep: ['a'] }, 'an Ultracode session needs two slots');
  // More than one may have to sleep.
  assert.deepEqual(makeRoom(live(['a', 'w1'], ['b', 'w1']), idle(['a', 1], ['b', 2]), 'w1', 2, { perWorkspace: 2, total: 9 }), { sleep: ['a', 'b'] });
  // T-417: the lower rank sleeps first (an idle worker before an idle chat without workers), however long the other was idle.
  assert.deepEqual(makeRoom(live(['a', 'w1'], ['b', 'w1']), [{ id: 'a', since: 1, rank: 1 }, { id: 'b', since: 9, rank: 0 }], 'w1', 1, caps), { sleep: ['b'] });
  const e = capError('workspace', 2, 2, 'docker/api');
  assert.equal(e.code, SESSION_CAP);
  assert.match(e.message, /2 sessions are already running in docker\/api, which is the limit \(Settings › Running agents\)/);
});

/** A session that has had its first turn and is idle (so it may sleep), on the fake host. */
async function idleSession(s: Live) {
  const before = s.ws.tails.length;
  const created = await s.controller.create({ workspaceId: 'docker/ws1' });
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(created.id)?.state === 'idle');
  await sleep(20);
  return created;
}

test('over the per-workspace cap a new session puts the longest-idle one to sleep; with none that can, it waits for a slot, then is refused naming the cap', async () => {
  const s = await liveSession();
  try {
    s.controller.liveCaps = () => ({ perWorkspace: 2, total: 10 });
    const second = await idleSession(s); // the first (liveSession's) and this one: two awake
    assert.equal(s.controller.list().filter((x) => x.process === 'live').length, 2);
    const third = await idleSession(s);
    const procs = Object.fromEntries(s.controller.list().map((x) => [x.id, x.process]));
    assert.equal(procs[s.id], 'asleep', 'the longest-idle one went to sleep');
    assert.equal(procs[second.id], 'live');
    assert.equal(procs[third.id], 'live');
    assert.deepEqual(s.controller.audit({ kind: 'cap.slept' }).map((a) => a.sessionId), [s.id]);

    // A working session never sleeps for this: with both of the awake ones busy, the next start waits for a slot (T-417), saying why;
    // when none comes free in time it reads Interrupted, naming the cap.
    for (const x of [second, third]) await s.controller.send(x.id, `u-${x.id.slice(0, 6)}`, 'work');
    await until(() => [second.id, third.id].every((id) => s.controller.get(id)!.state === 'working'));
    s.controller.slotWaitMs = 300;
    s.controller.slotPollMs = 20;
    const queued = await s.controller.create({ workspaceId: 'docker/ws1' });
    assert.match(queued.slotWait ?? '', /^Waiting for a slot · 2 of 2 running in docker\/ws1 \(Settings › Running agents\)$/);
    assert.equal(s.controller.list().length, 4, 'the session is made; its start waits');
    await until(() => s.controller.get(queued.id)!.state === 'interrupted');
    assert.match(s.controller.get(queued.id)!.endedReason ?? '', /2 sessions are already running in docker\/ws1/);
    assert.equal(s.controller.get(queued.id)!.slotWait ?? null, null);

    // Waking the sleeper at the cap waits the same way (nothing can sleep), then is refused naming the cap instead of hanging.
    const woken = await s.controller.send(s.id, 'wake-1', 'hello').then(() => null, (e: unknown) => e);
    assert.ok(isAppError(woken) && woken.code === SESSION_CAP, String(woken));
    assert.match((woken as Error).message, /2 sessions are already running in docker\/ws1/);
    assert.deepEqual((woken as unknown as { details: unknown }).details, { scope: 'workspace', limit: 2, running: 2, setting: 'sessions.maxLivePerWorkspace' });
    // Lowering a cap never stops a running session.
    s.controller.liveCaps = () => ({ perWorkspace: 1, total: 1 });
    assert.equal(s.controller.get(second.id)!.process, 'live');
  } finally {
    await s.done();
  }
});

test('the total cap counts every workspace; no caps installed, no limit', async () => {
  const s = await liveSession();
  try {
    for (let i = 0; i < 3; i++) await idleSession(s);
    assert.equal(s.controller.list().filter((x) => x.process === 'live').length, 4, 'no caps: all awake');
    s.controller.liveCaps = () => ({ perWorkspace: 99, total: 4 });
    const next = await idleSession(s);
    const awake = s.controller.list().filter((x) => x.process === 'live');
    assert.equal(awake.length, 4);
    assert.ok(awake.some((x) => x.id === next.id));
    assert.equal(s.controller.get(s.id)!.process, 'asleep', 'the longest-idle in the whole portal');
  } finally {
    await s.done();
  }
});

test('the spending limit is the setting (ten dollars when none), and a turn Claude Code stopped for it says so in words', async () => {
  const s = await liveSession();
  try {
    assert.deepEqual(s.ws.startArgs[0]!.slice(s.ws.startArgs[0]!.indexOf('--max-budget-usd'), s.ws.startArgs[0]!.indexOf('--max-budget-usd') + 2), ['--max-budget-usd', '10']);
    s.controller.sessionBudgetUsd = () => 25;
    await idleSession(s);
    const args = s.ws.startArgs.at(-1)!;
    assert.deepEqual(args.slice(args.indexOf('--max-budget-usd'), args.indexOf('--max-budget-usd') + 2), ['--max-budget-usd', '25']);
    s.controller.sessionBudgetUsd = () => Number.NaN;
    await idleSession(s);
    assert.equal(s.ws.startArgs.at(-1)![s.ws.startArgs.at(-1)!.indexOf('--max-budget-usd') + 1], '10', 'nonsense falls back to the default');
    s.tail.push(line({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 10.02, session_id: s.id }));
    await until(() => s.controller.history(s.id).some((e) => e.kind === 'error'));
    assert.match(s.controller.history(s.id).find((e) => e.kind === 'error')!.text!, /^Budget reached: this session hit its spending limit/);
  } finally {
    await s.done();
  }
});
