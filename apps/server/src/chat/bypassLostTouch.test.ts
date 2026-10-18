// T-1094 (chat-sessions PRD FR39b): the portal lost touch with a lead's process in Bypass (the session host did not answer, so the
// retries ran out: "Lost touch"), the resume that followed failed, and a later start attached to the SAME process (run.lock held, exit 3).
// That process still runs in Bypass and reports it. Before, the loss dropped the control state stored for it, so the attach expected the
// row's start mode and ended the lead for its own Bypass (06:37, 2026-10-18). Now the attach reloads what that process runs in, takes it
// out of Bypass first (fail closed) and the lead's resume puts Bypass back through every gate. A process that really stopped is unchanged:
// a new one that reports Bypass without an entry still ends.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPLIED, controls, init, liveSession, ok, sleep, until, type Live } from './testkit.js';

async function started(s: Live) {
  const before = s.ws.tails.length;
  const created = await s.controller.create({ workspaceId: 'docker/ws1' }, { bypassOptIn: true });
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(created.id)?.state === 'idle');
  await sleep(20);
  return { id: created.id, tail: s.ws.tails.at(-1)! };
}

/** A bypass-capable chat (a lead unless told otherwise) in Bypass entered by the person, the acknowledgement and a fresh code on record. */
async function inBypass(s: Live, o: { lead?: boolean } = {}) {
  s.controller.controlTimeoutMs = 1000;
  s.controller.bypassAllowed = () => true;
  s.controller.reauth = { fresh: (token) => token === 'tok' };
  const lead = await started(s);
  if (o.lead !== false) s.controller.setLimits(lead.id, { maxWorkers: 3 }, { actor: 'ui' });
  lead.tail.push(init(lead.id));
  const entering = s.controller.enterBypass(lead.id, { acknowledged: true, sessionToken: 'tok' });
  lead.tail.push(ok((await s.take('set_permission_mode')).id, { mode: 'bypassPermissions' }));
  await entering;
  assert.equal(s.controller.get(lead.id)!.mode, 'bypassPermissions');
  return lead;
}

/** Answers every mode switch (with the asked mode) and settings read on the newest tail until `p` settles. */
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
    }
    await sleep(5);
  }
  return p;
}

const notes = (s: Live, id: string) => s.controller.history(id).flatMap((e) => (e.kind === 'system' && e.text ? [e.text] : []));

test('T-1094: lost touch, a failed resume, then an attach to the same process still in Bypass: the lead lives, Bypass back through the gates', async () => {
  const s = await liveSession({}, true);
  try {
    const lead = await inBypass(s);
    // The host stops answering: every re-follow drops, the status is unknown, and the retries run out.
    s.ws.statusUnreachable = true;
    let dropped = 0;
    await until(() => {
      for (const t of s.ws.tails.slice(s.ws.tails.indexOf(lead.tail)))
        if (!t.exited) {
          t.exit(0);
          dropped++;
        }
      return s.controller.get(lead.id)!.state === 'interrupted';
    }, 15_000);
    assert.ok(dropped > 1, `the follower was dropped again on each retry (${dropped})`);
    assert.equal(s.controller.get(lead.id)!.mode, 'default', 'the row says Bypass is paused');

    // The resume fails before any process is up.
    s.ws.statusUnreachable = false;
    const starts = s.ws.starts;
    s.ws.startCode = 1;
    await assert.rejects(s.controller.send(lead.id, 'lt-1', 'go on'), /Couldn.t resume the session/);
    assert.equal(s.controller.get(lead.id)!.state, 'interrupted');

    // The next start finds the old process still running (run.lock held) and attaches to it; it reports Bypass at once.
    s.ws.startCode = 3;
    const tails = s.ws.tails.length;
    const sending = s.controller.send(lead.id, 'lt-2', 'go on');
    await until(() => s.ws.tails.length > tails, 4000);
    s.ws.tails.at(-1)!.push(init(lead.id, 'bypassPermissions'));
    await answering(s, sending);
    await sleep(50);

    const row = s.controller.get(lead.id)!;
    assert.notEqual(row.state, 'ended', `not ended for its own Bypass: ${row.endedReason ?? ''}`);
    assert.equal(row.process, 'live');
    assert.equal(s.ws.starts, starts + 2, 'the failed start and the attach: no new process');
    const asks = controls(s.ws).filter((c) => c.request.subtype === 'set_permission_mode').map((c) => c.request.mode);
    assert.deepEqual(asks.slice(-2), ['default', 'bypassPermissions'], 'out of Bypass first (fail closed), then back through the gated path');
    assert.equal(row.mode, 'bypassPermissions');
    assert.ok(notes(s, lead.id).includes('Bypass paused: the portal lost touch with Claude Code while it ran in Bypass.'), notes(s, lead.id).join(' | '));
    assert.ok(notes(s, lead.id).includes('Bypass kept after Claude Code stopped.'));
    const left = s.controller.audit({ kind: 'bypass.left', sessionId: lead.id }).map((a) => [a.detail.why, a.detail.kept ?? null]);
    assert.deepEqual(left.slice(0, 2), [['lost_touch', true], ['stopped', true]], 'newest first: the loss, then the attach that left Bypass');
    const entered = s.controller.audit({ kind: 'bypass.entered', sessionId: lead.id })[0]!;
    assert.deepEqual([entered.actor, entered.detail.how], ['portal', 'lost'], 'put back by the portal, every gate asked again');
  } finally {
    await s.done();
  }
});

test('T-1094: a process that really stopped: a new one reporting Bypass without an entry still ends the session', async () => {
  const s = await liveSession({}, true);
  try {
    const lead = await inBypass(s, { lead: false });
    s.ws.alive = false;
    lead.tail.exit(0);
    await until(() => s.controller.get(lead.id)!.state === 'interrupted');
    s.ws.alive = true;
    assert.equal(s.controller.get(lead.id)!.mode, 'default');

    const tails = s.ws.tails.length;
    await answering(s, s.controller.send(lead.id, 'gone-1', 'go on'));
    await until(() => s.ws.tails.length > tails);
    assert.equal(s.controller.get(lead.id)!.process, 'live', 'a new process (exit 0)');
    s.ws.tails.at(-1)!.push(init(lead.id, 'bypassPermissions'));
    await until(() => s.controller.get(lead.id)!.state === 'ended');
    assert.match(s.controller.get(lead.id)!.endedReason ?? '', /^integrity: the agent reported Bypass permissions, which chat sessions never allow$/);
  } finally {
    await s.done();
  }
});
