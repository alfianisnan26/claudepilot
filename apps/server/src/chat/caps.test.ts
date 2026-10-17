// Caps on running sessions (chat-sessions PRD FR39): the plan for making room, and the controller keeping to it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
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
  assert.match(e.message, /2 sessions are already running in docker\/api, which is the limit \(Settings › Sessions\)/);
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
    assert.match(queued.slotWait ?? '', /^Waiting for a slot · 2 of 2 running in docker\/ws1 \(Settings › Sessions\)$/);
    assert.equal(s.controller.list().length, 4, 'the session is made; its start waits');
    await until(() => s.controller.get(queued.id)!.state === 'interrupted');
    assert.match(s.controller.get(queued.id)!.endedReason ?? '', /2 sessions are already running in docker\/ws1/);
    assert.equal(s.controller.get(queued.id)!.slotWait ?? null, null);

    // Waking the sleeper at the cap waits the same way (nothing can sleep). T-425: the send does not wait with it: the message is stored and
    // the session says why at once; the wake is refused naming the cap when the wait runs out, and the transcript says it wasn't delivered.
    s.controller.slotWaitMs = 400;
    const t0 = Date.now();
    await s.controller.send(s.id, 'wake-1', 'hello');
    assert.ok(Date.now() - t0 < 300, 'the send returns without waiting for the slot');
    assert.ok(s.controller.history(s.id).some((e) => e.kind === 'user' && e.text === 'hello'), 'the message is stored at once');
    assert.match(s.controller.get(s.id)!.slotWait ?? '', /^Waiting for a slot · 2 of 2 running in docker\/ws1/);
    await until(() => s.controller.history(s.id).some((e) => /wasn’t delivered: .*2 sessions are already running in docker\/ws1/.test(e.text ?? '')));
    assert.equal(s.controller.get(s.id)!.slotWait ?? null, null);
    assert.deepEqual(s.controller.inputStates(s.id).filter((x) => x.uuid === 'wake-1'), [{ uuid: 'wake-1', state: 'failed' }], 'the refused wake marks its input failed');
    assert.equal(s.controller.get(s.id)!.process, 'asleep');
    // Lowering a cap never stops a running session.
    s.controller.liveCaps = () => ({ perWorkspace: 1, total: 1 });
    assert.equal(s.controller.get(second.id)!.process, 'live');
  } finally {
    await s.done();
  }
});

test('T-425: a send to a session waiting for a slot returns at once with the message stored, and the line goes to Claude when the slot comes', async () => {
  const s = await liveSession();
  try {
    s.controller.liveCaps = () => ({ perWorkspace: 2, total: 10 });
    const second = await idleSession(s);
    const third = await idleSession(s); // s.id slept for it
    assert.equal(s.controller.get(s.id)!.process, 'asleep');
    for (const x of [second, third]) await s.controller.send(x.id, `w-${x.id.slice(0, 6)}`, 'work');
    await until(() => [second.id, third.id].every((id) => s.controller.get(id)!.state === 'working'));
    s.controller.slotWaitMs = 5000;
    s.controller.slotPollMs = 20;
    s.controller.controlTimeoutMs = 150; // the wake's own control request (the settings put back) goes unanswered here
    const sends = s.ws.sends.length;
    const t0 = Date.now();
    await s.controller.send(s.id, 'wait-1', 'hello after the wait');
    assert.ok(Date.now() - t0 < 1000, 'the send did not wait for the slot');
    assert.ok(s.controller.history(s.id).some((e) => e.kind === 'user' && e.text === 'hello after the wait'), 'stored at once');
    assert.match(s.controller.get(s.id)!.slotWait ?? '', /^Waiting for a slot/);
    assert.equal(s.ws.sends.length, sends, 'nothing reached Claude yet');
    s.controller.liveCaps = () => ({ perWorkspace: 5, total: 10 }); // a slot comes
    await until(() => s.controller.get(s.id)!.process === 'live', 4000);
    await until(() => s.ws.sends.slice(sends).some((x) => x.line.includes('hello after the wait')) || s.controller.history(s.id).some((e) => /wasn’t delivered/.test(e.text ?? '')), 4000).catch((e: unknown) => {
      throw new Error(`${String(e)}; lines: ${JSON.stringify(s.ws.sends.slice(sends).map((x) => x.line.slice(0, 80)))}; notes: ${JSON.stringify(s.controller.history(s.id).filter((e2) => e2.kind === 'system').map((e2) => e2.text))}`);
    });
    assert.ok(s.ws.sends.slice(sends).some((x) => x.line.includes('hello after the wait')), 'the line reached Claude Code');
    assert.equal(s.controller.get(s.id)!.slotWait ?? null, null);
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

/** Resolves 'hung' when `p` has not settled within `ms`. */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => 'done' as const), sleep(ms).then(() => 'hung' as const)]);

