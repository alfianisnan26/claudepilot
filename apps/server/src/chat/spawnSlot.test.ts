// T-3215 (PILOT-1112): workers spawned at a full live cap sat at starting/asleep (turns 0, mode default) for up to 15 minutes, and a resume,
// a mode or a message to them got no answer meanwhile (each waited behind the slot wait). Each test fails without the fix:
// 1. a worker's queued start ends, with the cap's reason, in `agentSlotWaitMs` (a person's start keeps `slotWaitMs`), and its lead is told;
// 2. a resume or a mode on a session that waits for a slot answers at once, saying so; the queued start still runs, mode first;
// 3. an agent's message to an asleep worker at a full cap answers with the cap's reason in `agentSlotWaitMs`, not after 15 minutes.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { CREW_REPORT_ACTOR } from './controller.js';
import { registerChatTools } from './portalTools.js';
import { ChatStore } from './store.js';
import { liveSession, ok, sleep, until, type Live } from './testkit.js';

/** The lead `s` (a workers limit, so it never sleeps for the cap) alone at a cap of 1 per workspace: a spawn waits for a slot. */
async function rig() {
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

/** `p` settled within `ms`: its outcome; else 'pending' (it hung). */
async function within<T>(p: Promise<T>, ms: number): Promise<{ ok: T } | { err: unknown } | 'pending'> {
  return Promise.race([p.then((v) => ({ ok: v }), (e: unknown) => ({ err: e })), sleep(ms).then(() => 'pending' as const)]);
}

test('T-3215: a worker queued at a full cap is ended with the cap’s reason within the agent wait (not 15 min), and its lead is told', async () => {
  const r = await rig();
  try {
    assert.equal(r.s.controller.slotWaitMs, 15 * 60_000, 'a person’s start still waits the long wait');
    r.s.controller.agentSlotWaitMs = 300;
    const starts = r.s.ws.starts;
    const spawned = await r.h.call(r.a.secret, 'session_spawn', { prompt: 'Check the parser.', title: 'Parser' });
    assert.equal(spawned.result?.isError, undefined, JSON.stringify(spawned.raw));
    const out = spawned.result!.structuredContent.session as { id: string; slot_wait: string | null };
    assert.match(out.slot_wait ?? '', /^Waiting for a slot · 1 of 1 running in docker\/ws1/);
    assert.match(spawned.result!.content![0]!.text, /if no slot frees within 1 s it is ended and you are told why/);
    await until(() => r.s.controller.get(out.id)!.state === 'ended', 4000);
    await until(() => spawnReports(r.s).length > 0, 4000);
    assert.match(
      spawnReports(r.s).join('\n'),
      new RegExp(`Worker ${out.id} could not start \\(1 session is already running in docker/ws1, which is the limit \\(Settings › Running agents\\)\\. .*\\), so it was ended before it got any instruction\\.`),
    );
    assert.equal(r.s.ws.starts, starts, 'it never started');
  } finally {
    await r.done();
  }
});

test('T-3215: resume and mode on a worker waiting for a slot answer at once, saying so; the queued start then runs with its mode first', async () => {
  const r = await rig();
  try {
    const spawned = await r.h.call(r.a.secret, 'session_spawn', { prompt: 'Check the parser.', title: 'Parser', mode: 'dontAsk' });
    const id = (spawned.result!.structuredContent.session as { id: string }).id;
    assert.equal(r.s.controller.get(id)!.process, 'asleep');
    for (const [op, args] of [
      ['resume', undefined],
      ['mode', { mode: 'dontAsk' }],
    ] as const) {
      const got = await within(r.s.controller.control(id, op, args, { actor: `session:${r.s.id}` }), 1000);
      assert.notEqual(got, 'pending', `${op} answered (before: it waited behind the slot wait, no answer)`);
      assert.ok(got !== 'pending' && 'err' in got, `${op} is refused while it waits`);
      const e = (got as { err: { code?: string; message?: string } }).err;
      assert.equal(e.code, 'CONFLICT');
      assert.match(e.message ?? '', /^Waiting for a slot · 1 of 1 running in docker\/ws1 .*\. It starts by itself when a slot frees, or is ended with the reason after 60 s/);
    }
    // The slot frees: the queued start runs, its mode first, then the first instruction.
    const tails = r.s.ws.tails.length;
    r.caps.perWorkspace = 2;
    await until(() => r.s.ws.tails.length === tails + 1, 4000);
    const req = await r.s.take('set_permission_mode');
    assert.equal(req.request.mode, 'dontAsk');
    r.s.ws.tails.at(-1)!.push(ok(req.id, { mode: 'dontAsk' }));
    await until(() => r.s.controller.history(id).some((e) => e.kind === 'user' && e.text === 'Check the parser.'), 4000);
    assert.equal(r.s.controller.get(id)!.mode, 'dontAsk');
  } finally {
    await r.done();
  }
});

test('T-3215: an agent’s message to an asleep worker at a full cap answers with the cap’s reason within the agent wait', async () => {
  const r = await rig();
  try {
    r.caps.perWorkspace = 2;
    const before = r.s.ws.tails.length;
    const w = await r.s.controller.create({ workspaceId: 'docker/ws1' }, { actor: `session:${r.s.id}`, parentId: r.s.id });
    await until(() => r.s.ws.tails.length === before + 1);
    await until(() => r.s.controller.get(w.id)?.state === 'idle');
    // It was put to sleep for room; the cap is full again and nothing may sleep (the lead is kept).
    new ChatStore(r.s.store).patchSession(w.id, { process: 'asleep' });
    r.caps.perWorkspace = 1;
    r.s.controller.agentSlotWaitMs = 300;
    const got = await within(r.s.controller.messageFamily(r.s.id, w.id, 'Go on.'), 3000);
    assert.notEqual(got, 'pending', 'the lead gets an answer (before: it waited the 15-minute wait, and its tool call timed out)');
    assert.ok(got !== 'pending' && 'err' in got);
    assert.match((got as { err: Error }).err.message, /1 session is already running in docker\/ws1, which is the limit \(Settings › Running agents\)/);
    assert.equal(r.s.controller.get(w.id)!.state, 'idle', 'the worker stays as it was');
    // A person's message still waits the long wait (it is not cut to the agent's).
    const person = r.s.controller.send(w.id, randomUUID(), 'Go on.').catch((e: unknown) => e);
    assert.equal(await within(person, 600), 'pending', 'a person’s message waits for a slot');
    await r.s.controller.end(w.id);
    await person; // the wait ends with the session
  } finally {
    await r.done();
  }
});
