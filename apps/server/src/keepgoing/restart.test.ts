// Keep going slice 2 on a fake clock (T-259; T-257 items 1-4): an ENDED chat is brought back. An integrity ending is first recovered in
// place (T-136, as an agent); a refusal, or any other ending, starts a new chat that continues it (`continuedFrom`, the policy's prompt, the
// policy carried over); the starts are capped per root cause over the lineage and kept 5 minutes apart; a chat left down (the cap, a failed
// start, 15 minutes still ended) is reported at once, once; a closed ticket stands it down; the Home card's list and its live topic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import { CHAT_RECOVER_CAPPED, CHAT_RECOVER_PAUSED, CHAT_RECOVER_SUSPICIOUS, KEEPGOING_ACTOR, KEEPGOING_RESTART_CAPS, type ChatSession } from '@portal/contracts';
import { continuationBrief } from './engine.js';
import { rig } from './testkit.js';

type Rig = Awaited<ReturnType<typeof rig>>;

const harmless = { reason: 'a second control response for request r1', classified: 'harmless' as const, case: 'control-duplicate', origin: 'the stream read twice' };
const suspicious = { reason: 'a message this portal didn’t send reached Claude Code', classified: 'suspicious' as const, case: 'replay-unknown', origin: 'unknown origin' };

/** Ends a chat: an integrity ending (harmless or suspicious) or any other. */
function end(r: Rig, id: string, kind: 'harmless' | 'suspicious' | 'other'): void {
  if (kind === 'other') return r.chat.patch(id, { state: 'ended', process: 'gone', endedReason: 'the process exited (code 1)', endedFor: null });
  const f = kind === 'harmless' ? harmless : suspicious;
  r.chat.patch(id, { state: 'ended', process: 'gone', endedReason: `integrity: ${f.reason}`, endedFor: f });
}

/** The newest chat of the lineage (the last one started, or the first). */
const head = (r: Rig, first: string): string => r.chat.started.at(-1)?.id ?? first;

test('an integrity ending is recovered in place first (as the portal, an agent); no ticket and no push; the chat runs again', async () => {
  const r = await rig();
  r.chat.put('s1', { ticketId: 'T-9' });
  r.on('s1');
  end(r, 's1', 'harmless');
  await r.engine.round();
  assert.deepEqual(r.chat.recovered, ['s1']);
  assert.equal(r.chat.started.length, 0, 'no new chat when it came back in place');
  assert.equal(r.engine.view('s1')!.last?.kind, 'recovered');
  assert.equal(r.engine.view('s1')!.last?.reason, 'Ended for integrity (harmless): recovered in place.');
  assert.equal(r.tickets.made.length, 0);
  assert.equal(r.emitted.length, 0);
  assert.equal(r.auditRows('keepgoing.recovered').length, 1);
  // Running again: the quiet mark is cleared on the next look.
  r.chat.patch('s1', { state: 'idle', process: 'live' });
  await r.after(1);
  assert.deepEqual(r.kg.standing('s1'), []);
});

