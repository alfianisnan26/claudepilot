// T-416 S2 (chat-sessions PRD FR39b, FR20): a lead whose process vanished in Bypass (an OOM kill) has Bypass put back when it runs
// again, through the same gated path as a lead's wake (`#keepBypass`, how `lost`): the policy, the capability, still a lead, and a
// person's own entry with the acknowledgement and a fresh server code on record, every one checked again. A failing gate leaves the
// session on the start mode, and the process is never asked to enter Bypass. A session that is not a lead never gets it back.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controls, init, liveSession, ok, sleep, until, type Live } from './testkit.js';

const FLAG = '--allow-dangerously-skip-permissions';

async function started(s: Live) {
  const before = s.ws.tails.length;
  const created = await s.controller.create({ workspaceId: 'docker/ws1' }, { bypassOptIn: true });
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(created.id)?.state === 'idle');
  await sleep(20);
  return { id: created.id, tail: s.ws.tails.at(-1)! };
}

const notes = (s: Live, id: string) => s.controller.history(id).flatMap((e) => (e.kind === 'system' && e.text ? [e.text] : []));
const bypassAsks = (s: Live) => controls(s.ws).filter((c) => c.request.subtype === 'set_permission_mode' && c.request.mode === 'bypassPermissions');

/** A bypass-capable lead (a workers limit) in Bypass entered by the person, then its process vanishes: Interrupted. */
async function leadLost(s: Live, o: { lead?: boolean } = {}) {
  s.controller.controlTimeoutMs = 150;
  const state = { allowed: true };
  s.controller.bypassAllowed = () => state.allowed;
  s.controller.reauth = { fresh: (token) => token === 'tok' };
  const lead = await started(s);
  if (o.lead !== false) s.controller.setLimits(lead.id, { maxWorkers: 3 }, { actor: 'ui' });
  lead.tail.push(init(lead.id));
  const entering = s.controller.enterBypass(lead.id, { acknowledged: true, sessionToken: 'tok' });
  lead.tail.push(ok((await s.take('set_permission_mode')).id, { mode: 'bypassPermissions' }));
  await entering;
  assert.equal(s.controller.get(lead.id)!.mode, 'bypassPermissions');
  s.ws.alive = false;
  lead.tail.exit(0);
  await until(() => s.controller.get(lead.id)!.state === 'interrupted');
  s.ws.alive = true;
  assert.equal(s.controller.get(lead.id)!.mode, 'default', 'nothing runs in Bypass once the process is gone');
  return { lead, state };
}

/** The lead runs again (a message resumes it) and, when it is asked, the switch to Bypass is answered. */
async function resume(s: Live, id: string, uuid: string, answer: boolean) {
  const asked = bypassAsks(s).length;
  const tails = s.ws.tails.length;
  const sending = s.controller.send(id, uuid, 'go on');
  if (answer) {
    await until(() => s.ws.tails.length > tails && bypassAsks(s).length > asked, 4000);
    s.ws.tails.at(-1)!.push(ok(bypassAsks(s).at(-1)!.id, { mode: 'bypassPermissions' }));
  }
  await sending;
  return { asked };
}

const left = (s: Live, id: string) => s.controller.audit({ kind: 'bypass.left', sessionId: id })[0]!;

/** After a failing gate: running, on the start mode, never asked, and the record says which gate. */
function stayedOut(s: Live, id: string, asked: number, why: string) {
  assert.equal(s.controller.get(id)!.process, 'live');
  assert.equal(s.controller.get(id)!.mode, 'default', 'not in Bypass');
  assert.equal(bypassAsks(s).length, asked, 'Claude Code was never asked to enter Bypass');
  assert.deepEqual([left(s, id).detail.why, left(s, id).detail.how], [why, 'lost']);
  assert.equal(s.controller.audit({ kind: 'bypass.entered', sessionId: id }).filter((a) => a.detail.how === 'lost').length, 0);
}

