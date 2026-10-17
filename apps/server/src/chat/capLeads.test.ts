// T-417: the live cap (chat-sessions PRD FR39) never puts a lead to sleep. A lead waits for its workers most of the time, so the
// longest-idle choice picked leads (2026-10-15 02:23 and 02:28 UTC: one lead slept for another, lost Bypass and stopped routing while
// its workers kept working). Idle workers sleep first, then idle chats without workers; with none, the start waits for a slot and
// says so. A lead's sleep keeps its Bypass: the wake puts it back the way a Restart does, every gate checked again.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controls, init, line, liveSession, ok, sleep, until, USAGE_API_KEY, type Live } from './testkit.js';

const FLAG = '--allow-dangerously-skip-permissions';

/** A session started on the fake host and idle (so it may sleep); a worker of `parentId` when given; its reader is the newest tail. */
async function started(s: Live, o: { parentId?: string; bypassOptIn?: boolean } = {}) {
  const before = s.ws.tails.length;
  const opts = o.parentId ? { actor: `session:${o.parentId}`, parentId: o.parentId } : o.bypassOptIn ? { bypassOptIn: true } : {};
  const created = await s.controller.create({ workspaceId: 'docker/ws1' }, opts);
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(created.id)?.state === 'idle');
  await sleep(20);
  return { id: created.id, tail: s.ws.tails.at(-1)! };
}

const procs = (s: Live) => Object.fromEntries(s.controller.list().map((x) => [x.id, x.process]));
const slept = (s: Live) => s.controller.audit({ kind: 'cap.slept' }).map((a) => a.sessionId);
const pick = (s: Live, id: string) => {
  const x = s.controller.get(id)!;
  return { state: x.state, process: x.process, slotWait: x.slotWait ?? null, open: s.controller.openRequests(id).length };
};
const notes = (s: Live, id: string) => s.controller.history(id).flatMap((e) => (e.kind === 'system' && e.text ? [e.text] : []));

