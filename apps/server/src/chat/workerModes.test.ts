// PILOT-996 / PILOT-997 (D-103): autonomy modes. A worker takes the mode asked, else its parent's (a Manual parent hands on dontAsk), else
// Auto, never wider than its parent; a worker of a lead in Bypass keeps Bypass through the gated inherit path (the policy, the parent in
// Bypass now) and falls back to dontAsk when a gate says no; a session no person started starts in Auto while "Auto for agents" is on.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoModeAllowed, KEEPGOING_ACTOR, modeWithin, workerMode, type ChatPermissionMode } from '@portal/contracts';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { AUTO_REFUSED } from './controller.js';
import { registerChatTools } from './portalTools.js';
import { ChatStore } from './store.js';
import { APPLIED, controls, init, line, liveSession, ok, sleep, until, USAGE_API_KEY, type Live } from './testkit.js';

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

/** The newest tail of a session's process (`tail <claude session>`). */
function tailOf(s: Live, id: string) {
  for (let i = s.ws.tailArgs.length - 1; i >= 0; i--) if (s.ws.tailArgs[i]![1] === id) return s.ws.tails[i]!;
  throw new Error(`no tail for ${id}`);
}

/** A tool card on `id`'s process: `tool` asks for `input`. */
function card(s: Live, id: string, requestId: string, tool: string, input: Record<string, unknown>) {
  tailOf(s, id).push(line({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: `toolu_${requestId}` } }));
}

test('PILOT-997: Keep going never puts back a Bypass a person switched off, and allows no card; a Bypass that was LOST is put back, its tool cards allowed but not a question', async () => {
  const r = await rig();
  try {
    const lead = await bypassLead(r.s);
    r.h.alive.add(lead);
    // A lead: it has a live worker (#keepBypass's lead gate).
    const a = await r.h.agentToken('docker/ws1', lead);
    spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Ship the fix.', title: 'Worker' })));

    // A person switches Bypass off in the app: deliberate, so it is never put back and a card raised after it waits for a person.
    await answering(r.s, r.s.controller.control(lead, 'mode', { mode: 'default' }, { actor: 'ui' }));
    assert.equal(r.s.controller.get(lead)!.mode, 'default');
    const left = r.s.controller.audit({ kind: 'bypass.left' }).find((x) => x.sessionId === lead)!;
    assert.deepEqual([left.actor, left.detail.why], ['ui', 'mode']);
    card(r.s, lead, 'P1', 'Bash', { command: 'ls' });
    await until(() => r.s.controller.openRequests(lead).length === 1);
    assert.equal(r.s.controller.bypassSeenAt(lead), null, 'a switch-off by a person is not a loss');
    assert.equal(await answering(r.s, r.s.controller.restoreBypass(lead)), false);
    assert.equal(r.s.controller.get(lead)!.mode, 'default');
    assert.deepEqual(
      r.s.controller.openRequests(lead).map((q) => q.requestId),
      ['P1'],
      'the card still waits for a person',
    );
    assert.equal(r.s.controller.audit({ kind: 'bypass.entered' }).filter((x) => x.sessionId === lead && x.detail.how === 'keepgoing').length, 0);

    // Later the chat LOSES Bypass (a restart that could not keep it is the newest record): Keep going puts it back within 24 hours, allows
    // the tool card raised meanwhile, and leaves a question for a person.
    await sleep(5);
    new ChatStore(r.s.store).addAudit({ severity: 'info', kind: 'bypass.left', sessionId: lead, workspaceId: 'docker/ws1', actor: 'portal', detail: { why: 'restart' } });
    card(r.s, lead, 'Q1', 'AskUserQuestion', { questions: [{ question: 'Which one?', header: 'Pick', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }] });
    await until(() => r.s.controller.openRequests(lead).length === 2);
    assert.ok(r.s.controller.bypassSeenAt(lead), 'a loss within 24 hours is seen');
    assert.equal(await answering(r.s, r.s.controller.restoreBypass(lead)), true);
    assert.equal(r.s.controller.get(lead)!.mode, 'bypassPermissions');
    const entered = r.s.controller.audit({ kind: 'bypass.entered' }).find((x) => x.sessionId === lead && x.detail.how === 'keepgoing');
    assert.ok(entered, 'audited as Keep going’s re-entry');
    await until(() => r.s.controller.openRequests(lead).length === 1);
    assert.deepEqual(
      r.s.controller.openRequests(lead).map((q) => q.requestId),
      ['Q1'],
      'the Bash card is allowed; the question stays for a person',
    );
  } finally {
    await r.done();
  }
});

