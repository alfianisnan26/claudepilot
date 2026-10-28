// PILOT-996 / PILOT-997 (D-103): autonomy modes. A worker takes the mode asked, else its parent's (a Manual parent hands on dontAsk), else
// Auto, never wider than its parent; a worker of a lead in Bypass keeps Bypass through the gated inherit path (the policy, the parent in
// Bypass now) and falls back to dontAsk when a gate says no; a session no person started starts in Auto while "Auto for agents" is on.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoModeAllowed, modeWithin, workerMode, type ChatPermissionMode } from '@portal/contracts';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { AUTO_REFUSED } from './controller.js';
import { registerChatTools } from './portalTools.js';
import { APPLIED, controls, init, liveSession, ok, sleep, until, USAGE_API_KEY, type Live } from './testkit.js';

test('workerMode, modeWithin and autoModeAllowed: inherit, cap, default Auto', () => {
  assert.equal(workerMode(undefined, 'bypassPermissions'), 'bypassPermissions', 'a Bypass lead hands on Bypass');
  assert.equal(workerMode(undefined, 'auto'), 'auto', 'an Auto lead hands on Auto');
  assert.equal(workerMode(undefined, 'acceptEdits'), 'acceptEdits');
  assert.equal(workerMode(undefined, null), 'auto', 'no parent mode: Auto');
  assert.equal(workerMode(undefined, 'default'), 'dontAsk', 'a Manual parent hands on dontAsk: never waits on a person');
  assert.equal(workerMode('plan', 'auto'), 'plan', 'the mode asked wins');
  const order: ChatPermissionMode[] = ['plan', 'dontAsk', 'default', 'acceptEdits', 'auto', 'bypassPermissions'];
  for (const [i, m] of order.entries()) for (const [j, cap] of order.entries()) assert.equal(modeWithin(m, cap), i <= j, `${m} within ${cap}`);

  const worker = { startedBy: 'session:p', origin: 'mcp' as const, parentId: 'p' };
  const trigger = { startedBy: 'portal:trigger-1', origin: 'ui' as const, parentId: null };
  assert.equal(autoModeAllowed({ startedBy: 'ui', origin: 'ui', parentId: null }), true, 'a person’s own session');
  assert.equal(autoModeAllowed(worker, { parentMode: 'auto' }), true);
  assert.equal(autoModeAllowed(worker, { parentMode: 'bypassPermissions' }), true);
  assert.equal(autoModeAllowed(worker, { parentMode: 'default' }), false);
  assert.equal(autoModeAllowed(worker, { parentMode: 'default', autonomousAuto: true }), true, 'the policy on');
  assert.equal(autoModeAllowed(trigger), false);
  assert.equal(autoModeAllowed(trigger, { autonomousAuto: true }), true);
});

/** Answers every mode switch (with the mode asked), settings read and usage read, in the order they reach the process, until `p` settles. */
async function answering<T>(s: Live, p: Promise<T>): Promise<T> {
  let done = s.ws.sends.length;
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) {
    for (; done < s.ws.sends.length; done++) {
      const sent = s.ws.sends[done]!;
      const c = controls({ sends: [sent] } as unknown as Live['ws'])[0];
      if (!c) continue;
      // The lead and its workers each have a process: the answer goes to the one that asked (`send <claude session>`, `tail <claude session>`),
      // since a process answered for a request it never made is ended for integrity.
      let at = -1;
      for (let i = s.ws.tailArgs.length - 1; i >= 0 && at < 0; i--) if (s.ws.tailArgs[i]![1] === sent.args[1]) at = i;
      const tail = s.ws.tails[at];
      if (!tail) break; // its process is not tailed yet: try again on the next round
      if (c.request.subtype === 'set_permission_mode') tail.push(ok(c.id, { mode: String(c.request.mode) }));
      else if (c.request.subtype === 'get_settings') tail.push(ok(c.id, APPLIED));
      else if (c.request.subtype === 'get_usage') tail.push(ok(c.id, USAGE_API_KEY));
    }
    await sleep(5);
  }
  return p;
}

