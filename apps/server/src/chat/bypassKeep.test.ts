// T-1711 and T-1692 (chat-sessions PRD FR20, FR39b): Konfersi leads in Bypass read the start mode while their process ran.
// 1. T-1711: a lead was Interrupted ("Bypass paused: Claude Code stopped") while the host said its process was live: a `live` reading
//    after each dropped follower still spent one of the five retries, so five quick drops in a row read as "Lost touch".
// 2. T-1692: an automatic move of a lead whose sleep kept its Bypass started the new Claude in the start mode for good: the move only put
//    back a Bypass the row still showed, and a sleeping lead's row shows the start mode.
// 3. T-1692: a top-level crew lead with no live worker, no workers limit and no Keep going (the general lead) slept out of Bypass for good;
//    T-1646 had kept it only over a vanishing.
// 4. T-1692: after the portal lost touch, the attach takes the process out of Bypass (fail closed) and the lead's resume puts it back; the
//    two switches went out on separate execs, so a slow "out" line could land last and leave the process in the start mode.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { APPLIED, controls, init, line, liveSession, ok, sleep, until, USAGE_API_KEY, type Live } from './testkit.js';

const notes = (s: Live, id: string) => s.controller.history(id).flatMap((e) => (e.kind === 'system' && e.text ? [e.text] : []));
const modeAsks = (s: Live) => controls(s.ws).filter((c) => c.request.subtype === 'set_permission_mode');

function policy(s: Live) {
  s.controller.bypassAllowed = () => true;
  s.controller.reauth = { fresh: (token) => token === 'tok' };
}

/** A bypass-capable chat a person started and put in Bypass; `lead` marks it a crew lead at its start, `maxWorkers` sets a workers limit. */
async function inBypass(s: Live, o: { lead?: boolean; maxWorkers?: number } = {}) {
  const before = s.ws.tails.length;
  const created = await s.controller.create({ workspaceId: 'docker/ws1', ...(o.lead ? { lead: true } : {}) }, { bypassOptIn: true });
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(created.id)?.state === 'idle');
  await sleep(20);
  const tail = s.ws.tails.at(-1)!;
  if (o.maxWorkers) s.controller.setLimits(created.id, { maxWorkers: o.maxWorkers }, { actor: 'ui' });
  tail.push(init(created.id));
  const entering = s.controller.enterBypass(created.id, { acknowledged: true, sessionToken: 'tok' });
  tail.push(ok((await s.take('set_permission_mode')).id, { mode: 'bypassPermissions' }));
  await entering;
  assert.equal(s.controller.get(created.id)!.mode, 'bypassPermissions');
  return { id: created.id, tail };
}

/** Answers every mode switch (with the asked mode) and settings read on the newest tail, in the order they reach the process, until `p` settles. */
async function answering<T>(s: Live, p: Promise<T>): Promise<T> {
  const seen = new Set(controls(s.ws).map((c) => c.id));
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) {
    for (const c of controls(s.ws)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (c.request.subtype === 'set_permission_mode') s.ws.tails.at(-1)!.push(ok(c.id, { mode: String(c.request.mode) }));
      else if (c.request.subtype === 'get_settings') s.ws.tails.at(-1)!.push(ok(c.id, APPLIED));
      else if (c.request.subtype === 'get_usage') s.ws.tails.at(-1)!.push(ok(c.id, USAGE_API_KEY));
    }
    await sleep(5);
  }
  return p;
}

