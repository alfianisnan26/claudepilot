// T-1646 (chat-sessions PRD FR39b): the k3s API was down for maintenance (2026-10-19, ~02:31 to 03:10 UTC) and eleven Konfersi sessions
// lost their process. (a) The main lead (top-level, marked a crew lead, in Bypass the owner entered) had no live worker, no workers limit
// and no Keep going, so `#keptLead` said "not a lead": the loss turned Bypass off for good and the resume came back in Default. Now a
// top-level crew lead keeps it for the relaunch, and the relaunch asks every gate again (a missing one leaves it out of Bypass, with a note
// naming the gate). A chat that is not a crew lead, or a worker, is unchanged. (b) The Business lead's resume hit "fetch failed" installing
// the session host and ENDED; a resume whose host can't be checked is now Interrupted, like a start that failed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPLIED, controls, init, liveSession, ok, sleep, until, type Live } from './testkit.js';

type Kind = 'crew' | 'plain' | 'worker';

/** A bypass-capable chat in Bypass entered by the person (acknowledgement and fresh code). `crew`: top-level, marked a crew lead, no
 * workers, no limit, no Keep going (the main lead on 2026-10-19). `plain`: top-level, not a lead. `worker`: marked a lead, but a worker (none can be made in Bypass today: belt and braces). */