/** The cap full with two working sessions and `s.id` asleep, as the T-425 slot test sets it up; a send to `s.id` then waits for a slot. */
async function asleepAtCap(s: Live) {
  s.controller.liveCaps = () => ({ perWorkspace: 2, total: 10 });
  const second = await idleSession(s);
  const third = await idleSession(s); // s.id slept for it
  assert.equal(s.controller.get(s.id)!.process, 'asleep');
  for (const x of [second, third]) await s.controller.send(x.id, `w-${x.id.slice(0, 6)}`, 'work');
  await until(() => [second.id, third.id].every((id) => s.controller.get(id)!.state === 'working'));
  s.controller.slotWaitMs = 5000;
  s.controller.slotPollMs = 20;
  s.controller.controlTimeoutMs = 150;
}

test('T-425 S2b: a send refused before its write gives its turn back: the next send to the session is written', async () => {
  const s = await liveSession();
  try {
    await assert.rejects(s.controller.send(s.id, 'refused-1', ''), /Type a message/);
    const sends = s.ws.sends.length;
    assert.equal(await within(s.controller.send(s.id, 'after-1', 'LINE-AFTER-REFUSAL'), 1500), 'done', 'not stuck behind the refused send');
    assert.ok(s.ws.sends.slice(sends).some((x) => x.line.includes('LINE-AFTER-REFUSAL')));
  } finally {
    await s.done();
  }
});

test('T-425 S2b: the line of sends is per session: a send to one session is not held behind another session’s write in the same workspace', async () => {
  const s = await liveSession();
  try {
    const other = await idleSession(s);
    s.controller.execTimeoutMs = 800;
    s.ws.hangSends = true; // the first session's write takes the host's whole timeout
    const slow = s.controller.send(s.id, 'slow-1', 'SLOW-LINE').catch(() => undefined);
    await sleep(60);
    s.ws.hangSends = false;
    const sends = s.ws.sends.length;
    assert.equal(await within(s.controller.send(other.id, 'fast-1', 'FAST-LINE'), 400), 'done', 'the other session’s send is not held');
    assert.ok(s.ws.sends.slice(sends).some((x) => x.line.includes('FAST-LINE')));
    await slow;
  } finally {
    await s.done();
  }
});

test('T-425 S2b: a session’s place in line is dropped once its sends are written or refused (nothing left behind)', async () => {
  const s = await liveSession();
  try {
    assert.equal(s.controller.openWriteLines, 0);
    await s.controller.send(s.id, 'leak-1', 'one');
    await assert.rejects(s.controller.send(s.id, 'leak-2', ''), /Type a message/);
    await s.controller.send(s.id, 'leak-3', 'three');
    await until(() => s.controller.openWriteLines === 0);
  } finally {
    await s.done();
  }
});