test('PILOT-997: with “Auto for agents” OFF, a session no person started gets no Auto on any path: start, Keep going’s new chat, configure, spawn', async () => {
  const r = await rig();
  try {
    r.s.controller.autonomousAuto = () => false;
    // Start: a trigger's session and Keep going's continuation start in Manual.
    const made: string[] = [];
    for (const actor of ['portal:trigger-abc', KEEPGOING_ACTOR]) {
      const before = r.s.ws.tails.length;
      const one = await answering(r.s, r.s.controller.create({ workspaceId: 'docker/ws1', title: 'Started by the portal' }, { actor }));
      await until(() => r.s.ws.tails.length === before + 1);
      await until(() => r.s.controller.get(one.id)?.state === 'idle');
      await sleep(50);
      assert.equal(r.s.controller.get(one.id)!.mode, 'default', actor);
      assert.equal(r.s.controller.audit({ kind: 'mode.auto' }).filter((x) => x.sessionId === one.id).length, 0, actor);
      made.push(one.id);
    }
    const trig = { id: made[0]! };
    // Configure (what session_configure and session_start's mode call): refused with why and what to do, audited.
    await assert.rejects(r.s.controller.control(trig.id, 'mode', { mode: 'auto' }, { actor: 'portal-mcp:tok1' }), (e: Error) => e.message === AUTO_REFUSED.origin);
    assert.deepEqual(
      r.s.controller.audit({ kind: 'mode.refused' }).filter((x) => x.sessionId === trig.id).map((x) => [x.actor, x.detail.why]),
      [['portal-mcp:tok1', 'origin']],
    );
    // Spawn: its worker asked into Auto is wider than its lead and refused; unasked it gets dontAsk.
    r.h.alive.add(trig.id);
    const a = await r.h.agentToken('docker/ws1', trig.id);
    const refused = await r.h.call(a.secret, 'session_spawn', { prompt: 'x', mode: 'auto' });
    assert.equal(refused.result?.isError, true);
    const w = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Read it.', title: 'Trigger worker' })));
    assert.equal(r.s.controller.get(w.id)!.mode, 'dontAsk');
    assert.equal(r.s.controller.audit({ kind: 'mode.auto' }).length, 0, 'no Auto anywhere');
  } finally {
    await r.done();
  }
});

/**
 * A worker of `parent` in an inherited Bypass, made the way `session_spawn` makes it (`inheritBypass` at the create, then the gated
 * inherit), without a first message: idle, so a restart is allowed (one with a message still on its way is refused).
 */
async function bypassWorker(s: Live, parent: string, title: string) {
  const before = s.ws.tails.length;
  const w = await s.controller.create({ workspaceId: 'docker/ws1', title }, { actor: `session:${parent}`, parentId: parent, inheritBypass: true });
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(w.id)?.state === 'idle');
  await sleep(20);
  tailOf(s, w.id).push(init(w.id));
  assert.equal(await answering(s, s.controller.inheritBypass(w.id)), true, `${title} inherits Bypass`);
  return w.id;
}

test('PILOT-997 review 42957: a person switches a Bypass lead to Manual: its worker and grandchild in an inherited Bypass leave it, a restart does not put it back, and the worker can no longer hand Bypass on', async () => {
  const r = await rig();
  try {
    r.s.controller.agentCaps = () => ({ maxDepth: 2, maxChildren: 5, spawnsPerHour: 20, messagesPerHour: 20 });
    const lead = await bypassLead(r.s);
    const w = { id: await bypassWorker(r.s, lead, 'Worker') };
    r.h.alive.add(w.id);
    const wa = await r.h.agentToken('docker/ws1', w.id);
    // The worker hands Bypass on through session_spawn while its lead is in it.
    const g = spawned(await answering(r.s, r.h.call(wa.secret, 'session_spawn', { prompt: 'Test it.', title: 'Grandchild' })));
    assert.deepEqual(g.applied, ['mode bypassPermissions']);
    assert.deepEqual([r.s.controller.get(w.id)!.mode, r.s.controller.get(g.id)!.mode], ['bypassPermissions', 'bypassPermissions']);

    // A person switches the lead to Manual in the app: the lease ends for its whole line (D-15, D-103 "never wider than its parent").
    await answering(r.s, r.s.controller.control(lead, 'mode', { mode: 'default' }, { actor: 'ui' }));
    await answering(r.s, until(() => r.s.controller.get(g.id)!.mode !== 'bypassPermissions', 3000));
    assert.deepEqual([r.s.controller.get(w.id)!.mode, r.s.controller.get(g.id)!.mode], ['dontAsk', 'dontAsk']);
    for (const [id, parent] of [[w.id, lead], [g.id, w.id]] as const) {
      const left = r.s.controller.audit({ kind: 'bypass.left' }).find((x) => x.sessionId === id)!;
      assert.deepEqual([left.actor, left.detail.why, left.detail.parent], ['portal', 'parent_left', parent], id);
      assert.equal(r.s.controller.bypassSeenAt(id), null, 'not a loss: Keep going never puts it back');
    }

    // A later restart of the worker does not put Bypass back.
    await answering(r.s, r.s.controller.restart(w.id));
    assert.equal(r.s.controller.get(w.id)!.mode, 'dontAsk');
    assert.equal(r.s.controller.audit({ kind: 'bypass.entered' }).filter((x) => x.sessionId === w.id && x.detail.how !== 'inherit').length, 0);
    // Its own session_spawn hands on no Bypass: a worker of a dontAsk parent asked for Bypass is refused, unasked it gets dontAsk.
    assert.equal((await r.h.call(wa.secret, 'session_spawn', { prompt: 'x', mode: 'bypassPermissions' })).result?.isError, true);
    const g2 = spawned(await answering(r.s, r.h.call(wa.secret, 'session_spawn', { prompt: 'Again.', title: 'Grandchild 2' })));
    assert.deepEqual([r.s.controller.get(g2.id)!.mode, r.s.controller.get(g2.id)!.bypassCapable], ['dontAsk', false]);
  } finally {
    await r.done();
  }
});