test('a refused recover (the cap, a suspicious line) starts a new chat that continues it: the brief, the policy carried over, the old one off', async () => {
  const r = await rig();
  r.chat.put('s1', { ticketId: 'T-9', bypassCapable: true, mode: 'bypassPermissions', title: 'Orchestrator: dev' });
  r.on('s1', { prompt: 'Read {status} and go on with {ticket}.', statusFile: 'docs/status.md', nudgeAfterMin: 7 });
  end(r, 's1', 'suspicious');
  r.chat.recoverError = new AppError(CHAT_RECOVER_SUSPICIOUS as never, 'Only a person can bring this session back.', { status: 403 });
  await r.engine.round();
  assert.deepEqual(r.chat.recovered, ['s1']);
  assert.equal(r.engine.view('s1')!.last?.kind, 'recover_refused');
  assert.match(r.engine.view('s1')!.last!.reason, /RECOVER_SUSPICIOUS/);
  assert.equal(r.chat.started.length, 0, 'one decision per round');
  await r.after(1);
  assert.equal(r.chat.recovered.length, 1, 'not asked again for the same ending');
  assert.equal(r.chat.started.length, 1);
  const fresh = r.chat.get(r.chat.started[0]!.id)!;
  assert.equal(fresh.continuedFrom, 's1');
  assert.equal(fresh.ticketId, 'T-9');
  assert.equal(fresh.title, 'Orchestrator: dev');
  assert.equal(fresh.bypassCapable, false, 'never bypass-capable: only a person opts in');
  // The brief: which chat it continues and why, then the policy's own prompt with its placeholders filled; priority later, as the portal.
  const brief = r.chat.sent.find((m) => m.id === fresh.id)!;
  assert.equal(brief.actor, KEEPGOING_ACTOR);
  assert.equal(brief.priority, 'later');
  assert.ok(brief.text.startsWith('This chat continues the chat s1, which ended (integrity: a message this portal didn’t send reached Claude Code)'));
  assert.ok(brief.text.endsWith('Read docs/status.md and go on with T-9.'));
  // The policy went with it; the ended chat's is off; the trail says what happened and that Bypass did not come along.
  const moved = r.engine.view(fresh.id)!;
  assert.equal(moved.enabled, true);
  assert.equal(moved.nudgeAfterMin, 7);
  assert.equal(moved.prompt, 'Read {status} and go on with {ticket}.');
  assert.equal(moved.last?.kind, 'set');
  assert.match(moved.last!.reason, /^Carried over from s1/);
  const old = r.engine.view('s1')!;
  assert.equal(old.enabled, false);
  assert.equal(old.last?.kind, 'restarted');
  assert.match(old.last!.reason, /^Ended \(integrity\): started again as s1-n1\. It starts in the default mode/);
  assert.equal(r.auditRows('keepgoing.restarted').length, 1);
  assert.equal(r.tickets.made.length, 0, 'brought back: nothing to report');
  assert.equal(r.emitted.length, 0);
  // The sweep looks at the new chat from now on, and never at the old one again.
  await r.after(1);
  assert.equal(r.chat.started.length, 1);
});

test('a recover that must wait (the pause) is tried again on the next round; still ended 15 minutes on is reported once as left down', async () => {
  const r = await rig();
  r.chat.put('s1');
  r.on('s1');
  end(r, 's1', 'harmless');
  r.chat.recoverError = new AppError(CHAT_RECOVER_PAUSED as never, 'Recovered a moment ago.', { status: 409 });
  await r.engine.round();
  for (let i = 0; i < 14; i++) await r.after(1);
  assert.equal(r.chat.recovered.length, 15, 'asked every round, never refused');
  assert.equal(r.chat.started.length, 0);
  assert.equal(r.tickets.made.length, 0);
  await r.after(1); // 15 minutes after the mark
  assert.equal(r.tickets.made.length, 1);
  assert.match(r.tickets.made[0]!.description, /Left down because: still ended 15 minutes after Keep going saw it end/);
  assert.equal(r.emitted.length, 1);
  // The attempts go on; once it comes back, the next look clears the report, and a later stop is reported again.
  r.chat.recoverError = null;
  await r.after(1);
  assert.equal(r.chat.get('s1')!.state, 'interrupted');
  r.chat.patch('s1', { state: 'idle', process: 'live' });
  await r.after(1);
  assert.deepEqual(r.kg.standing('s1'), []);
  assert.equal(r.emitted.length, 1);
});