test('T-425 S2b: a wake refused for a reason that is not an AppError (the launch fails) marks the stored send failed, and says so', async () => {
  const s = await liveSession();
  try {
    await asleepAtCap(s);
    await s.controller.send(s.id, 'launch-1', 'never delivered');
    assert.match(s.controller.get(s.id)!.slotWait ?? '', /^Waiting for a slot/);
    s.controller.liveCaps = () => {
      throw new Error('the launch failed'); // a plain Error, as a launch failure is
    };
    await until(() => s.inputs('launch-1').includes('failed'), 3000);
    assert.ok(s.controller.history(s.id).some((e) => e.kind === 'system' && /A message wasn’t delivered/.test(e.text ?? '')));
  } finally {
    await s.done();
  }
});

test('T-425 S2b + optimistic Working: a send that waited for a slot and then fails to write is marked failed, and the optimistic Working is undone', async () => {
  const s = await liveSession();
  try {
    await asleepAtCap(s);
    s.controller.execTimeoutMs = 400;
    await s.controller.send(s.id, 'late-fail-1', 'LATE-FAIL-LINE');
    assert.match(s.controller.get(s.id)!.slotWait ?? '', /^Waiting for a slot/);
    s.ws.hangSends = true; // the slot comes, the wake works, then the write to Claude Code never completes
    s.controller.liveCaps = () => ({ perWorkspace: 5, total: 10 });
    await until(() => s.inputs('late-fail-1').includes('failed'), 6000);
    s.ws.hangSends = false;
    assert.ok(s.controller.history(s.id).some((e) => e.kind === 'system' && /A message wasn’t delivered/.test(e.text ?? '')));
    await sleep(50);
    assert.notEqual(s.controller.get(s.id)!.state, 'working', 'nothing reached Claude Code: the session is not left Working');
    assert.ok(!s.ws.sends.some((x) => x.line.includes('LATE-FAIL-LINE')), 'the line was never delivered');
  } finally {
    await s.done();
  }
});

test('T-425 S2b: a later send is not written while an earlier send to the same session is still being written (the chain’s ordering)', async () => {
  const s = await liveSession();
  try {
    s.controller.execTimeoutMs = 900;
    s.ws.hangSends = true; // the first send's write is slow: it ends only at the host's timeout
    const open = s.ws.sendExecs.length;
    const first = s.controller.send(s.id, 'order-1', 'ORDER-FIRST').catch(() => undefined);
    await until(() => s.ws.sendExecs.length > open);
    s.ws.hangSends = false; // the second one's write would be instant
    const sends = s.ws.sends.length;
    const second = s.controller.send(s.id, 'order-2', 'ORDER-SECOND');
    await sleep(300);
    assert.equal(s.ws.sends.slice(sends).some((x) => x.line.includes('ORDER-SECOND')), false, 'held behind the first send, whose write is still open');
    await first;
    await second;
    assert.ok(s.ws.sends.slice(sends).some((x) => x.line.includes('ORDER-SECOND')), 'written once the first is done');
  } finally {
    await s.done();
  }
});

test('T-425 S2b: a send after one that waits for a slot does not hang behind it: it is stored and returns at once, and both are written in order when the slot comes', async () => {
  const s = await liveSession();
  try {
    await asleepAtCap(s);
    const sends = s.ws.sends.length;
    await s.controller.send(s.id, 'wait-a', 'FIRST-WAITER'); // detached: waits for its slot
    assert.equal(await within(s.controller.send(s.id, 'wait-b', 'SECOND-WAITER'), 1500), 'done', 'the later send is not held for the slot');
    assert.ok(s.controller.history(s.id).some((e) => e.kind === 'user' && e.text === 'SECOND-WAITER'), 'stored');
    assert.equal(s.ws.sends.length, sends, 'nothing reached Claude yet');
    s.controller.liveCaps = () => ({ perWorkspace: 5, total: 10 });
    await until(() => ['FIRST-WAITER', 'SECOND-WAITER'].every((t) => s.ws.sends.slice(sends).some((x) => x.line.includes(t))), 5000);
    const written = s.ws.sends.slice(sends).map((x) => x.line);
    assert.ok(written.findIndex((l) => l.includes('FIRST-WAITER')) < written.findIndex((l) => l.includes('SECOND-WAITER')), 'in the order sent');
  } finally {
    await s.done();
  }
});
