// T-1094 (chat-sessions PRD FR39b): the portal lost touch with a lead's process in Bypass (the session host did not answer, so the
// retries ran out: "Lost touch"), the resume that followed failed, and a later start attached to the SAME process (run.lock held, exit 3).
// That process still runs in Bypass and reports it. Before, the loss dropped the control state stored for it, so the attach expected the
// row's start mode and ended the lead for its own Bypass (06:37, 2026-10-18). Now the attach reloads what that process runs in, takes it
// out of Bypass first (fail closed) and the lead's resume puts Bypass back through every gate. A process that really stopped is unchanged:
// a new one that reports Bypass without an entry still ends.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controlProc, readControl } from './integrity.js';
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

/**
 * Answers every mode switch (with the asked mode) and settings read on the newest tail until `p` settles. `from`: answer the requests from
 * that index on too, ones written before this was called (gate #459: the switch out of Bypass was written first, never answered, timed out).
 */
async function answering<T>(s: Live, p: Promise<T>, from?: number): Promise<T> {
  const seen = new Set(controls(s.ws).slice(0, from).map((c) => c.id));
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

/** The host stops answering: every re-follow drops, the status is unknown, and the retries run out ("Lost touch", unconfirmed). */
async function loseTouch(s: Live, lead: { id: string; tail: Live['tail'] }) {
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
  s.ws.statusUnreachable = false;
  return dropped;
}

/** The stored control state of a chat, and the process the row names now. */
function control(s: Live, id: string) {
  const row = s.store.db!.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as Parameters<typeof controlProc>[0] & {
    control_state: string | null;
  };
  const raw = row.control_state ? (JSON.parse(row.control_state) as { proc: string; mode: { expected: string } }) : null;
  return { raw, proc: controlProc(row), read: readControl(row.control_state, controlProc(row)) };
}

const notes = (s: Live, id: string) => s.controller.history(id).flatMap((e) => (e.kind === 'system' && e.text ? [e.text] : []));

test('T-1094: lost touch, a failed resume, then an attach to the same process still in Bypass: the lead lives, Bypass back through the gates', async () => {
  const s = await liveSession({}, true);
  try {
    const lead = await inBypass(s);
    const dropped = await loseTouch(s, lead);
    assert.ok(dropped > 1, `the follower was dropped again on each retry (${dropped})`);
    assert.equal(s.controller.get(lead.id)!.mode, 'default', 'the row says Bypass is paused');

    // The resume fails before any process is up.
    const starts = s.ws.starts;
    s.ws.startCode = 1;
    await assert.rejects(s.controller.send(lead.id, 'lt-1', 'go on'), /Couldn.t resume the session/);
    assert.equal(s.controller.get(lead.id)!.state, 'interrupted');

    // The next start finds the old process still running (run.lock held) and attaches to it; it reports Bypass at once.
    s.ws.startCode = 3;
    const tails = s.ws.tails.length;
    // T-1985: every switch is answered in the tick it is written. The polling `answering` raced the 1 s control timeout under the full
    // suite's load (deploy #518): the switch back into Bypass timed out, so the lead took its restart-once path (a stop and a 5th start).
    // T-2396: answering from before the send, so the switch OUT of Bypass the attach asks first is answered too, not only the one back in.
    s.ws.autoRespond = true;
    const sending = s.controller.send(lead.id, 'lt-2', 'go on');
    await until(() => s.ws.tails.length > tails, 4000);
    s.ws.tails.at(-1)!.push(init(lead.id, 'bypassPermissions'));
    await sending;
    await sleep(50);

    const row = s.controller.get(lead.id)!;
    assert.notEqual(row.state, 'ended', `not ended for its own Bypass: ${row.endedReason ?? ''}`);
    assert.equal(row.process, 'live');
    assert.equal(s.ws.starts, starts + 2, 'the failed start and the attach: no new process');
    const asks = controls(s.ws)
      .filter((c) => c.request.subtype === 'set_permission_mode')
      .map((c) => c.request.mode);
    assert.deepEqual(
      asks.slice(-2),
      ['default', 'bypassPermissions'],
      'out of Bypass first (fail closed), then back through the gated path',
    );
    assert.equal(row.mode, 'bypassPermissions');
    assert.ok(
      notes(s, lead.id).includes('Bypass paused: the portal lost touch with Claude Code while it ran in Bypass.'),
      notes(s, lead.id).join(' | '),
    );
    assert.ok(notes(s, lead.id).includes('Bypass kept after Claude Code stopped.'));
    const left = s.controller.audit({ kind: 'bypass.left', sessionId: lead.id }).map((a) => [a.detail.why, a.detail.kept ?? null]);
    assert.deepEqual(
      left.slice(0, 2),
      [
        ['lost_touch', true],
        ['stopped', true],
      ],
      'newest first: the loss, then the attach that left Bypass',
    );
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
    assert.match(
      s.controller.get(lead.id)!.endedReason ?? '',
      /^integrity: the agent reported Bypass permissions, which chat sessions never allow$/,
    );
  } finally {
    await s.done();
  }
});

test('T-1094: the host said gone, so nothing is kept: even an attach (exit 3) that reports Bypass ends the session', async () => {
  const s = await liveSession({}, true);
  try {
    const lead = await inBypass(s, { lead: false }); // not a lead: no gated re-entry races the report
    s.ws.alive = false;
    lead.tail.exit(0);
    await until(() => s.controller.get(lead.id)!.state === 'interrupted');
    s.ws.alive = true;

    s.ws.startCode = 3;
    const tails = s.ws.tails.length;
    const sending = s.controller.send(lead.id, 'gone-2', 'go on').catch(() => undefined);
    await until(() => s.ws.tails.length > tails, 4000);
    s.ws.tails.at(-1)!.push(init(lead.id, 'bypassPermissions'));
    await until(() => s.controller.get(lead.id)!.state === 'ended');
    await sending;
    assert.match(
      s.controller.get(lead.id)!.endedReason ?? '',
      /^integrity: the agent reported Bypass permissions, which chat sessions never allow$/,
    );
  } finally {
    await s.done();
  }
});

test('T-1094: lost touch keeps the state for THAT process only: a new process (exit 0) reporting Bypass without an entry still ends', async () => {
  const s = await liveSession({}, true);
  try {
    const lead = await inBypass(s, { lead: false }); // not a lead: nothing puts Bypass back, so the report has no entry behind it
    await loseTouch(s, lead);
    const kept = control(s, lead.id);
    assert.equal(kept.read?.mode.expected, 'bypassPermissions', 'the loss kept the state of the process that may still run');

    // The host answers again and the process had stopped after all: the resume starts a new one (exit 0, the next segment).
    const tails = s.ws.tails.length;
    await answering(s, s.controller.send(lead.id, 'new-1', 'go on'));
    await until(() => s.ws.tails.length > tails);
    assert.equal(s.controller.get(lead.id)!.process, 'live', 'a new process (exit 0)');
    const fresh = control(s, lead.id);
    assert.notEqual(fresh.proc, kept.proc, 'another process');
    assert.equal(fresh.raw?.proc, fresh.proc, 'the stored state is the new process’s own');
    assert.equal(fresh.read?.mode.expected, 'default', 'nothing of the kept state carried over');
    assert.equal(readControl(JSON.stringify(kept.raw), fresh.proc), null, 'the kept state never reads for the new process');

    s.ws.tails.at(-1)!.push(init(lead.id, 'bypassPermissions'));
    await until(() => s.controller.get(lead.id)!.state === 'ended');
    assert.match(
      s.controller.get(lead.id)!.endedReason ?? '',
      /^integrity: the agent reported Bypass permissions, which chat sessions never allow$/,
    );
  } finally {
    await s.done();
  }
});

test('T-1094: lost touch, then an attach (exit 3) to the same process in Bypass for a chat that is not a lead: out of Bypass, not back in', async () => {
  const s = await liveSession({}, true);
  try {
    const lead = await inBypass(s, { lead: false });
    await loseTouch(s, lead);
    const entries = s.controller.audit({ kind: 'bypass.entered', sessionId: lead.id }).length;
    const before = controls(s.ws).length;

    s.ws.startCode = 3;
    const tails = s.ws.tails.length;
    const sending = s.controller.send(lead.id, 'att-1', 'go on');
    await until(() => s.ws.tails.length > tails, 4000);
    s.ws.tails.at(-1)!.push(init(lead.id, 'bypassPermissions'));
    // A non-lead's resume does not wait for the switch out of Bypass: keep answering until it was asked, and a while after.
    const asks = () =>
      controls(s.ws)
        .slice(before)
        .filter((c) => c.request.subtype === 'set_permission_mode')
        .map((c) => c.request.mode);
    await answering(
      s,
      sending.then(() => until(() => asks().length > 0)).then(() => sleep(100)),
      before,
    );

    const row = s.controller.get(lead.id)!;
    assert.notEqual(row.state, 'ended', `not ended for its own Bypass: ${row.endedReason ?? ''}`);
    assert.equal(row.process, 'live');
    assert.equal(row.mode, 'default');
    assert.deepEqual(asks(), ['default'], 'taken out of Bypass once, never put back');
    assert.equal(s.controller.audit({ kind: 'bypass.entered', sessionId: lead.id }).length, entries, 'no new entry');
    const left = s.controller.audit({ kind: 'bypass.left', sessionId: lead.id }).map((a) => [a.detail.why, a.detail.kept ?? null]);
    assert.deepEqual(left[0], ['lost_touch', false], 'the attach left Bypass, and not a lead: nothing kept for a resume');
    assert.ok(!notes(s, lead.id).some((n) => n.startsWith('Bypass kept')), notes(s, lead.id).join(' | '));
  } finally {
    await s.done();
  }
});