test('T-1711: a follower that keeps dropping while the host says the process runs never marks it gone: it re-follows, backing off', async () => {
  const s = await liveSession({}, true);
  try {
    // Six quick drops in a row, each read live by the host: before, the sixth was "Lost touch" and the session Interrupted.
    let dropped = 0;
    while (dropped < 6) {
      const tail = s.ws.tails.at(-1)!;
      if (!tail.exited) {
        tail.exit(0);
        dropped++;
      }
      await until(() => s.ws.tails.at(-1)!.exited === false || s.controller.get(s.id)!.state === 'interrupted', 4000).catch(() => undefined);
      if (s.controller.get(s.id)!.state === 'interrupted') break;
    }
    await sleep(100);
    const row = s.controller.get(s.id)!;
    assert.equal(row.state, 'idle', `not Interrupted on a live reading (${row.endedReason ?? ''})`);
    assert.equal(row.process, 'live');
    assert.ok(!notes(s, s.id).some((t) => /Lost touch/.test(t)), notes(s, s.id).join(' | '));
    assert.ok(s.ws.statusLog.length >= 6 && s.ws.statusLog.every((r) => r.alive), 'each drop was checked with the host, which said live');
    // It still follows: the follower after the sixth drop opened (after the back-off) and its lines are read.
    assert.equal(s.ws.tails.length, 7);
    assert.equal(s.ws.tails.at(-1)!.exited, false);
    s.ws.tails.at(-1)!.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Still here.' }] }, parent_tool_use_id: null, uuid: randomUUID() }));
    await until(() => s.controller.history(s.id).some((e) => e.kind === 'assistant' && e.text === 'Still here.'), 2000);
  } finally {
    await s.done();
  }
});

test('T-1711: a host that cannot be reached still runs out of retries ("Lost touch"): only a live reading is spared', async () => {
  const s = await liveSession({}, true);
  try {
    s.ws.statusUnreachable = true;
    await until(() => {
      const tail = s.ws.tails.at(-1)!;
      if (!tail.exited) tail.exit(0);
      return s.controller.get(s.id)!.state === 'interrupted';
    }, 15_000);
    assert.equal(s.controller.get(s.id)!.process, 'gone');
  } finally {
    s.ws.statusUnreachable = false;
    await s.done();
  }
});

/** The newest run acknowledges the moved context (the move's ack turn). */
async function acknowledge(s: Live, id: string, oldCsid: string) {
  await until(() => s.controller.get(id)!.claudeSessionId !== oldCsid);
  const nid = s.controller.get(id)!.claudeSessionId;
  const tail = s.ws.tails.at(-1)!;
  await until(() => s.ws.sends.some((x) => x.args[1] === nid && x.line.includes('transferred_context')));
  tail.push(init(nid));
  tail.push(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Got it.' }] }, parent_tool_use_id: null, uuid: randomUUID() }));
  tail.push(line({ type: 'result', subtype: 'success', total_cost_usd: 0.01, duration_ms: 10, usage: { input_tokens: 1, output_tokens: 1 }, is_error: false, session_id: nid }));
}

test('T-1692: an automatic move of a lead whose sleep kept its Bypass brings Bypass back on the new Claude, through the wake’s gates', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    s.controller.controlTimeoutMs = 150;
    policy(s);
    const lead = await inBypass(s, { maxWorkers: 3 });
    await until(() => s.controller.get(lead.id)!.process === 'asleep', 4000);
    assert.equal(s.controller.get(lead.id)!.mode, 'default', 'asleep: nothing runs in Bypass');
    assert.ok(notes(s, lead.id).includes('Bypass paused for sleep: it comes back at the wake if the policy still allows it.'));

    const work = await s.controller.createClaude('docker/ws1', 'Work');
    const old = s.controller.get(lead.id)!.claudeSessionId;
    const moving = answering(s, s.controller.switchClaude(lead.id, work.id, { handoff: 'skip' }));
    await acknowledge(s, lead.id, old);
    const moved = await moving;

    assert.equal(moved.claudeName, 'Work');
    assert.equal(moved.mode, 'bypassPermissions', 'back in Bypass on the new Claude');
    assert.equal(modeAsks(s).at(-1)!.request.mode, 'bypassPermissions', 'the new process was switched into Bypass');
    assert.ok(notes(s, lead.id).includes('Bypass kept after the wake.'), notes(s, lead.id).join(' | '));
    const entered = s.controller.audit({ kind: 'bypass.entered', sessionId: lead.id })[0]!;
    assert.deepEqual([entered.actor, entered.detail.how, entered.detail.claude], ['portal', 'wake', 'Work']);
  } finally {
    await s.done();
  }
});