test('any other ending starts a new chat at once (no recover); a refused start is reported as left down at once, retried after the back-off', async () => {
  const r = await rig();
  r.chat.put('s1');
  r.on('s1');
  end(r, 's1', 'other');
  r.chat.failCreate = 'CHAT_INELIGIBLE';
  await r.engine.round();
  assert.equal(r.chat.recovered.length, 0, 'only an integrity ending is recovered in place');
  assert.equal(r.tickets.made.length, 1, 'left down: reported at once (T-257 item 1)');
  assert.match(r.tickets.made[0]!.description, /a new chat could not be started \(CHAT_INELIGIBLE\)/);
  assert.equal(r.engine.view('s1')!.standing!.includes('down'), true);
  r.chat.failCreate = null;
  for (let i = 0; i < 14; i++) await r.after(1);
  assert.equal(r.chat.started.length, 0, 'backs off 15 minutes');
  await r.after(1);
  assert.equal(r.chat.started.length, 1);
  assert.equal(r.tickets.comments.length, 1, 'its open ticket says where it went on');
  assert.match(r.tickets.comments[0]!.text, /^Started again: the chat s1-n1 continues it/);
  assert.deepEqual(r.kg.standing('s1'), [], 'the ended chat’s reports are cleared');
  assert.equal(r.emitted.length, 1, 'one push only');
});

test('the cap is per root cause over the lineage: harmless endings count only for themselves; the next start waits 5 minutes; capped: one ticket', async () => {
  const r = await rig();
  r.chat.put('s1');
  r.on('s1');
  // Harmless integrity endings whose recover is refused (the recover cap): they make new chats, and do not count against the chat's own cap.
  r.chat.recoverError = new AppError(CHAT_RECOVER_CAPPED as never, 'Recovered too often today.', { status: 409 });
  const restartAfter = async (kind: 'harmless' | 'suspicious' | 'other') => {
    const before = r.chat.started.length;
    end(r, head(r, 's1'), kind);
    for (let i = 0; i < 10 && r.chat.started.length === before; i++) await r.after(1);
    return r.chat.started.length > before;
  };
  for (let i = 0; i < 4; i++) assert.ok(await restartAfter('harmless'), `harmless start ${i + 1}`);
  // The suspicious integrity cap (3) counts every start that was not after a harmless ending: none yet.
  for (let i = 0; i < KEEPGOING_RESTART_CAPS.integrity; i++) assert.ok(await restartAfter('suspicious'), `integrity start ${i + 1}`);
  const n = r.chat.started.length;
  assert.equal(n, 4 + KEEPGOING_RESTART_CAPS.integrity);
  assert.equal(r.tickets.made.length, 0);
  // One more integrity ending: capped, reported at once on the head chat; nothing more is started.
  assert.equal(await restartAfter('suspicious'), false);
  assert.equal(r.tickets.made.length, 1);
  assert.match(r.tickets.made[0]!.description, /the cap: 3 new chats in 24 hours after integrity endings \(at most 3\)/);
  assert.equal(r.emitted.length, 1);
  for (let i = 0; i < 30; i++) await r.after(1);
  assert.equal(r.chat.started.length, n, 'left for a person');
  assert.equal(r.emitted.length, 1, 'not repeated');
});

test('starts of one lineage are at least 5 minutes apart, and the cap survives a portal restart (it is read from the trail)', async () => {
  const r = await rig();
  r.chat.put('s1');
  r.on('s1');
  end(r, 's1', 'other');
  await r.engine.round();
  assert.equal(r.chat.started.length, 1);
  end(r, head(r, 's1'), 'other'); // the new chat ends at once
  for (let i = 0; i < 4; i++) await r.after(1);
  assert.equal(r.chat.started.length, 1, 'the gap');
  await r.after(1);
  assert.equal(r.chat.started.length, 2);
  // A portal restart: a new engine over the same store and chats. Four more starts reach the cap of 6 for other endings.
  const again = await rig({ store: r.store, clock: r.clock, chat: r.chat, tickets: r.tickets });
  for (let k = 0; k < 4; k++) {
    end(again, head(again, 's1'), 'other');
    for (let i = 0; i < 6; i++) await again.after(1);
  }
  assert.equal(r.chat.started.length, KEEPGOING_RESTART_CAPS.other);
  end(again, head(again, 's1'), 'other');
  for (let i = 0; i < 10; i++) await again.after(1);
  assert.equal(r.chat.started.length, KEEPGOING_RESTART_CAPS.other, 'capped after the restart too');
  assert.equal(again.tickets.made.length, 1);
});