test('PILOT-997 review 42957: a session whose Bypass was inherited gets it back on a restart only while its parent is in Bypass now', async () => {
  const r = await rig();
  try {
    const lead = await bypassLead(r.s);
    const w = { id: await bypassWorker(r.s, lead, 'Worker') };
    // The parent in Bypass: the worker's restart keeps it.
    await answering(r.s, r.s.controller.restart(w.id));
    assert.equal(r.s.controller.get(w.id)!.mode, 'bypassPermissions', 'kept while the parent is in Bypass');
    // The parent out of Bypass with the worker still in it (only the row, so no cascade runs): the restart's keep asks the parent and drops it.
    new ChatStore(r.s.store).patchSession(lead, { mode: 'default' });
    await answering(r.s, r.s.controller.restart(w.id));
    assert.notEqual(r.s.controller.get(w.id)!.mode, 'bypassPermissions');
    const left = r.s.controller.audit({ kind: 'bypass.left' }).find((x) => x.sessionId === w.id)!;
    assert.deepEqual([left.detail.why, left.detail.how], ['parent_not_bypass', 'restart']);
  } finally {
    await r.done();
  }
});

test('PILOT-997 review 43296: a lead in a kept pause that a person then Ends (keeping its workers) takes its worker out of the inherited Bypass', async () => {
  const r = await rig();
  try {
    const lead = await bypassLead(r.s);
    const w = await bypassWorker(r.s, lead, 'Worker');
    // The lead's Bypass is paused and kept (what a lead's sleep or vanishing writes, #bypassOver kept): its row reads the start mode, the
    // worker stays in Bypass meanwhile (the pause comes back).
    const chats = new ChatStore(r.s.store);
    chats.patchSession(lead, { mode: 'default' });
    chats.addAudit({ severity: 'info', kind: 'bypass.left', sessionId: lead, workspaceId: 'docker/ws1', actor: 'portal', detail: { why: 'sleep', kept: true } });
    assert.equal(r.s.controller.get(w)!.mode, 'bypassPermissions', 'set up: the worker is in Bypass under a paused lead');

    // A person Ends the lead and keeps its workers: the kept pause is superseded, and the worker leaves Bypass with it.
    await answering(r.s, r.s.controller.end(lead));
    await answering(r.s, until(() => r.s.controller.get(w)!.mode !== 'bypassPermissions', 3000)).catch((e) => {
      const g = (id: string) => { const x = r.s.controller.get(id)!; return { state: x.state, mode: x.mode, process: (x as { process?: unknown }).process }; };
      console.log('DIAG', JSON.stringify({ lead: g(lead), w: g(w), audit: r.s.controller.audit({}).filter((x) => x.sessionId === lead || x.sessionId === w).map((x) => [x.sessionId === lead ? 'L' : 'W', x.kind, x.detail]) }));
      throw e;
    });
    assert.equal(r.s.controller.get(lead)!.state, 'ended');
    assert.notEqual(r.s.controller.get(w)!.state, 'ended', 'the worker was kept');
    assert.equal(r.s.controller.get(w)!.mode, 'dontAsk');
    const left = r.s.controller.audit({ kind: 'bypass.left' }).find((x) => x.sessionId === w)!;
    assert.deepEqual([left.detail.why, left.detail.parent], ['parent_left', lead]);
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