async function rig() {
  const registry = new ToolRegistry();
  const h = await portalMcpHarness({ registry });
  const s = await liveSession();
  s.controller.agentCaps = () => ({ maxDepth: 1, maxChildren: 5, spawnsPerHour: 20, messagesPerHour: 20 });
  registerChatTools(s.controller, registry);
  h.alive.add(s.id);
  return { h, s, done: async () => (h.done(), s.done()) };
}

type Spawned = { id: string; applied: string[]; unconfirmed: string[] };
const spawned = (raw: { result?: { structuredContent?: Record<string, unknown> } }) => raw.result!.structuredContent!.session as Spawned;

test('PILOT-997: a worker of a Manual lead gets dontAsk; of an Auto lead, Auto; a mode wider than its lead is refused with the reason', async () => {
  const r = await rig();
  try {
    const a = await r.h.agentToken('docker/ws1', r.s.id);
    assert.equal(r.s.controller.get(r.s.id)!.mode, 'default');
    const manual = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Read the router.', title: 'Manual lead worker' })));
    assert.deepEqual(manual.applied, ['mode dontAsk']);
    assert.equal(r.s.controller.get(manual.id)!.mode, 'dontAsk');

    const count = r.s.controller.children(r.s.id).length;
    for (const wide of ['acceptEdits', 'auto'] as const) {
      const refused = await r.h.call(a.secret, 'session_spawn', { prompt: 'x', mode: wide });
      assert.equal(refused.result?.isError, true, wide);
      assert.match(JSON.stringify(refused.result!.structuredContent), new RegExp(`never wider than its parent: you run in default, so ${wide} is refused`));
    }
    assert.equal((await r.h.call(a.secret, 'session_spawn', { prompt: 'x', mode: 'bypassPermissions' })).result?.isError, true, 'Bypass is never asked');
    assert.equal(r.s.controller.children(r.s.id).length, count, 'nothing started');

    // The lead goes to Auto (a person's own session): its next worker gets Auto, allowed by its parent's mode.
    await answering(r.s, r.s.controller.control(r.s.id, 'mode', { mode: 'auto' }, { actor: 'ui' }));
    assert.equal(r.s.controller.get(r.s.id)!.mode, 'auto');
    const auto = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Split the router.', title: 'Auto lead worker' })));
    assert.deepEqual([auto.applied, auto.unconfirmed], [['mode auto'], []]);
    assert.equal(r.s.controller.get(auto.id)!.mode, 'auto');
    assert.equal(r.s.controller.get(auto.id)!.bypassCapable, false);
    const audit = r.s.controller.audit({ kind: 'mode.auto' }).find((x) => x.sessionId === auto.id);
    assert.ok(audit, 'mode.auto is audited for the worker');
    // Narrower than its lead is fine.
    const edit = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Edit only.', title: 'Edit worker', mode: 'acceptEdits' })));
    assert.equal(r.s.controller.get(edit.id)!.mode, 'acceptEdits');
  } finally {
    await r.done();
  }
});

test('PILOT-997: with its parent in Manual and “Auto for agents” off, a worker asked into Auto is refused with why and what to do', async () => {
  const r = await rig();
  try {
    const child = await r.s.controller.create({ workspaceId: 'docker/ws1', title: 'W' }, { actor: `session:${r.s.id}`, parentId: r.s.id });
    await until(() => r.s.controller.get(child.id)?.state === 'idle');
    await assert.rejects(r.s.controller.control(child.id, 'mode', { mode: 'auto' }, { actor: 'portal-mcp:tok1' }), (e: Error) => e.message === AUTO_REFUSED.parent);
    assert.deepEqual(
      r.s.controller.audit({ kind: 'mode.refused' }).map((x) => x.detail.why),
      ['parent'],
    );
    // The policy on: allowed.
    r.s.controller.autonomousAuto = () => true;
    await answering(r.s, r.s.controller.control(child.id, 'mode', { mode: 'auto' }, { actor: 'portal-mcp:tok1' }));
    assert.equal(r.s.controller.get(child.id)!.mode, 'auto');
  } finally {
    await r.done();
  }
});

