// T-417 review: the live cap's queue (chat-sessions PRD FR39) and a queued worker's spawn. Each test fails without its fix:
// 1. a slot given counts as running until its launch settles (a second waiter can't take the same room);
// 2. a worker gets no other message before its spawn delivery (its narrowing mode, then its parent's first instruction);
// 3. a queued spawn whose start fails ends the worker at once and tells the lead; settings not confirmed are told too;
// 5. a newcomer queues behind the starts already waiting (first come, first served);
// 7. a lead's Bypass comes back at the wake only when it is still a lead;
// 9. slotWait is cleared when the slot comes at the first look.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { parseMemoryProbe } from '../workspaces/memory.js';
import { CREW_REPORT_ACTOR } from './controller.js';
import { MEMORY_HEADROOM_BYTES, SESSION_MEMORY_ESTIMATE_BYTES, WorkspaceMemory } from './memory.js';
import { registerChatTools } from './portalTools.js';
import { controls, init, line, liveSession, ok, sleep, until, USAGE_API_KEY, type Live } from './testkit.js';

/** A session started on the fake host and idle; a worker of `parentId` when given; its reader is the newest tail. */
async function started(s: Live, o: { parentId?: string; bypassOptIn?: boolean } = {}) {
  const before = s.ws.tails.length;
  const opts = o.parentId ? { actor: `session:${o.parentId}`, parentId: o.parentId } : o.bypassOptIn ? { bypassOptIn: true } : {};
  const created = await s.controller.create({ workspaceId: 'docker/ws1' }, opts);
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(created.id)?.state === 'idle');
  await sleep(20);
  return { id: created.id, tail: s.ws.tails.at(-1)! };
}