test('T-416 S2: a lead that vanished in Bypass runs again in Bypass, every gate checked again, on the record', async () => {
  const s = await liveSession({}, true);
  try {
    const { lead } = await leadLost(s);
    assert.deepEqual(s.controller.audit({ kind: 'bypass.left', sessionId: lead.id }).map((a) => [a.detail.why, a.detail.kept]), [['stopped', true]]);
    await resume(s, lead.id, 'lost-1', true);
    assert.ok(s.ws.startArgs.at(-1)!.includes(FLAG), 'relaunched with the flag: capable, and the policy allows it');
    assert.equal(s.controller.get(lead.id)!.mode, 'bypassPermissions');
    assert.ok(notes(s, lead.id).includes('Bypass kept after Claude Code stopped.'));
    const entered = s.controller.audit({ kind: 'bypass.entered', sessionId: lead.id })[0]!;
    assert.deepEqual([entered.severity, entered.actor, entered.detail.how], ['high', 'portal', 'lost']);
  } finally {
    await s.done();
  }
});

test('T-416 S2 gate policy: turned off meanwhile, the lead runs again on the start mode, not even launched with the flag', async () => {
  const s = await liveSession({}, true);
  try {
    const { lead, state } = await leadLost(s);
    state.allowed = false;
    const { asked } = await resume(s, lead.id, 'lost-2', false);
    assert.ok(!s.ws.startArgs.at(-1)!.includes(FLAG));
    stayedOut(s, lead.id, asked, 'policy');
  } finally {
    await s.done();
  }
});

test('T-416 S2 gate capability: a session no longer capable does not get Bypass back', async () => {
  const s = await liveSession({}, true);
  try {
    const { lead } = await leadLost(s);
    s.store.db!.prepare('UPDATE chat_sessions SET bypass_capable = 0 WHERE id = ?').run(lead.id);
    const { asked } = await resume(s, lead.id, 'lost-3', false);
    stayedOut(s, lead.id, asked, 'not_capable');
  } finally {
    await s.done();
  }
});

test('T-416 S2 gate lead: a chat that is no longer a lead does not get Bypass back', async () => {
  const s = await liveSession({}, true);
  try {
    const { lead } = await leadLost(s);
    s.controller.setLimits(lead.id, { maxWorkers: null }, { actor: 'ui' });
    const { asked } = await resume(s, lead.id, 'lost-4', false);
    stayedOut(s, lead.id, asked, 'not_lead');
  } finally {
    await s.done();
  }
});

for (const [gate, from, to] of [
  ['no entry by a person on record', '', ''],
  ['no acknowledgement on record', '"acknowledged":true', '"acknowledged":false'],
  ['no fresh server code on record', '"reauth":"fresh"', '"reauth":"stale"'],
] as const) {
  test(`T-416 S2 gate confirmation: ${gate}, so Bypass is not put back`, async () => {
    const s = await liveSession({}, true);
    try {
      const { lead } = await leadLost(s);
      const db = s.store.db!;
      if (gate.startsWith('no entry')) db.prepare("UPDATE chat_audit SET actor = 'portal' WHERE kind = 'bypass.entered' AND session_id = ?").run(lead.id);
      else db.prepare("UPDATE chat_audit SET detail = replace(detail, ?, ?) WHERE kind = 'bypass.entered' AND session_id = ?").run(from, to, lead.id);
      const { asked } = await resume(s, lead.id, 'lost-5', false);
      stayedOut(s, lead.id, asked, 'not_confirmed');
    } finally {
      await s.done();
    }
  });
}

test('T-416 S2: a session that was not a lead when its process vanished is not marked to get Bypass back', async () => {
  const s = await liveSession({}, true);
  try {
    const { lead } = await leadLost(s, { lead: false });
    assert.deepEqual(s.controller.audit({ kind: 'bypass.left', sessionId: lead.id }).map((a) => [a.detail.why, a.detail.kept ?? null]), [['stopped', null]]);
    const { asked } = await resume(s, lead.id, 'lost-6', false);
    assert.equal(s.controller.get(lead.id)!.mode, 'default');
    assert.equal(bypassAsks(s).length, asked, 'never asked to enter Bypass');
    assert.equal(s.controller.audit({ kind: 'bypass.entered', sessionId: lead.id }).filter((a) => a.detail.how === 'lost').length, 0);
  } finally {
    await s.done();
  }
});

// T-416 S2b: only a vanished process (`#markGone`) may leave the "kept" record as the newest Bypass record. A workspace stop, a person's
// end and the Bypass restart that come after it supersede it, or a later message would count as a relaunch after a loss and put Bypass back.

