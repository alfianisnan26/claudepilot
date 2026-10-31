// PILOT-996 / PILOT-997 (D-103), T-2997 (PILOT-1025, D-104): autonomy modes. A worker takes the mode asked; unasked, Bypass from a lead in
// Bypass NOW through the gated inherit path (the policy, the parent's live mode, never its stored one alone), else Auto while "Auto for
// agents" is on (off: its parent's, a Manual parent handing on dontAsk). Auto may be asked whatever the parent's mode while that policy is
// on; any other ask is never wider than the parent; Bypass by name never. A session no person started starts in Auto while the policy is on.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { autoModeAllowed, KEEPGOING_ACTOR, modeWithin, workerMode, workerModeAllowed, type ChatPermissionMode } from '@portal/contracts';
import { ToolRegistry } from '../portalmcp/registry.js';
import { portalMcpHarness } from '../portalmcp/testkit.js';
import { AUTO_REFUSED } from './controller.js';
import { registerChatTools } from './portalTools.js';
import { ChatStore } from './store.js';
import { APPLIED, controls, fail, init, line, liveSession, ok, sleep, until, USAGE_API_KEY, type Live } from './testkit.js';

test('workerMode, modeWithin and autoModeAllowed: inherit, cap, default Auto', () => {
  // T-2997: Bypass only from a parent in it NOW (the portal's live check); a stored Bypass alone gives Auto, the policy on or off.
  assert.equal(workerMode(undefined, 'bypassPermissions', { parentInBypass: true }), 'bypassPermissions', 'a lead in Bypass now hands on Bypass');
  assert.equal(workerMode(undefined, 'bypassPermissions', { parentInBypass: true, autonomousAuto: true }), 'bypassPermissions');
  assert.equal(workerMode(undefined, 'bypassPermissions'), 'auto', 'a stored Bypass the parent is not in now: Auto');
  assert.equal(workerMode(undefined, 'bypassPermissions', { autonomousAuto: true }), 'auto');
  // T-2997 comment 50003: the parent's Bypass wins over a requested Auto; a narrower mode asked by name is kept.
  assert.equal(workerMode('auto', 'bypassPermissions', { parentInBypass: true, autonomousAuto: true }), 'bypassPermissions', 'Auto asked under a lead in Bypass now: Bypass');
  assert.equal(workerMode('auto', 'bypassPermissions', { parentInBypass: true }), 'bypassPermissions');
  for (const m of ['plan', 'dontAsk', 'default', 'acceptEdits'] as const) assert.equal(workerMode(m, 'bypassPermissions', { parentInBypass: true }), m, `${m} asked is kept`);
  assert.equal(workerMode('auto', 'bypassPermissions', { autonomousAuto: true }), 'auto', 'Auto asked, the lead not in Bypass now: Auto');
  // T-2997: "Auto for agents" on: Auto whatever the parent's mode; off, the rule below (D-103).
  for (const p of ['default', 'dontAsk', 'plan', 'acceptEdits', 'auto', null] as const) assert.equal(workerMode(undefined, p, { autonomousAuto: true }), 'auto', `${p} with the policy on`);
  assert.equal(workerMode('dontAsk', 'default', { autonomousAuto: true }), 'dontAsk', 'the mode asked still wins');
  assert.equal(workerModeAllowed('auto', 'default', { autonomousAuto: true }), true, 'Auto asked whatever the parent, policy on');
  assert.equal(workerModeAllowed('auto', 'plan', { autonomousAuto: true }), true);
  assert.equal(workerModeAllowed('auto', 'default'), false, 'policy off: never wider');
  assert.equal(workerModeAllowed('acceptEdits', 'default', { autonomousAuto: true }), false, 'any other mode: never wider');
  assert.equal(workerModeAllowed('dontAsk', 'default', { autonomousAuto: true }), true);
  assert.equal(workerModeAllowed('bypassPermissions', 'bypassPermissions', { autonomousAuto: true }), false, 'Bypass is never asked by name');
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

/**
 * Answers every mode switch (with the mode asked), settings read and usage read, in the order they reach the process, until `p` settles.
 * `refuse`: the modes the process refuses to switch to (its error answer), as Claude Code does when Auto is not available to it.
 */
async function answering<T>(s: Live, p: Promise<T>, refuse: ReadonlySet<string> = new Set()): Promise<T> {
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
      if (c.request.subtype === 'set_permission_mode')
        tail.push(refuse.has(String(c.request.mode)) ? fail(c.id, `${String(c.request.mode)} mode is not available`) : ok(c.id, { mode: String(c.request.mode) }));
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
    // T-2997: Auto asked by name under a lead not in Bypass stays Auto, never capable, and says nothing about Bypass.
    const asked = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Split more.', title: 'Auto asked worker', mode: 'auto' }))) as Spawned & { bypass?: string };
    assert.deepEqual([asked.applied, asked.unconfirmed, asked.bypass], [['mode auto'], [], undefined]);
    assert.deepEqual([r.s.controller.get(asked.id)!.mode, r.s.controller.get(asked.id)!.bypassCapable], ['auto', false]);
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

test('PILOT-997: a worker of a lead in Bypass keeps Bypass through the gated inherit path, audited; with the policy off it gets Auto (T-2997)', async () => {
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
    // T-2997 comment 50003 ("if bypass is on lead, should bypass"): Auto asked by name from a lead in Bypass now gets Bypass, through the
    // same gated inherit path (before: an Auto worker, never made capable).
    r.s.controller.autonomousAuto = () => true;
    const auto = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Review.', title: 'Auto worker', mode: 'auto' })));
    assert.deepEqual([auto.applied, auto.unconfirmed], [['mode bypassPermissions'], []]);
    assert.deepEqual([r.s.controller.get(auto.id)!.mode, r.s.controller.get(auto.id)!.bypassCapable], ['bypassPermissions', true]);
    assert.equal(r.s.controller.audit({ kind: 'bypass.entered' }).find((x) => x.sessionId === auto.id)?.detail.how, 'inherit');
    // A narrower mode asked by name is kept, and gets no capability.
    const narrow = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Read.', title: 'dontAsk worker', mode: 'dontAsk' })));
    assert.deepEqual([r.s.controller.get(narrow.id)!.mode, r.s.controller.get(narrow.id)!.bypassCapable], ['dontAsk', false], 'capability only when Bypass is handed on');

    // The policy turned off: the inherit path is not available, so the worker is not made capable and runs in Auto (T-2997; before:
    // dontAsk), never Bypass and never waiting on a person; the result says why, unasked or Auto asked.
    r.s.controller.bypassAllowed = () => false;
    for (const mode of [undefined, 'auto'] as const) {
      const raw = await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Ship more.', title: `Policy off worker ${mode}`, ...(mode ? { mode } : {}) }));
      const off = spawned(raw) as Spawned & { bypass?: string };
      assert.deepEqual([off.applied, off.unconfirmed], [['mode auto'], []], String(mode));
      assert.deepEqual([r.s.controller.get(off.id)!.mode, r.s.controller.get(off.id)!.bypassCapable], ['auto', false], String(mode));
      assert.equal(off.bypass, 'Bypass not inherited: the Bypass policy is off, auto instead', String(mode));
      assert.match(raw.result!.content![0]!.text, /Bypass not inherited: the Bypass policy is off, auto instead\./, 'the summary says why');
    }
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

test('PILOT-997 review 43368: a Bypass lead’s own restart (Bypass kept) leaves its worker in the inherited Bypass, with no parent_left', async () => {
  const r = await rig();
  try {
    const lead = await bypassLead(r.s);
    const w = await bypassWorker(r.s, lead, 'Worker');
    // One `answering` for the restart and the settle after it: a wrong cascade would send the worker a mode switch just after it.
    const restarted = async () => {
      await r.s.controller.restart(lead);
      await sleep(300);
    };
    await answering(r.s, restarted());
    assert.equal(r.s.controller.get(lead)!.mode, 'bypassPermissions', 'the lead kept Bypass across its restart');
    assert.equal(r.s.controller.get(w)!.mode, 'bypassPermissions', 'the worker kept the inherited Bypass');
    assert.deepEqual(r.s.controller.audit({ kind: 'bypass.left' }).filter((x) => x.sessionId === w).map((x) => x.detail.why), []);
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
    // One `answering` for both: the cascade's mode switch reaches the worker just after `end` returns, and a second `answering` would
    // start counting after it (never answered).
    const ended = async () => {
      await r.s.controller.end(lead);
      await until(() => r.s.controller.get(w)!.mode !== 'bypassPermissions', 3000);
    };
    await answering(r.s, ended());
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
    // One `answering` for the create and the wait: the Auto switch can go out between two of them, and a second one would start counting
    // after it (never answered: the flake of claudepilot-job-0844c756).
    const started = async () => {
      const t = await s.controller.create({ workspaceId: 'docker/ws1', title: 'Trigger' }, { actor: 'portal:trigger-abc' });
      await until(() => s.ws.tails.length === before + 1);
      await until(() => s.controller.get(t.id)?.mode === 'auto', 3000);
      return t;
    };
    const trig = await answering(s, started());
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

test('T-2997: “Auto for agents” on: a Manual lead’s worker with no mode runs in Auto, Auto asked by name is allowed; a wider other mode and Bypass by name stay refused', async () => {
  const r = await rig();
  try {
    r.s.controller.autonomousAuto = () => true;
    const a = await r.h.agentToken('docker/ws1', r.s.id);
    assert.equal(r.s.controller.get(r.s.id)!.mode, 'default', 'set up: the lead runs in Manual');
    const unset = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Run the job.', title: 'Unset worker' })));
    assert.deepEqual([unset.applied, unset.unconfirmed], [['mode auto'], []]);
    const asked = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Run the job.', title: 'Auto worker', mode: 'auto' })));
    assert.deepEqual([asked.applied, asked.unconfirmed], [['mode auto'], []]);
    for (const id of [unset.id, asked.id]) {
      assert.deepEqual([r.s.controller.get(id)!.mode, r.s.controller.get(id)!.bypassCapable], ['auto', false], id);
      assert.ok(r.s.controller.audit({ kind: 'mode.auto' }).some((x) => x.sessionId === id), `mode.auto is audited for ${id}`);
    }
    const count = r.s.controller.children(r.s.id).length;
    const wide = await r.h.call(a.secret, 'session_spawn', { prompt: 'x', mode: 'acceptEdits' });
    assert.equal(wide.result?.isError, true, 'any other mode is never wider than the parent');
    assert.match(JSON.stringify(wide.result!.structuredContent), /never wider than its parent: you run in default, so acceptEdits is refused/);
    assert.equal((await r.h.call(a.secret, 'session_spawn', { prompt: 'x', mode: 'bypassPermissions' })).result?.isError, true, 'Bypass is never asked by name');
    assert.equal(r.s.controller.children(r.s.id).length, count, 'nothing started');
    assert.equal(r.s.controller.audit({ kind: 'bypass.entered' }).length, 0, 'no Bypass anywhere');
  } finally {
    await r.done();
  }
});

test('T-2997: with “Auto for agents” off the D-103 rule holds: a Manual lead’s worker gets dontAsk, Auto asked is refused as wider and says why', async () => {
  const r = await rig();
  try {
    r.s.controller.autonomousAuto = () => false;
    const a = await r.h.agentToken('docker/ws1', r.s.id);
    const w = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Read it.', title: 'Manual lead worker' })));
    assert.deepEqual(w.applied, ['mode dontAsk']);
    assert.equal(r.s.controller.get(w.id)!.mode, 'dontAsk');
    const count = r.s.controller.children(r.s.id).length;
    const refused = await r.h.call(a.secret, 'session_spawn', { prompt: 'x', mode: 'auto' });
    assert.equal(refused.result?.isError, true);
    assert.match(JSON.stringify(refused.result!.structuredContent), /you run in default, so auto is refused \(“Auto for agents” is off in Settings › Sessions\)/);
    assert.equal((await r.h.call(a.secret, 'session_spawn', { prompt: 'x', mode: 'bypassPermissions' })).result?.isError, true, 'Bypass is never asked by name');
    assert.equal(r.s.controller.children(r.s.id).length, count, 'nothing started');
    assert.equal(r.s.controller.audit({ kind: 'mode.auto' }).length, 0, 'no Auto anywhere');
  } finally {
    await r.done();
  }
});

test('T-2997: a lead in Bypass now hands Bypass to a worker with no mode through the inherit path, with no integrity end; a leave on record after its entry hands on Auto', async () => {
  const r = await rig();
  try {
    r.s.controller.autonomousAuto = () => true;
    const lead = await bypassLead(r.s);
    r.h.alive.add(lead);
    assert.equal(r.s.controller.bypassNow(lead), true, 'set up: the lead is in Bypass now');
    const a = await r.h.agentToken('docker/ws1', lead);
    const w = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Ship it.', title: 'Bypass worker' })));
    assert.deepEqual([w.applied, w.unconfirmed], [['mode bypassPermissions'], []]);
    await sleep(100); // a late integrity end would show here
    const worker = r.s.controller.get(w.id)!;
    assert.deepEqual([worker.mode, worker.bypassCapable, worker.state === 'ended', worker.endedReason], ['bypassPermissions', true, false, null]);
    const entered = r.s.controller.audit({ kind: 'bypass.entered' }).filter((x) => x.sessionId === w.id);
    assert.deepEqual(
      entered.map((x) => x.detail.how),
      ['inherit'],
      'entered once, through the inherit path',
    );
    assert.equal(r.s.controller.audit({ kind: 'bypass.capable' }).find((x) => x.sessionId === w.id)?.detail.how, 'inherit');

    // The portal recorded the lead leaving Bypass after its entry while its row still says Bypass: not in Bypass now, so Auto.
    await sleep(5);
    new ChatStore(r.s.store).addAudit({ severity: 'info', kind: 'bypass.left', sessionId: lead, workspaceId: 'docker/ws1', actor: 'portal', detail: { why: 'downgrade', mode: 'default' } });
    assert.equal(r.s.controller.get(lead)!.mode, 'bypassPermissions', 'set up: the row still says Bypass');
    assert.equal(r.s.controller.bypassNow(lead), false);
    const after = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Ship more.', title: 'After the leave' })));
    assert.deepEqual([after.applied, after.unconfirmed], [['mode auto'], []]);
    assert.deepEqual([r.s.controller.get(after.id)!.mode, r.s.controller.get(after.id)!.bypassCapable], ['auto', false]);
  } finally {
    await r.done();
  }
});

test('T-2997: a lead whose stored mode says Bypass but which is not in Bypass now gives its worker Auto, never a half-entered Bypass, the policy on or off', async () => {
  const r = await rig();
  try {
    // A capable lead a person started, the Bypass policy on, that never entered Bypass: its process runs in Manual, only its row says Bypass.
    r.s.controller.bypassAllowed = () => true;
    const before = r.s.ws.tails.length;
    const lead = (await r.s.controller.create({ workspaceId: 'docker/ws1', title: 'Lead' }, { bypassOptIn: true })).id;
    await until(() => r.s.ws.tails.length === before + 1);
    await until(() => r.s.controller.get(lead)?.state === 'idle');
    await sleep(20);
    r.s.ws.tails.at(-1)!.push(init(lead));
    await sleep(20);
    new ChatStore(r.s.store).patchSession(lead, { mode: 'bypassPermissions' });
    assert.deepEqual([r.s.controller.get(lead)!.mode, r.s.controller.get(lead)!.bypassCapable], ['bypassPermissions', true], 'set up: a stale Bypass on the row');
    assert.equal(r.s.controller.bypassNow(lead), false, 'not in Bypass now');
    r.h.alive.add(lead);
    const a = await r.h.agentToken('docker/ws1', lead);
    for (const on of [true, false]) {
      r.s.controller.autonomousAuto = () => on;
      const w = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Run the job.', title: `Worker ${on}` })));
      assert.deepEqual([w.applied, w.unconfirmed], [['mode auto'], []], `Auto for agents ${on}`);
      const worker = r.s.controller.get(w.id)!;
      assert.deepEqual([worker.mode, worker.bypassCapable, worker.state === 'ended'], ['auto', false, false], `Auto for agents ${on}`);
    }
    // The controller's own gate says the same to a direct create asking to inherit: no capability, no entry.
    const direct = await r.s.controller.create({ workspaceId: 'docker/ws1', title: 'Direct' }, { actor: `session:${lead}`, parentId: lead, inheritBypass: true });
    assert.equal(r.s.controller.get(direct.id)!.bypassCapable, false);
    await until(() => r.s.controller.get(direct.id)?.state === 'idle');
    assert.equal(await answering(r.s, r.s.controller.inheritBypass(direct.id)), false);
    assert.equal(r.s.controller.audit({ kind: 'bypass.entered' }).length, 0, 'Bypass was never entered');
    assert.equal(r.s.controller.audit({ kind: 'bypass.capable' }).filter((x) => x.detail.how === 'inherit').length, 0, 'no capability handed on');
  } finally {
    await r.done();
  }
});

test('T-3215 (PILOT-1112, folds PILOT-1025): a worker never runs in default or dontAsk unasked: Auto refused by its Claude ends it before any instruction, the lead told why', async () => {
  const r = await rig();
  try {
    r.s.controller.autonomousAuto = () => true;
    const a = await r.h.agentToken('docker/ws1', r.s.id);
    assert.equal(r.s.controller.get(r.s.id)!.mode, 'default', 'set up: the lead runs in Manual');
    const sendsBefore = r.s.ws.sends.length;
    const refused = await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Run the job.', title: 'Auto refused' }), new Set(['auto', 'dontAsk']));
    assert.equal(refused.result?.isError, true, 'the spawn fails');
    const error = refused.result!.structuredContent!.error as { code: string; message: string };
    assert.equal(error.code, 'CONFLICT');
    assert.match(error.message, /^The worker could not be confirmed in auto mode \(auto mode is not available\), so it was ended before it got any instruction: it would have run in default/);
    const w = r.s.controller.children(r.s.id).find((c) => c.title === 'Auto refused')!;
    assert.equal(w.state, 'ended', 'never left running in default');
    assert.equal(r.s.controller.history(w.id).some((e) => e.kind === 'user'), false, 'no instruction went in');
    const modes = controls({ sends: r.s.ws.sends.slice(sendsBefore) } as unknown as Live['ws']).filter((c) => c.request.subtype === 'set_permission_mode').map((c) => c.request.mode);
    assert.deepEqual(modes, ['auto'], 'no dontAsk fallback is tried');

    // A wider mode asked by name (acceptEdits under an Auto lead) and refused: ended too, never default.
    await answering(r.s, r.s.controller.control(r.s.id, 'mode', { mode: 'auto' }, { actor: 'ui' }));
    const edit = await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Edit only.', title: 'Edit refused', mode: 'acceptEdits' }), new Set(['acceptEdits']));
    assert.equal(edit.result?.isError, true);
    assert.equal(r.s.controller.children(r.s.id).find((c) => c.title === 'Edit refused')!.state, 'ended');
    // Auto answered: the worker runs in Auto (the default order unchanged).
    const ok2 = spawned(await answering(r.s, r.h.call(a.secret, 'session_spawn', { prompt: 'Run it.', title: 'Auto ok' })));
    assert.deepEqual([ok2.applied, r.s.controller.get(ok2.id)!.mode], [['mode auto'], 'auto']);
  } finally {
    await r.done();
  }
});