/** A turn of `id` ends on `tail`, and the usage check after it is answered (as in capLeads.test.ts). */
async function endTurn(s: Live, id: string, tail: { push(x: string): void }, uuid: string) {
  for (const state of ['queued', 'started']) tail.push(line({ type: 'command_lifecycle', command_uuid: uuid, state, uuid: `${uuid}-${state}`, session_id: id }));
  tail.push(line({ type: 'result', subtype: 'success', total_cost_usd: 0.01, is_error: false, session_id: id }));
  tail.push(line({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed', uuid: `${uuid}-done`, session_id: id }));
  tail.push(ok((await s.take('get_usage')).id, USAGE_API_KEY));
  await until(() => s.controller.get(id)!.state === 'idle');
}

/** The lead `s` with one worker in a turn, at a cap of 2 per workspace: full, and nothing may sleep. */
async function fullWithWorkingWorker(s: Live, pollMs = 20) {
  s.controller.slotPollMs = pollMs;
  const worker = await started(s, { parentId: s.id });
  s.controller.liveCaps = () => ({ perWorkspace: 2, total: 10 });
  await s.controller.send(worker.id, 'w-turn-1', 'work');
  await until(() => s.controller.get(worker.id)!.state === 'working');
  return worker;
}

const liveCount = (s: Live) => s.controller.list().filter((x) => x.process === 'live').length;
const notes = (s: Live, id: string) => s.controller.history(id).flatMap((e) => (e.kind === 'system' && e.text ? [e.text] : []));
const waitNotes = (s: Live, id: string) => notes(s, id).filter((t) => t.startsWith('Waiting for a slot')).length;

test('T-417 review 1: two starts wait; the first gets the slot and, while it launches, the second does not take the same room', async () => {
  const s = await liveSession();
  try {
    const worker = await fullWithWorkingWorker(s);
    const q1 = await s.controller.create({ workspaceId: 'docker/ws1' });
    const q2 = await s.controller.create({ workspaceId: 'docker/ws1' });
    assert.ok(q1.slotWait && q2.slotWait, 'both wait');
    const starts = s.ws.starts;
    let open!: () => void;
    s.ws.startGate = new Promise<void>((r) => (open = r)); // a launch takes a while

    await endTurn(s, worker.id, worker.tail, 'w-turn-1'); // the worker may sleep now: one slot frees
    await until(() => s.ws.starts === starts + 1, 4000);
    await sleep(300); // the second waiter looks again ~15 times meanwhile
    assert.equal(s.ws.starts, starts + 1, 'only the first waiter launched');
    assert.equal(s.controller.get(q2.id)!.process, 'asleep', 'the second still waits');
    assert.ok(s.controller.get(q2.id)!.slotWait);

    // Once the first runs (idle, so it may sleep for the second), never more than the cap at once.
    let most = liveCount(s);
    open();
    s.ws.startGate = null;
    for (let i = 0; i < 40; i++) {
      most = Math.max(most, liveCount(s));
      await sleep(10);
    }
    assert.ok(most <= 2, `at most the cap runs at once (${most})`);
  } finally {
    await s.done();
  }
});

test('T-417 review 5: a new session queues behind a start already waiting, though a slot is free when it comes', async () => {
  const s = await liveSession();
  try {
    const worker = await fullWithWorkingWorker(s, 2000); // the waiter looks again only every 2 s
    const q1 = await s.controller.create({ workspaceId: 'docker/ws1' });
    assert.ok(q1.slotWait);
    await sleep(300); // q1 has had its first look and waits for the next (in about 1.7 s)
    await endTurn(s, worker.id, worker.tail, 'w-turn-1'); // a slot may be made now
    const q2 = await s.controller.create({ workspaceId: 'docker/ws1' });
    assert.ok(q2.slotWait, 'the newcomer waits behind q1');
    assert.equal(q2.process, 'asleep');
    await until(() => s.controller.get(q1.id)!.process === 'live', 5000);
    assert.equal(s.controller.get(q2.id)!.process, 'asleep', 'q1 got the slot first');
  } finally {
    await s.done();
  }
});

test('T-417 review 9: a queued start whose slot comes at its first look no longer shows that it waits', async () => {
  const s = await liveSession();
  try {
    s.controller.setLimits(s.id, { maxWorkers: 3 }, { actor: 'ui' }); // a lead: it never sleeps for the cap
    let looks = 0;
    s.controller.liveCaps = () => (looks++ === 0 ? { perWorkspace: 1, total: 10 } : { perWorkspace: 10, total: 10 }); // the cap is raised meanwhile
    const q = await s.controller.create({ workspaceId: 'docker/ws1' });
    assert.ok(q.slotWait, 'it waited at first');
    await until(() => s.controller.get(q.id)!.process === 'live', 4000);
    await sleep(50);
    assert.equal(s.controller.get(q.id)!.slotWait ?? null, null, 'it runs, so it no longer says it waits');
  } finally {
    await s.done();
  }
});

/** The MCP side: the lead `s` (a workers limit) alone at a cap of 1 per workspace, so a spawn waits for a slot. */
async function mcpRig() {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const s = await liveSession();
  s.controller.agentCaps = () => ({ maxDepth: 1, maxChildren: 3, spawnsPerHour: 10, messagesPerHour: 10 });
  registerChatTools(s.controller, registry);
  h.alive.add(s.id);
  s.controller.setLimits(s.id, { maxWorkers: 3 }, { actor: 'ui' });
  s.controller.slotPollMs = 20;
  const caps = { perWorkspace: 1, total: 10 };
  s.controller.liveCaps = () => caps;
  const a = await h.agentToken('docker/ws1', s.id);
  return { h, s, a, caps, done: async () => (h.done(), s.done()) };
}

const spawnReports = (s: Live) => s.controller.history(s.id).flatMap((e) => (e.kind === 'user' && e.actor === CREW_REPORT_ACTOR ? [e.text ?? ''] : []));

test('T-417 review 2: a queued worker gets its mode, then its first instruction, before a message its parent sent while it waited', async () => {
  const r = await mcpRig();
  try {
    const spawned = await r.h.call(r.a.secret, 'session_spawn', { prompt: 'Check the parser.', title: 'Parser', mode: 'dontAsk' });
    assert.equal(spawned.result?.isError, undefined, JSON.stringify(spawned.raw));
    const out = spawned.result!.structuredContent.session as { id: string; slot_wait: string | null };
    assert.match(out.slot_wait ?? '', /^Waiting for a slot/);
    const id = out.id;
    // The parent writes to it while it waits: that message must not reach it first.
    const note = r.h.call(r.a.secret, 'session_message', { session_id: id, text: 'Also look at the lexer.' });
    await sleep(50);
    const tails = r.s.ws.tails.length;
    r.caps.perWorkspace = 2; // a slot frees
    await until(() => r.s.ws.tails.length === tails + 1, 4000);
    const req = await r.s.take('set_permission_mode');
    assert.equal(req.request.mode, 'dontAsk');
    await sleep(100); // what would slip in before the mode applies, has time to
    r.s.ws.tails.at(-1)!.push(ok(req.id, { mode: 'dontAsk' }));
    assert.equal((await note).result?.isError, undefined);
    await until(() => r.s.controller.history(id).filter((e) => e.kind === 'user').length === 2);
    assert.deepEqual(
      r.s.controller.history(id).flatMap((e) => (e.kind === 'user' ? [e.text] : [])),
      ['Check the parser.', 'Also look at the lexer.'],
      'the first instruction first',
    );
    const csid = r.s.controller.get(id)!.claudeSessionId;
    const sent = r.s.ws.sends.filter((x) => x.args[1] === csid).map((x) => x.line);
    const at = (needle: string) => sent.findIndex((l) => l.includes(needle));
    assert.ok(at('set_permission_mode') >= 0 && at('set_permission_mode') < at('Check the parser.') && at('Check the parser.') < at('Also look at the lexer.'), 'mode, then the instruction, then the message');
  } finally {
    await r.done();
  }
});

test('T-417 review 3: a queued worker whose start fails is ended at once, waits only once, and its lead is told why', async () => {
  const r = await mcpRig();
  try {
    r.s.controller.slotWaitMs = 200;
    const starts = r.s.ws.starts;
    const spawned = await r.h.call(r.a.secret, 'session_spawn', { prompt: 'Check the parser.', title: 'Parser', model: 'sonnet', effort: 'high' });
    const id = (spawned.result!.structuredContent.session as { id: string }).id;
    await until(() => r.s.controller.get(id)!.state === 'ended', 4000);
    await until(() => spawnReports(r.s).length > 0, 4000);
    assert.match(spawnReports(r.s).join('\n'), new RegExp(`Worker ${id} could not start .*so it was ended before it got any instruction\\.`));
    await sleep(500); // longer than two more waits would take
    assert.equal(waitNotes(r.s, id), 1, 'it waited once: nothing relaunched it to wait again');
    assert.equal(r.s.ws.starts, starts, 'it never started');
    assert.equal(r.s.controller.history(id).some((e) => e.kind === 'user'), false, 'no instruction went in');
  } finally {
    await r.done();
  }
});

test('T-416 review 6310 #2: a queued worker refused for memory when its slot comes is ended, and its lead is told it could not start, with the reason', async () => {
  const r = await mcpRig();
  try {
    // Room for one more at the spawn; when the slot comes the workspace is past the line (a newer reading).
    const limit = 8 * 1024 ** 3;
    const fits = limit - MEMORY_HEADROOM_BYTES - SESSION_MEMORY_ESTIMATE_BYTES;
    const st = { used: fits, clock: 1_000_000 };
    r.s.controller.memory = new WorkspaceMemory({ read: async () => parseMemoryProbe(`max ${limit}\nanon ${st.used}\nactive_file 0\n`, st.clock), now: () => st.clock });
    const starts = r.s.ws.starts;
    const spawned = await r.h.call(r.a.secret, 'session_spawn', { prompt: 'Check the parser.', title: 'Parser' });
    assert.equal(spawned.result?.isError, undefined, JSON.stringify(spawned.raw));
    const out = spawned.result!.structuredContent.session as { id: string; slot_wait: string | null };
    assert.match(out.slot_wait ?? '', /^Waiting for a slot/);
    st.used = fits + 1;
    st.clock += 60_000;
    r.caps.perWorkspace = 2; // the slot comes
    await until(() => r.s.controller.get(out.id)!.state === 'ended', 4000);
    await until(() => spawnReports(r.s).length > 0, 4000);
    assert.match(spawnReports(r.s).join('\n'), new RegExp(`Worker ${out.id} could not start \\(Not enough memory in docker/ws1: .*\\), so it was ended before it got any instruction\\.`));
    assert.equal(r.s.ws.starts, starts, 'it never started');
    assert.equal(r.s.controller.history(out.id).some((e) => e.kind === 'user'), false, 'no instruction went in');
    assert.deepEqual(
      r.s.controller.audit({ kind: 'memory.refused' }).map((a) => a.detail.at),
      ['queued'],
    );
  } finally {
    await r.done();
  }
});

test('T-417 review 3: settings a queued worker could not confirm reach its lead in a message', async () => {
  const r = await mcpRig();
  try {
    r.s.controller.controlTimeoutMs = 150;
    const spawned = await r.h.call(r.a.secret, 'session_spawn', { prompt: 'Check the parser.', title: 'Parser', model: 'sonnet' });
    const id = (spawned.result!.structuredContent.session as { id: string }).id;
    r.caps.perWorkspace = 2;
    await until(() => r.s.controller.history(id).some((e) => e.kind === 'user' && e.text === 'Check the parser.'), 4000);
    await until(() => spawnReports(r.s).length > 0, 4000);
    assert.match(spawnReports(r.s).join('\n'), new RegExp(`Worker ${id} started with your instruction\\. Not confirmed: mode dontAsk: .*model sonnet: `));
  } finally {
    await r.done();
  }
});

/** The policy and the server code check the test controls (bypass.test.ts). */
function policy(s: Live, allowed: boolean) {
  s.controller.bypassAllowed = () => allowed;
  s.controller.reauth = { fresh: (token) => token === 'tok' };
}

const bypassAsks = (s: Live) => controls(s.ws).filter((c) => c.request.subtype === 'set_permission_mode' && c.request.mode === 'bypassPermissions');

test('T-417 review 7: a lead slept in Bypass that is no longer a lead at its wake does not get Bypass back, and says why', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    s.controller.controlTimeoutMs = 150;
    policy(s, true);
    const lead = await started(s, { bypassOptIn: true });
    s.controller.setLimits(lead.id, { maxWorkers: 3 }, { actor: 'ui' });
    lead.tail.push(init(lead.id));
    const entering = s.controller.enterBypass(lead.id, { acknowledged: true, sessionToken: 'tok' });
    lead.tail.push(ok((await s.take('set_permission_mode')).id, { mode: 'bypassPermissions' }));
    await entering;
    await until(() => s.controller.get(lead.id)!.process === 'asleep', 4000);
    assert.ok(notes(s, lead.id).includes('Bypass paused for sleep: it comes back at the wake if the policy still allows it.'));
    s.controller.setLimits(lead.id, { maxWorkers: null }, { actor: 'ui' }); // no longer a lead
    const asked = bypassAsks(s).length;

    await s.controller.send(lead.id, 'lead-wake-3', 'go on');
    assert.equal(s.controller.get(lead.id)!.process, 'live');
    assert.equal(s.controller.get(lead.id)!.mode, 'default', 'not in Bypass');
    assert.equal(bypassAsks(s).length, asked, 'Claude Code was never asked to enter Bypass');
    assert.ok(notes(s, lead.id).some((t) => t.startsWith('Bypass not kept after the wake: this chat is no longer a lead')), JSON.stringify(notes(s, lead.id)));
    const left = s.controller.audit({ kind: 'bypass.left', sessionId: lead.id })[0]!;
    assert.deepEqual([left.detail.why, left.detail.how], ['not_lead', 'wake']);
  } finally {
    await s.done();
  }
});