test('T-1692: a move of a chat that slept out of Bypass (not a lead) stays on the start mode: nothing is put back', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    s.controller.controlTimeoutMs = 150;
    policy(s);
    const chat = await inBypass(s);
    await until(() => s.controller.get(chat.id)!.process === 'asleep', 4000);
    assert.ok(notes(s, chat.id).includes('Bypass turned off after sleep.'));
    const asked = modeAsks(s).length;

    const work = await s.controller.createClaude('docker/ws1', 'Work');
    const old = s.controller.get(chat.id)!.claudeSessionId;
    const moving = answering(s, s.controller.switchClaude(chat.id, work.id, { handoff: 'skip' }));
    await acknowledge(s, chat.id, old);
    const moved = await moving;
    assert.equal(moved.mode, 'default');
    assert.ok(!modeAsks(s).slice(asked).some((c) => c.request.mode === 'bypassPermissions'), 'Claude Code was never asked to enter Bypass');
  } finally {
    await s.done();
  }
});

test('T-1692: a top-level crew lead with no worker, no workers limit and no Keep going keeps its Bypass over a sleep; the wake asks every gate', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    s.controller.controlTimeoutMs = 150;
    policy(s);
    const lead = await inBypass(s, { lead: true });
    await until(() => s.controller.get(lead.id)!.process === 'asleep', 4000);
    assert.ok(
      notes(s, lead.id).includes('Bypass paused for sleep: it comes back at the wake if the policy still allows it.'),
      notes(s, lead.id).join(' | '),
    );
    assert.deepEqual(
      s.controller.audit({ kind: 'bypass.left', sessionId: lead.id }).map((a) => [a.detail.why, a.detail.kept ?? null]),
      [['sleep', true]],
    );

    await answering(s, s.controller.send(lead.id, 'crew-lead-wake', 'go on'));
    assert.equal(s.controller.get(lead.id)!.mode, 'bypassPermissions', 'back in Bypass after the wake');
    assert.ok(notes(s, lead.id).includes('Bypass kept after the wake.'));
    const entered = s.controller.audit({ kind: 'bypass.entered', sessionId: lead.id })[0]!;
    assert.deepEqual([entered.actor, entered.detail.how], ['portal', 'wake']);
  } finally {
    await s.done();
  }
});

test('T-1692: after lost touch, the attach’s switch out of Bypass lands before the gated switch back, however slow its exec: the lead ends in Bypass', async () => {
  const s = await liveSession({}, true);
  try {
    s.controller.controlTimeoutMs = 2000;
    policy(s);
    const lead = await inBypass(s, { maxWorkers: 3 });
    // The host stops answering: the follower drops, status is unknown, the retries run out ("Lost touch", unconfirmed).
    s.ws.statusUnreachable = true;
    await until(() => {
      const tail = s.ws.tails.at(-1)!;
      if (!tail.exited) tail.exit(0);
      return s.controller.get(lead.id)!.state === 'interrupted';
    }, 15_000);
    s.ws.statusUnreachable = false;
    assert.equal(s.controller.get(lead.id)!.mode, 'default', 'paused on the row');

    // The next message attaches to the same process (run.lock held); the switch out of Bypass takes its time to reach it.
    s.ws.startCode = 3;
    s.ws.sendDelay = (l) => (l.includes('"set_permission_mode"') && l.includes('"mode":"default"') ? 300 : 0);
    const asked = modeAsks(s).length;
    await answering(s, s.controller.send(lead.id, 'lt-slow', 'go on'));
    await sleep(400);

    const reached = modeAsks(s)
      .slice(asked)
      .map((c) => c.request.mode);
    assert.deepEqual(reached, ['default', 'bypassPermissions'], 'out first, then back in, in the order they reached the process');
    const row = s.controller.get(lead.id)!;
    assert.equal(row.process, 'live');
    assert.equal(row.mode, 'bypassPermissions');
    assert.ok(notes(s, lead.id).includes('Bypass kept after Claude Code stopped.'));
  } finally {
    s.ws.sendDelay = null;
    await s.done();
  }
});