/** A bypass-capable lead a person started and put in Bypass (the policy on, the server code fresh). */
async function bypassLead(s: Live) {
  s.controller.bypassAllowed = () => true;
  s.controller.reauth = { fresh: (token) => token === 'tok' };
  const before = s.ws.tails.length;
  const created = await s.controller.create({ workspaceId: 'docker/ws1', title: 'Lead' }, { bypassOptIn: true });
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(created.id)?.state === 'idle');
  await sleep(20);
  s.ws.tails.at(-1)!.push(init(created.id));
  await answering(s, s.controller.enterBypass(created.id, { acknowledged: true, sessionToken: 'tok' }));
  assert.equal(s.controller.get(created.id)!.mode, 'bypassPermissions');
  return created.id;
}

test('PILOT-997: a worker of a lead in Bypass keeps Bypass through the gated inherit path, audited; with the policy off it gets dontAsk', async () => {
  const r = await rig();
  try {
    const lead = await bypassLead(r.s);
    r.h.alive.add(lead);
    const a = await r.h.agentToken('docker/ws1', lead);
    const w = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Ship the fix.', title: 'Bypass worker' })));
    assert.deepEqual([w.applied, w.unconfirmed], [['mode bypassPermissions'], []]);
    const worker = r.s.controller.get(w.id)!;
    assert.deepEqual([worker.mode, worker.bypassCapable, worker.parentId], ['bypassPermissions', true, lead]);
    const capable = r.s.controller.audit({ kind: 'bypass.capable' }).find((x) => x.sessionId === w.id)!;
    assert.deepEqual(capable.detail, { how: 'inherit', parent: lead });
    const entered = r.s.controller.audit({ kind: 'bypass.entered' }).find((x) => x.sessionId === w.id)!;
    assert.equal(entered.detail.how, 'inherit');
    // Asking a narrower mode by name is still fine from a Bypass lead.
    const auto = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Review.', title: 'Auto worker', mode: 'auto' })));
    assert.equal(r.s.controller.get(auto.id)!.mode, 'auto');
    assert.equal(r.s.controller.get(auto.id)!.bypassCapable, false, 'capability only when Bypass is handed on');

    // The policy turned off: the worker is not made capable and falls back to dontAsk (never waits on a person).
    r.s.controller.bypassAllowed = () => false;
    const off = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Ship more.', title: 'Policy off worker' })));
    assert.deepEqual(off.applied, ['mode dontAsk']);
    assert.match(off.unconfirmed.join(' '), /mode bypassPermissions: not kept, dontAsk instead/);
    assert.deepEqual([r.s.controller.get(off.id)!.mode, r.s.controller.get(off.id)!.bypassCapable], ['dontAsk', false]);
  } finally {
    await r.done();
  }
});

test('PILOT-997: a new session no person started starts in Auto while “Auto for agents” is on; a person’s own and a worker do not', async () => {
  const s = await liveSession();
  try {
    s.controller.autonomousAuto = () => true;
    const before = s.ws.tails.length;
    const p = s.controller.create({ workspaceId: 'docker/ws1', title: 'Trigger' }, { actor: 'portal:trigger-abc' });
    const trig = await answering(s, p);
    await until(() => s.ws.tails.length === before + 1);
    await answering(s, until(() => s.controller.get(trig.id)?.mode === 'auto', 3000));
    const audit = s.controller.audit({ kind: 'mode.auto' }).find((x) => x.sessionId === trig.id)!;
    assert.deepEqual([audit.actor, audit.detail.how], ['portal', 'start']);

    const mine = await answering(s, s.controller.create({ workspaceId: 'docker/ws1', title: 'Mine' }));
    await until(() => s.controller.get(mine.id)?.state === 'idle');
    await sleep(50);
    assert.equal(s.controller.get(mine.id)!.mode, 'default', 'a person’s own session starts as they set it');
  } finally {
    await s.done();
  }
});