test('a chat whose ticket is closed is not started again (done): the policy stands down; an archived one too', async () => {
  const r = await rig();
  const t = r.tickets.create({ type: 'bug', priority: 'high', tags: [], summary: 'work', description: '', workspaceId: null });
  r.tickets.close(t.id);
  r.chat.put('s1', { ticketId: t.id });
  r.on('s1');
  end(r, 's1', 'other');
  await r.engine.round();
  assert.equal(r.chat.started.length, 0);
  assert.equal(r.engine.view('s1')!.enabled, false);
  assert.match(r.engine.view('s1')!.last!.reason, /Its ticket is closed/);
  r.chat.put('s2', { archivedAt: new Date(r.clock.now()).toISOString() });
  r.on('s2');
  end(r, 's2', 'other');
  await r.after(1);
  assert.equal(r.chat.started.length, 0);
  assert.equal(r.engine.view('s2')!.enabled, false);
});

test('a start whose brief does not go through still carries the policy; the new chat is told to continue at its next look', async () => {
  const r = await rig();
  r.chat.put('s1');
  r.on('s1');
  end(r, 's1', 'other');
  const real = r.chat.send.bind(r.chat);
  let fail = true;
  r.chat.send = (async (id: string, uuid: string, text: string, o: { priority: 'later'; actor: string }) => {
    if (fail && id !== 's1') throw new AppError('SERVICE_UNAVAILABLE', 'down');
    return real(id, uuid, text, o);
  }) as typeof r.chat.send;
  await r.engine.round();
  const fresh = r.chat.started[0]!.id;
  assert.equal(r.engine.view(fresh)!.enabled, true);
  assert.equal(r.engine.view(fresh)!.last?.kind, 'failed');
  fail = false;
  await r.after(1);
  assert.equal(r.chat.sent.filter((m) => m.id === fresh).length, 1, 'the continue owed goes at once');
});

test('the Home card: the chats with Keep going on, a cause standing first; the live topic hears an action and a change of state', async () => {
  const r = await rig();
  r.chat.put('a', { title: 'Alpha' });
  r.chat.put('b', { title: 'Beta' });
  r.chat.put('c', { title: 'Gamma' });
  r.on('a');
  r.on('b');
  await r.engine.round();
  const firstPublishes = r.published.length;
  assert.ok(firstPublishes >= 1, 'a first look is a change');
  r.chat.waitFor('b', { requestId: 'r1' });
  for (let i = 0; i < 11; i++) await r.after(1);
  const list = r.engine.list(() => true);
  assert.deepEqual(
    list.chats.map((c) => c.sessionId),
    ['b', 'a'],
  );
  assert.deepEqual(list.chats[0]!.keepGoing.standing, ['approval']);
  assert.equal(list.chats[0]!.state, 'waiting');
  assert.equal(list.chats[1]!.state, 'working', 'a was nudged and works');
  assert.ok(r.published.length > firstPublishes);
  // Only what the caller may see.
  assert.deepEqual(
    r.engine.list((s: ChatSession) => s.id === 'a').chats.map((c) => c.sessionId),
    ['a'],
  );
  const quiet = r.published.length;
  await r.after(1);
  await r.after(1);
  assert.equal(r.published.length, quiet, 'nothing changed: nothing published');
});

test('the continuation brief redacts and clips the ended reason to one line', () => {
  const secretish = ['sk', 'ant', 'api03', 'x'.repeat(40)].join('-');
  const t = continuationBrief({ prompt: null, statusFile: null }, { id: 's9', endedReason: `crashed\nwith ${secretish}`, ticketId: null });
  assert.ok(!t.includes(secretish), 'no key-shaped text');
  assert.ok(t.split('\n')[0]!.includes('crashed with'));
  assert.ok(t.includes('docs/dev-sessions/status/orchestrator.md'), 'the default prompt and status file');
});