/** A lead running on the start mode whose newest Bypass record still says a vanished process kept it (as after a loss it was not resumed from). */
async function liveWithStaleKept(s: Live) {
  const { lead, state } = await leadLost(s);
  state.allowed = false;
  await resume(s, lead.id, 'stale-1', false); // runs again, the gates fail: out of Bypass, on the record
  state.allowed = true;
  const row = s.controller.get(lead.id)!;
  s.store.db!.prepare('INSERT INTO chat_audit (at, severity, kind, session_id, workspace_id, actor, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    new Date().toISOString(),
    'info',
    'bypass.left',
    lead.id,
    row.workspaceId,
    'portal',
    JSON.stringify({ why: 'stopped', kept: true }),
  );
  assert.equal(s.controller.audit({ kind: 'bypass', sessionId: lead.id })[0]!.detail.kept, true, 'set up: the kept record is the newest');
  return { lead, workspaceId: row.workspaceId };
}

const newest = (s: Live, id: string) => s.controller.audit({ kind: 'bypass', sessionId: id })[0]!;

test('T-416 S2b: a workspace stop supersedes the kept record, and a later message does not bring Bypass back', async () => {
  const s = await liveSession({}, true);
  try {
    const { lead, workspaceId } = await liveWithStaleKept(s);
    await s.controller.endWorkspaceSessions(workspaceId, 'workspace stopped');
    assert.notEqual(newest(s, lead.id).detail.kept, true, 'no longer kept');
    const { asked } = await resume(s, lead.id, 'stale-2', false);
    assert.equal(s.controller.get(lead.id)!.process, 'live');
    assert.equal(s.controller.get(lead.id)!.mode, 'default');
    assert.equal(bypassAsks(s).length, asked, 'never asked to enter Bypass');
    assert.equal(s.controller.audit({ kind: 'bypass.entered', sessionId: lead.id }).filter((a) => a.detail.how === 'lost').length, 0);
  } finally {
    await s.done();
  }
});

test('T-416 S2b: a person ending the chat supersedes the kept record', async () => {
  const s = await liveSession({}, true);
  try {
    const { lead } = await liveWithStaleKept(s);
    await s.controller.end(lead.id);
    assert.equal(s.controller.get(lead.id)!.state, 'ended');
    assert.notEqual(newest(s, lead.id).detail.kept, true, 'no longer kept: nothing may restore Bypass for it');
    assert.equal(s.controller.audit({ kind: 'bypass.entered', sessionId: lead.id }).filter((a) => a.detail.how === 'lost').length, 0);
  } finally {
    await s.done();
  }
});

test('T-416 S2b: the Bypass restart supersedes the kept record, and the relaunch does not enter Bypass', async () => {
  const s = await liveSession({}, true);
  try {
    const { lead } = await liveWithStaleKept(s);
    // The restart waits for a turn boundary: the message that relaunched it is taken as done, and the session is no longer capable.
    s.store.db!.prepare("UPDATE chat_sessions SET bypass_capable = 0, state = 'idle' WHERE id = ?").run(lead.id);
    const asked = bypassAsks(s).length;
    const tails = s.ws.tails.length;
    const allowing = s.controller.allowBypass(lead.id);
    await until(() => s.ws.tails.length > tails, 4000);
    await allowing;
    assert.equal(s.controller.get(lead.id)!.process, 'live');
    assert.equal(s.controller.get(lead.id)!.mode, 'default');
    assert.equal(bypassAsks(s).length, asked, 'never asked to enter Bypass');
    // The restart itself superseded the record (not a later gate drop that happened to replace it): why stopped, superseded, not kept.
    // (The newest Bypass record overall is `bypass.capable`, written after the close-out: read the newest `bypass.left`.)
    const n = left(s, lead.id);
    assert.deepEqual([n.kind, n.detail.why, n.detail.superseded ?? null, n.detail.kept ?? null], ['bypass.left', 'stopped', true, null]);
    assert.equal(s.controller.audit({ kind: 'bypass.entered', sessionId: lead.id }).filter((a) => a.detail.how === 'wake' || a.detail.how === 'lost').length, 0);
  } finally {
    await s.done();
  }
});