async function inBypass(s: Live, kind: Kind) {
  s.controller.controlTimeoutMs = 1000;
  s.controller.bypassAllowed = () => true;
  s.controller.reauth = { fresh: (token) => token === 'tok' };
  const before = s.ws.tails.length;
  const created = await s.controller.create(
    { workspaceId: 'docker/ws1', ...(kind === 'plain' ? {} : { lead: true }) },
    { bypassOptIn: true },
  );
  // Only a person's own start may allow Bypass, and a worker is started by its lead: the row is made a worker of the first chat directly.
  if (kind === 'worker') s.store.db!.prepare('UPDATE chat_sessions SET parent_id = ? WHERE id = ?').run(s.id, created.id);
  await until(() => s.ws.tails.length === before + 1);
  await until(() => s.controller.get(created.id)?.state === 'idle');
  await sleep(20);
  const lead = { id: created.id, tail: s.ws.tails.at(-1)! };
  lead.tail.push(init(lead.id));
  const entering = s.controller.enterBypass(lead.id, { acknowledged: true, sessionToken: 'tok' });
  lead.tail.push(ok((await s.take('set_permission_mode')).id, { mode: 'bypassPermissions' }));
  await entering;
  assert.equal(s.controller.get(lead.id)!.mode, 'bypassPermissions');
  assert.equal(s.controller.get(lead.id)!.parentId ?? null, kind === 'worker' ? s.id : null);
  assert.equal(s.controller.list({ parentId: lead.id }).length, 0, 'no worker of its own');
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

/**
 * The outage: `unconfirmed`, the host never answers and the retries run out ("Lost touch"); `confirmed`, the host answers once more and
 * says the process is gone. Either way the process did not survive: the resume starts a new one (exit 0).
 */
async function outage(s: Live, lead: { id: string; tail: Live['tail'] }, how: 'unconfirmed' | 'confirmed') {
  if (how === 'confirmed') s.ws.alive = false;
  else s.ws.statusUnreachable = true;
  await until(() => {
    for (const t of s.ws.tails.slice(s.ws.tails.indexOf(lead.tail))) if (!t.exited) t.exit(0);
    return s.controller.get(lead.id)!.state === 'interrupted';
  }, 15_000);
  s.ws.statusUnreachable = false;
  s.ws.alive = true;
  assert.equal(s.controller.get(lead.id)!.process, 'gone');
  assert.equal(s.controller.get(lead.id)!.mode, 'default', 'the row says Bypass is not on while nothing runs');
}

/** The coordinator's resume message: a new process, every request answered. */
async function resume(s: Live, id: string) {
  const starts = s.ws.starts;
  const tails = s.ws.tails.length;
  await answering(s, s.controller.send(id, `r-${starts}`, 'go on'));
  await until(() => s.ws.tails.length > tails);
  await sleep(50);
  assert.equal(s.ws.starts, starts + 1);
  assert.equal(s.controller.get(id)!.process, 'live');
}

const notes = (s: Live, id: string) => s.controller.history(id).flatMap((e) => (e.kind === 'system' && e.text ? [e.text] : []));
const entries = (s: Live, id: string) => s.controller.audit({ kind: 'bypass.entered', sessionId: id }).map((a) => [a.actor, a.detail.how ?? null]);

for (const how of ['unconfirmed', 'confirmed'] as const)
  test(`T-1646: a top-level crew lead with no workers loses its process in Bypass (${how}): the relaunch puts Bypass back through the gates`, async () => {
    const s = await liveSession({}, true);
    try {
      const lead = await inBypass(s, 'crew');
      await outage(s, lead, how);
      assert.ok(notes(s, lead.id).includes('Bypass paused: Claude Code stopped. It comes back when the session runs again if every gate still allows it.'));
      const left = s.controller.audit({ kind: 'bypass.left', sessionId: lead.id })[0]!;
      assert.deepEqual([left.detail.why, left.detail.kept], ['stopped', true], 'kept for the relaunch');

      await resume(s, lead.id);
      const row = s.controller.get(lead.id)!;
      assert.equal(row.mode, 'bypassPermissions', notes(s, lead.id).join(' | '));
      assert.ok(notes(s, lead.id).includes('Bypass kept after Claude Code stopped.'));
      assert.deepEqual(entries(s, lead.id)[0], ['portal', 'lost'], 'put back by the portal, every gate asked again');
      const asked = controls(s.ws).filter((c) => c.request.subtype === 'set_permission_mode').map((c) => c.request.mode);
      assert.equal(asked.at(-1), 'bypassPermissions', 'through the grant: the one request that enters Bypass');
    } finally {
      await s.done();
    }
  });

test('T-1646: the same crew lead, the policy off at the relaunch: out of Bypass, and the note names the gate', async () => {
  const s = await liveSession({}, true);
  try {
    const lead = await inBypass(s, 'crew');
    await outage(s, lead, 'unconfirmed');
    const before = entries(s, lead.id).length;
    s.controller.bypassAllowed = () => false;
    await resume(s, lead.id);
    assert.equal(s.controller.get(lead.id)!.mode, 'default');
    assert.ok(notes(s, lead.id).includes('Bypass not kept after Claude Code stopped: the policy no longer allows it.'), notes(s, lead.id).join(' | '));
    assert.equal(entries(s, lead.id).length, before, 'no new entry');
    const left = s.controller.audit({ kind: 'bypass.left', sessionId: lead.id })[0]!;
    assert.deepEqual([left.detail.why, left.detail.how], ['policy', 'lost']);
  } finally {
    await s.done();
  }
});

test('T-1646: the same crew lead without the person’s own entry on record (the code was not fresh): out of Bypass, the note says so', async () => {
  const s = await liveSession({}, true);
  try {
    const lead = await inBypass(s, 'crew');
    // The person's entry is the newest one by a person; rewrite it as one without a fresh code (what a record before T-417 looks like).
    s.store.db!.prepare("UPDATE chat_audit SET detail = json_set(detail, '$.reauth', 'stale') WHERE kind = 'bypass.entered' AND session_id = ?").run(lead.id);
    await outage(s, lead, 'confirmed');
    await resume(s, lead.id);
    assert.equal(s.controller.get(lead.id)!.mode, 'default');
    assert.ok(
      notes(s, lead.id).includes(
        'Bypass not kept after Claude Code stopped: no entry by a person with the confirmation and the server code is on record for this chat.',
      ),
      notes(s, lead.id).join(' | '),
    );
    assert.deepEqual(s.controller.audit({ kind: 'bypass.left', sessionId: lead.id })[0]!.detail.why, 'not_confirmed');
  } finally {
    await s.done();
  }
});

for (const kind of ['plain', 'worker'] as const)
  test(`T-1646: a ${kind === 'plain' ? 'top-level chat that is not a lead' : 'worker marked a lead'} in Bypass, the same outage: not back in Bypass`, async () => {
    const s = await liveSession({}, true);
    try {
      const chat = await inBypass(s, kind);
      await outage(s, chat, 'confirmed');
      assert.ok(notes(s, chat.id).includes('Bypass turned off: Claude Code stopped.'), notes(s, chat.id).join(' | '));
      const left = s.controller.audit({ kind: 'bypass.left', sessionId: chat.id })[0]!;
      assert.deepEqual([left.detail.why, left.detail.kept ?? null], ['stopped', null], 'nothing kept');
      const before = entries(s, chat.id).length;
      await resume(s, chat.id);
      assert.equal(s.controller.get(chat.id)!.mode, 'default');
      assert.equal(entries(s, chat.id).length, before, 'no new entry');
      assert.ok(!notes(s, chat.id).some((n) => n.startsWith('Bypass kept')), notes(s, chat.id).join(' | '));
    } finally {
      await s.done();
    }
  });

test('T-1646 (b): a resume whose session host cannot be installed ("fetch failed") is Interrupted, not ended, and a later send resumes it', async () => {
  const s = await liveSession({}, true);
  try {
    const lead = await inBypass(s, 'crew');
    await outage(s, lead, 'confirmed');
    s.controller.installHost = () => Promise.reject(new TypeError('fetch failed'));
    await assert.rejects(s.controller.send(lead.id, 'b-1', 'go on'), /Couldn.t resume the session: fetch failed/);
    const row = s.controller.get(lead.id)!;
    assert.deepEqual([row.state, row.process, row.endedReason], ['interrupted', 'gone', 'fetch failed']);

    s.controller.installHost = async () => undefined; // the API is back
    await resume(s, lead.id);
    assert.equal(s.controller.get(lead.id)!.state === 'ended', false);
    assert.equal(s.controller.get(lead.id)!.mode, 'bypassPermissions', 'and the lead is back in Bypass through the gates');
  } finally {
    await s.done();
  }
});
