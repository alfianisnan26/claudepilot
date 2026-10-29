// T-3018 (PILOT-1029, chat-sessions PRD FR20): a Konfersi lead held in Bypass ended "integrity: Claude Code switched to Bypass
// permissions, which chat sessions never allow" around its wake. pilot-health restored its Bypass through the acknowledged `POST /bypass`
// (`enterBypass`) while the lead's own wake put it back through `#keepBypass('wake')`. Both gated entries were in flight on the same process
// at once, and the grant that lets a Bypass reply through was ONE flag per session: the first entry to settle cleared it in its `finally`,
// so the second entry's own Bypass reply, read after that, was taken for an intrusion and ended the lead. Now each gated entry holds its own
// share of the grant until its own reply is read; a reply nobody asked for under a grant still ends the session.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPLIED, controls, init, liveSession, ok, sleep, until, USAGE_API_KEY, type Live } from './testkit.js';

function policy(s: Live) {
  s.controller.bypassAllowed = () => true;
  s.controller.reauth = { fresh: (token) => token === 'tok' };
}

/** A bypass-capable lead (a workers limit) a person put in Bypass, the acknowledgement and a fresh code on record. */
async function leadInBypass(s: Live) {
  const before = s.ws.tails.length;
  const created = await s.controller.create({ workspaceId: 'docker/ws1' }, { bypassOptIn: true });
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(created.id)?.state === 'idle');
  await sleep(20);
  const tail = s.ws.tails.at(-1)!;
  s.controller.setLimits(created.id, { maxWorkers: 3 }, { actor: 'ui' });
  tail.push(init(created.id));
  const entering = s.controller.enterBypass(created.id, { acknowledged: true, sessionToken: 'tok' });
  tail.push(ok((await s.take('set_permission_mode')).id, { mode: 'bypassPermissions' }));
  await entering;
  assert.equal(s.controller.get(created.id)!.mode, 'bypassPermissions');
  return { id: created.id };
}

/**
 * Answers every control request on the newest tail until `p` settles. The switches INTO Bypass are held until `hold` of them were asked
 * (or 800 ms passed), then answered one by one, 60 ms apart: the first entry settles (its `finally` runs) before the second reply is read,
 * the way two execs land in the cluster.
 */
async function answeringHeld<T>(s: Live, p: Promise<T>, hold: number): Promise<T> {
  const seen = new Set(controls(s.ws).map((c) => c.id));
  const held: string[] = [];
  let settled = false;
  let since = 0;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) {
    for (const c of controls(s.ws)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (c.request.subtype === 'set_permission_mode' && c.request.mode === 'bypassPermissions') {
        held.push(c.id);
        if (!since) since = Date.now();
      } else if (c.request.subtype === 'set_permission_mode') s.ws.tails.at(-1)!.push(ok(c.id, { mode: String(c.request.mode) }));
      else if (c.request.subtype === 'get_settings') s.ws.tails.at(-1)!.push(ok(c.id, APPLIED));
      else if (c.request.subtype === 'get_usage') s.ws.tails.at(-1)!.push(ok(c.id, USAGE_API_KEY));
    }
    if (held.length && (held.length >= hold || Date.now() - since > 800)) {
      s.ws.tails.at(-1)!.push(ok(held.shift()!, { mode: 'bypassPermissions' }));
      await sleep(60);
      continue;
    }
    await sleep(5);
  }
  return p;
}

test('T-3018: a lead asleep with its Bypass kept, woken while pilot-health restores Bypass (POST /bypass): never ends on integrity', async () => {
  const s = await liveSession({ idleSleepMs: 200 }, true);
  try {
    s.controller.controlTimeoutMs = 150; // the sleep's own requests go unanswered here (as in bypassKeep.test.ts)
    policy(s);
    const lead = await leadInBypass(s);
    await until(() => s.controller.get(lead.id)!.process === 'asleep', 4000);
    assert.equal(s.controller.get(lead.id)!.mode, 'default', 'asleep: Bypass paused');
    s.controller.controlTimeoutMs = 2000; // the held Bypass replies below must not time out

    // The wake (a message to the lead) and the acknowledged restore arrive together.
    const waking = s.controller.send(lead.id, 'wake-1', 'go on');
    const restoring = s.controller.enterBypass(lead.id, { acknowledged: true, sessionToken: 'tok' });
    await answeringHeld(s, Promise.allSettled([waking, restoring]), 2);
    await sleep(100);

    const row = s.controller.get(lead.id)!;
    assert.notEqual(row.state, 'ended', `not ended for its own gated Bypass: ${row.endedReason ?? ''}`);
    assert.equal(row.process, 'live');
    assert.equal(row.mode, 'bypassPermissions', 'back in Bypass through the gated path');
  } finally {
    await s.done();
  }
});

test('T-3018: two acknowledged restores at once on a lead out of Bypass: both replies are the portal’s own, the lead lives in Bypass', async () => {
  const s = await liveSession({}, true);
  try {
    s.controller.controlTimeoutMs = 2000;
    policy(s);
    const lead = await leadInBypass(s);
    // A person's switch out of it; then two restores race (pilot-health retrying, or two clients).
    const leaving = s.controller.control(lead.id, 'mode', { mode: 'default' }, { actor: 'ui' });
    s.ws.tails.at(-1)!.push(ok((await s.take('set_permission_mode')).id, { mode: 'default' }));
    await leaving;
    assert.equal(s.controller.get(lead.id)!.mode, 'default');

    const a = s.controller.enterBypass(lead.id, { acknowledged: true, sessionToken: 'tok' });
    const b = s.controller.enterBypass(lead.id, { acknowledged: true, sessionToken: 'tok' });
    await answeringHeld(s, Promise.allSettled([a, b]), 2);
    await sleep(100);

    const row = s.controller.get(lead.id)!;
    assert.notEqual(row.state, 'ended', `not ended for its own gated Bypass: ${row.endedReason ?? ''}`);
    assert.equal(row.mode, 'bypassPermissions');
  } finally {
    await s.done();
  }
});

test('T-3018 negative: a Bypass reply to a request sent outside any grant still ends the session, even while an entry holds one', async () => {
  const s = await liveSession({}, true);
  try {
    s.controller.controlTimeoutMs = 2000;
    policy(s);
    const lead = await leadInBypass(s);
    const leaving = s.controller.control(lead.id, 'mode', { mode: 'default' }, { actor: 'ui' });
    s.ws.tails.at(-1)!.push(ok((await s.take('set_permission_mode')).id, { mode: 'default' }));
    await leaving;

    // A gated entry is in flight (its reply held), and a plain switch to acceptEdits is answered by Claude Code with Bypass: an
    // intrusion. The grant covers the gated request only, never another request of the same session.
    const entering = s.controller.enterBypass(lead.id, { acknowledged: true, sessionToken: 'tok' }).catch(() => undefined);
    await s.take('set_permission_mode');
    const plain = s.controller.control(lead.id, 'mode', { mode: 'acceptEdits' }, { actor: 'ui' }).catch(() => undefined);
    const req = await s.take('set_permission_mode');
    assert.equal(req.request.mode, 'acceptEdits');
    s.ws.tails.at(-1)!.push(ok(req.id, { mode: 'bypassPermissions' }));
    await plain;
    await entering;
    await until(() => s.controller.get(lead.id)!.state === 'ended');
    assert.match(s.controller.get(lead.id)!.endedReason ?? '', /^integrity: Claude Code switched to Bypass permissions/);
  } finally {
    await s.done();
  }
});