/** A turn of `id` ends on `tail`: its message is done, so it is idle with nothing open. */
function endTurn(id: string, tail: { push(x: string): void }, uuid: string) {
  for (const state of ['queued', 'started']) tail.push(line({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: `${uuid}-${state}`, session_id: id }));
  tail.push(line({ type: 'result', subtype: 'success', total_cost_usd: 0.01, is_error: false, session_id: id }));
  tail.push(line({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed', uuid: `${uuid}-done`, session_id: id }));
}

test('T-417: the cap full with an idle lead and an idle worker: the worker sleeps, never the lead (though the lead was idle longer)', async () => {
  const s = await liveSession();
  try {
    const worker = await started(s, { parentId: s.id }); // s is now a lead: it has a worker, and has been idle longer than it
    s.controller.liveCaps = () => ({ perWorkspace: 2, total: 10 });
    const third = await started(s);
    const p = procs(s);
    assert.equal(p[s.id], 'live', 'the lead stays awake');
    assert.equal(p[worker.id], 'asleep', 'the idle worker went to sleep');
    assert.equal(p[third.id], 'live');
    assert.deepEqual(slept(s), [worker.id]);
    assert.equal(s.controller.audit({ kind: 'cap.slept' })[0]!.detail.worker, true);
  } finally {
    await s.done();
  }
});

test('T-417: a lead without workers is kept too (a workers limit set, or Keep going on); an idle chat without workers sleeps instead', async () => {
  const s = await liveSession();
  try {
    s.controller.setLimits(s.id, { maxWorkers: 3 }, { actor: 'ui' }); // the oldest idle chat, a lead by its workers limit
    const kept = await started(s);
    s.controller.keepGoingOf = (id) => (id === kept.id ? ({ enabled: true, program: null } as never) : null);
    const plain = await started(s);
    s.controller.liveCaps = () => ({ perWorkspace: 3, total: 10 });
    const next = await started(s);
    const p = procs(s);
    assert.equal(p[s.id], 'live', 'a chat with a workers limit is a lead');
    assert.equal(p[kept.id], 'live', 'a chat Keep going holds is a lead');
    assert.equal(p[plain.id], 'asleep');
    assert.equal(p[next.id], 'live');
    assert.deepEqual(slept(s), [plain.id]);
  } finally {
    await s.done();
  }
});

test('T-417: the cap full with only working workers and idle leads: the start waits for a slot, says why, sleeps no lead, and runs once a worker is idle', async () => {
  const s = await liveSession();
  try {
    s.controller.slotPollMs = 20;
    const worker = await started(s, { parentId: s.id });
    s.controller.liveCaps = () => ({ perWorkspace: 2, total: 10 });
    await s.controller.send(worker.id, 'w-turn-1', 'work');
    await until(() => s.controller.get(worker.id)!.state === 'working');
    const starts = s.ws.starts;

    const queued = await s.controller.create({ workspaceId: 'docker/ws1' });
    assert.match(queued.slotWait ?? '', /^Waiting for a slot · 2 of 2 running in docker\/ws1/, 'the caller sees why it waits');
    assert.equal(queued.process, 'asleep', 'a waiting start does not count as running');
    await sleep(150);
    assert.equal(s.controller.get(s.id)!.process, 'live', 'the idle lead never sleeps for it');
    assert.equal(s.ws.starts, starts, 'nothing started while it waits');
    assert.deepEqual(slept(s), []);
    assert.ok(notes(s, queued.id).some((t) => t.startsWith('Waiting for a slot · 2 of 2 running in docker/ws1')), 'its transcript says it too');

    // The worker's turn ends: an idle worker may sleep, so the waiting start takes its slot.
    endTurn(worker.id, worker.tail, 'w-turn-1');
    worker.tail.push(ok((await s.take('get_usage')).id, USAGE_API_KEY)); // the usage check after a turn (§6 rule 3), answered as Claude Code does
    const seen = () => JSON.stringify({ worker: pick(s, worker.id), queued: pick(s, queued.id), lead: pick(s, s.id), inputs: s.inputs('w-turn-1') });
    await until(() => s.controller.get(worker.id)!.state === 'idle').catch(() => assert.fail(`the worker's turn did not end: ${seen()}`));
    await until(() => s.controller.get(queued.id)!.process === 'live' && s.controller.get(queued.id)!.state === 'idle').catch(() => assert.fail(`the waiting start did not run: ${seen()}`));
    assert.equal(s.controller.get(worker.id)!.process, 'asleep');
    assert.equal(s.controller.get(s.id)!.process, 'live');
    assert.deepEqual(slept(s), [worker.id]);
    assert.equal(s.controller.get(queued.id)!.slotWait ?? null, null, 'no longer waiting');
  } finally {
    await s.done();
  }
});

/** The policy and the server code check the test controls (bypass.test.ts). */
function policy(s: Live, allowed: boolean) {
  const state = { allowed };
  s.controller.bypassAllowed = () => state.allowed;
  s.controller.reauth = { fresh: (token) => token === 'tok' };
  return state;
}

/** A bypass-capable lead (a workers limit) in Bypass, entered by the person, then asleep (the idle sleep). */
async function leadInBypassAsleep(s: Live) {
  const lead = await started(s, { bypassOptIn: true });
  s.controller.setLimits(lead.id, { maxWorkers: 3 }, { actor: 'ui' });
  lead.tail.push(init(lead.id));
  const entering = s.controller.enterBypass(lead.id, { acknowledged: true, sessionToken: 'tok' });
  lead.tail.push(ok((await s.take('set_permission_mode')).id, { mode: 'bypassPermissions' }));
  await entering;
  assert.equal(s.controller.get(lead.id)!.mode, 'bypassPermissions');
  await until(() => s.controller.get(lead.id)!.process === 'asleep', 4000);
  assert.equal(s.controller.get(lead.id)!.mode, 'default', 'asleep, nothing runs in Bypass');
  assert.ok(notes(s, lead.id).includes('Bypass paused for sleep: it comes back at the wake if the policy still allows it.'));
  assert.deepEqual(s.controller.audit({ kind: 'bypass.left', sessionId: lead.id }).map((a) => [a.detail.why, a.detail.kept]), [['sleep', true]]);
  return lead;
}

const bypassAsks = (s: Live) => controls(s.ws).filter((c) => c.request.subtype === 'set_permission_mode' && c.request.mode === 'bypassPermissions');

test('T-417: a lead slept in Bypass wakes in Bypass, through the gated path a Restart uses, on the record', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    s.controller.controlTimeoutMs = 150;
    policy(s, true);
    const lead = await leadInBypassAsleep(s);
    const asked = bypassAsks(s).length;
    const tails = s.ws.tails.length;

    const waking = s.controller.send(lead.id, 'lead-wake-1', 'go on');
    await until(() => s.ws.tails.length > tails && bypassAsks(s).length > asked, 4000);
    assert.ok(s.ws.startArgs.at(-1)!.includes(FLAG), 'woken with the flag: capable, and the policy allows it');
    s.ws.tails.at(-1)!.push(ok(bypassAsks(s).at(-1)!.id, { mode: 'bypassPermissions' }));
    await waking;

    assert.equal(s.controller.get(lead.id)!.mode, 'bypassPermissions', 'back in Bypass after the wake');
    assert.ok(notes(s, lead.id).includes('Bypass kept after the wake.'));
    const entered = s.controller.audit({ kind: 'bypass.entered', sessionId: lead.id });
    assert.deepEqual([entered[0]!.severity, entered[0]!.actor, entered[0]!.detail.how], ['high', 'portal', 'wake']);
  } finally {
    await s.done();
  }
});

test('T-425 S2: two sends to one session are written in call order, though the first one’s wake (the Bypass put back) takes longer', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    s.controller.controlTimeoutMs = 150; // as the other lead tests: the sleep's own control request goes unanswered
    policy(s, true);
    const lead = await leadInBypassAsleep(s);
    s.controller.controlTimeoutMs = 3000; // then the wake's Bypass request waits for the test's answer
    const asked = bypassAsks(s).length;
    const tails = s.ws.tails.length;
    const sends = s.ws.sends.length;

    const first = s.controller.send(lead.id, 'order-1', 'FIRST-LINE');
    await until(() => s.ws.tails.length > tails && bypassAsks(s).length > asked, 4000); // the first is in its Bypass step: the process is live
    const second = s.controller.send(lead.id, 'order-2', 'SECOND-LINE'); // finds the session live and would write at once
    await sleep(100);
    assert.ok(!s.ws.sends.slice(sends).some((x) => /FIRST-LINE|SECOND-LINE/.test(x.line)), 'no message is written before the first one’s turn (the control request is)');
    s.ws.tails.at(-1)!.push(ok(bypassAsks(s).at(-1)!.id, { mode: 'bypassPermissions' }));
    await Promise.all([first, second]);
    const written = s.ws.sends.slice(sends).map((x) => x.line);
    const at = (needle: string) => written.findIndex((l) => l.includes(needle));
    assert.ok(at('FIRST-LINE') >= 0 && at('SECOND-LINE') >= 0, JSON.stringify(written.map((l) => l.slice(0, 80))));
    assert.ok(at('FIRST-LINE') < at('SECOND-LINE'), 'written in the order sent');
  } finally {
    await s.done();
  }
});

test('T-417: a lead slept in Bypass whose Bypass policy was turned off meanwhile wakes on the start mode, and says why', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    s.controller.controlTimeoutMs = 150;
    const state = policy(s, true);
    const lead = await leadInBypassAsleep(s);
    const asked = bypassAsks(s).length;
    state.allowed = false;
    await s.controller.bypassPolicyChanged();

    await s.controller.send(lead.id, 'lead-wake-2', 'go on');
    assert.equal(s.controller.get(lead.id)!.process, 'live');
    assert.equal(s.controller.get(lead.id)!.mode, 'default', 'not in Bypass');
    assert.ok(!s.ws.startArgs.at(-1)!.includes(FLAG), 'not even launched with the flag');
    assert.equal(bypassAsks(s).length, asked, 'Claude Code was never asked to enter Bypass');
    assert.ok(notes(s, lead.id).includes('Bypass not kept after the wake: the policy no longer allows it.'));
    const left = s.controller.audit({ kind: 'bypass.left', sessionId: lead.id })[0]!;
    assert.deepEqual([left.detail.why, left.detail.how], ['policy', 'wake']);
  } finally {
    await s.done();
  }
});
