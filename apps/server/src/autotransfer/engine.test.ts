// The engine with fakes (docs/prd/auto-transfer.md §14): the turn boundary, a move and its trail, the card, the deferral to a card
// after 30 minutes, the warning once, the Undo (S17) and its 2-hour pause, a failed move pausing and a second failure leaving only cards,
// off by default. Expected values are worked out by hand: Work at 92 % used is 8 % left, under the threshold of 10.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_SETTING_KEYS as K, CHAT_FOLDER_UNTRUSTED, type NotifyEvent } from '@portal/contracts';
import '../chat/trust.js'; // registers FOLDER_UNTRUSTED
import { render } from '../notify/templates.js';
import { PlatformAudit } from '../platform/audit.js';
import { fakeOwner, freshStore } from '../notify/testkit.js';
import { AutoTransferEngine } from './engine.js';
import { AutoStore } from './store.js';
import { MoveChat, T0, at, chatSession, fakeClock, fakeUsage, settingsMap, usage, win } from './testkit.js';

const AUTO = { [K.enabled]: true, [K.automatic]: true };
const ASK = { [K.enabled]: true };

async function rig(settings: Record<string, unknown> = AUTO, claudes = () => [usage('work', 'Work', [win('session', 92)]), usage('home', 'Home', [win('session', 60)])]) {
  const { store } = await freshStore();
  const clock = fakeClock();
  const chat = new MoveChat();
  chat.sessions.set('s1', chatSession('s1'));
  const u = fakeUsage(() => claudes().map((c) => ({ ...c, checkedAt: new Date(clock.now() - 5 * 60_000).toISOString() })));
  const owner = fakeOwner({}, { fallback: 'u_a' });
  const auto = new AutoStore(store, () => new Date(clock.now()));
  const audit = new PlatformAudit(store, () => new Date(clock.now()));
  const emitted: NotifyEvent[] = [];
  const bus = { emit: (e: Omit<NotifyEvent, 'id' | 'at'>) => (emitted.push({ ...e, id: `evt_${emitted.length}`, at: new Date(clock.now()).toISOString() } as NotifyEvent), null) };
  const s = settingsMap(settings);
  let published = 0;
  const engine = new AutoTransferEngine({ chat, usage: u, owner, clock, store: auto, settings: s, bus, audit, publish: () => void published++ });
  engine.start();
  const auditRows = (kind?: string) => audit.list({ kind }, null);
  return { store, clock, chat, usage: u, owner, auto, audit, auditRows, emitted, settings: s, engine, published: () => published };
}

test('S1 end to end on fakes: a turn ends, the chat moves to Home with a handoff; one moved row with the move id, one audit row, one notification, paused 5 minutes (the T-105 default)', async () => {
  const r = await rig();
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.deepEqual(r.chat.moves, [{ id: 's1', to: 'home', handoff: 'ask' }]);
  assert.equal(r.chat.get('s1')!.id, 's1'); // one chat id across the move
  const [moved, ...rest] = r.auto.events('u_a', { session: 's1' });
  assert.equal(rest.length, 0);
  assert.equal(moved!.kind, 'moved');
  assert.equal(moved!.handoffId, 'h-1');
  assert.equal(moved!.actor, 'portal:autotransfer');
  assert.deepEqual([moved!.from, moved!.to], [{ id: 'work', name: 'Work' }, { id: 'home', name: 'Home' }]);
  assert.equal(moved!.facts!.leftPct.value, 8);
  const rows = r.auditRows('autotransfer.moved');
  assert.equal(rows.length, 1);
  assert.equal(r.emitted.length, 1);
  assert.equal(r.emitted[0]!.kind, 'auto_move');
  assert.deepEqual(r.emitted[0]!.facts, { workspace: 'api-dev', leftPct: 8, to: 'Home' });
  assert.deepEqual(r.emitted[0]!.audience, ['u_a']);
  // No message text or title anywhere in the trail.
  assert.ok(!JSON.stringify([rows, r.emitted, moved]).includes('CANARY'));
  const state = await r.engine.state('s1', 'u_a');
  assert.equal(state.pausedUntil, at(5));
  assert.equal(state.movesToday, 1);
  assert.equal(state.lastMove?.event.handoffId, 'h-1');
  assert.deepEqual(state.lastMove?.undo, { ok: true, reason: null }); // Work 92 % used: not out, so it can take the chat back
  r.engine.stop();
});

test('a sub-agent result is not a turn boundary; a burst of boundaries is one evaluation', async () => {
  const r = await rig(ASK);
  r.chat.dispatch('s1', { type: 'events', session: 's1', items: [{ seq: 9, at: at(0), kind: 'result', agentLabel: 'helper' }] });
  await r.engine.settled();
  assert.equal(r.usage.calls, 0);
  r.chat.turnEnds('s1');
  r.chat.turnEnds('s1');
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.ok(r.usage.calls <= 2, `${r.usage.calls} reads`); // the first, and at most one more for the burst
  r.engine.stop();
});

test('off by default: nothing is read and nothing moves', async () => {
  const r = await rig({});
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal(r.usage.calls, 0);
  assert.equal(r.chat.moves.length, 0);
  assert.equal(r.auto.events('u_a').length, 0);
  r.engine.stop();
});

test('S2 ask: one card, one notification; the next boundary keeps the same card; Later holds it back 20 minutes', async () => {
  const r = await rig(ASK);
  r.chat.turnEnds('s1');
  await r.engine.settled();
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 0);
  const st = await r.engine.state('s1', 'u_a');
  assert.equal(st.effectiveMode, 'ask');
  assert.equal(st.pending?.to.name, 'Home');
  assert.equal(st.pending?.facts.leftPct.value, 8);
  assert.equal(r.auto.events('u_a', { kinds: ['suggested'] }).length, 1);
  assert.equal(r.emitted.length, 1);
  assert.equal(r.emitted[0]!.facts.suggested, true);
  const later = await r.engine.answerLater(st.pending!.id, 'u_a', 'user:u_a');
  assert.equal(later.pending, null);
  assert.equal(later.pausedUntil, at(20));
  await assert.rejects(r.engine.answerLater(st.pending!.id, 'u_a', 'user:u_a'), /already answered/);
  // While paused, a boundary makes no card.
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal((await r.engine.state('s1', 'u_a')).pending, null);
  // When the pause ends the engine looks again: a new card.
  r.clock.advance(21);
  await r.engine.settled();
  assert.ok((await r.engine.state('s1', 'u_a')).pending);
  r.engine.stop();
});

test('the card: Move goes through the Move flow; "Always automatic" needs the portal to allow automatic moves', async () => {
  const r = await rig(ASK);
  r.chat.turnEnds('s1');
  await r.engine.settled();
  const sug = (await r.engine.state('s1', 'u_a')).pending!;
  await assert.rejects(r.engine.answerMove(sug.id, 'u_a', 'user:u_a', undefined, { always: true }), /without asking are off/);
  await assert.rejects(r.engine.answerMove(sug.id, 'u_a', 'user:u_a', 'spare'), /suggested/);
  await assert.rejects(r.engine.answerMove(sug.id, 'u_b', 'user:u_b'), /No such suggestion/); // another user's id is unknown
  const st = await r.engine.answerMove(sug.id, 'u_a', 'user:u_a');
  assert.equal(st.pending, null);
  await r.engine.settled();
  assert.deepEqual(r.chat.moves, [{ id: 's1', to: 'home', handoff: 'ask' }]);
  const moved = r.auto.events('u_a', { kinds: ['moved'] });
  assert.equal(moved[0]!.actor, 'user:u_a');
  assert.equal(r.emitted.length, 1); // the card's notification only: a person's own move is not announced
  r.engine.stop();
});

test('Always automatic sets this chat to auto (not the global mode) and moves now', async () => {
  const r = await rig({ [K.enabled]: true, [K.automatic]: true });
  r.auto.setPrefs('u_a', { mode: 'ask', thresholdPct: null, useProjection: null, sameModelOnly: null, allowApiKey: null });
  r.chat.turnEnds('s1');
  await r.engine.settled();
  const sug = (await r.engine.state('s1', 'u_a')).pending!;
  assert.ok(sug);
  const st = await r.engine.answerMove(sug.id, 'u_a', 'user:u_a', undefined, { always: true });
  assert.equal(st.mode, 'auto');
  assert.equal(st.effectiveMode, 'auto');
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 1);
  assert.equal(r.auto.prefs('u_a').mode, 'ask');
  assert.equal(r.auto.events('u_a', { kinds: ['mode_set'] }).length, 1);
  r.engine.stop();
});

test('S14 on the engine: an approval is open: waits (one deferred row), looks again every minute, after 30 minutes a card that says what it drops', async () => {
  const r = await rig();
  r.chat.dropped = { approvals: 1, queued: 0, agents: 0 };
  r.chat.handoffOk = false;
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 0);
  assert.equal(r.auto.events('u_a', { kinds: ['deferred'] }).length, 1);
  for (let i = 0; i < 29; i++) {
    r.clock.advance(1);
    await r.engine.settled();
  }
  assert.equal(r.auto.events('u_a', { kinds: ['deferred'] }).length, 1);
  assert.equal((await r.engine.state('s1', 'u_a')).pending, null);
  r.clock.advance(1); // 30 minutes
  await r.engine.settled();
  const card = (await r.engine.state('s1', 'u_a')).pending;
  assert.ok(card);
  assert.deepEqual(card.dropped, { approvals: 1, queued: 0, agents: 0 });
  assert.equal(card.handoff, 'skip');
  assert.equal(r.chat.moves.length, 0);
  r.engine.stop();
});

test('the approval answered before 30 minutes: the next look moves', async () => {
  const r = await rig();
  r.chat.dropped = { approvals: 1, queued: 0, agents: 0 };
  r.chat.turnEnds('s1');
  await r.engine.settled();
  r.chat.dropped = { approvals: 0, queued: 0, agents: 0 };
  r.clock.advance(1);
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 1);
  r.engine.stop();
});

test('S9/FR10 on the engine: no Claude to move to warns once per window period, with one notification', async () => {
  const r = await rig(AUTO, () => [usage('work', 'Work', [win('session', 92)]), usage('home', 'Home', [win('session', 95)])]);
  for (let i = 0; i < 3; i++) {
    r.chat.turnEnds('s1');
    await r.engine.settled();
  }
  assert.equal(r.auto.events('u_a', { kinds: ['warned'] }).length, 1);
  assert.equal(r.auto.events('u_a', { kinds: ['warned'] })[0]!.code, 'no_destination');
  assert.equal(r.emitted.length, 1);
  assert.equal(r.emitted[0]!.facts.warned, true);
  assert.equal(r.chat.moves.length, 0);
  r.engine.stop();
});

test('S17: the owner moves the chat back to Work 10 minutes after an automatic move: undone, no automatic move for 120 minutes', async () => {
  const r = await rig();
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 1);
  r.clock.advance(10);
  r.chat.personMoves('s1', 'work');
  const undone = r.auto.events('u_a', { kinds: ['undone'] });
  assert.equal(undone.length, 1);
  assert.equal(undone[0]!.handoffId, 'h-1');
  const st = await r.engine.state('s1', 'u_a');
  assert.equal(st.pausedUntil, at(10 + 120));
  // Work is still at 92 %: a boundary within the 2 hours moves nothing.
  r.clock.advance(100);
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 1);
  assert.equal(r.engine.last.get('s1')?.act === 'none' && (r.engine.last.get('s1') as { code: string }).code, 'paused');
  r.engine.stop();
});

test('a person moving the chat on to a third Claude is not an Undo', async () => {
  const r = await rig();
  r.chat.turnEnds('s1');
  await r.engine.settled();
  r.chat.personMoves('s1', 'spare');
  assert.equal(r.auto.events('u_a', { kinds: ['undone'] }).length, 0);
  r.engine.stop();
});

test('FR14: a failed move leaves the chat where it was, records failed, pauses; a second failure that day leaves only a card', async () => {
  const r = await rig();
  r.chat.fail = 'The session host couldn’t start Home.';
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal(r.chat.get('s1')!.claudeId, 'work');
  assert.equal(r.auto.events('u_a', { kinds: ['failed'] }).length, 1);
  assert.equal(r.auto.events('u_a', { kinds: ['failed'] })[0]!.code, 'move_failed');
  assert.equal((await r.engine.state('s1', 'u_a')).pausedUntil, at(5));
  r.clock.advance(6); // the pause ends: the engine looks again and fails again
  await r.engine.settled();
  assert.equal(r.auto.events('u_a', { kinds: ['failed'] }).length, 2);
  r.clock.advance(6);
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 2); // no third attempt by itself
  const st = await r.engine.state('s1', 'u_a');
  assert.ok(st.pending, 'a card remains possible');
  r.engine.stop();
});

const EXHAUSTED = () => [usage('work', 'Work', [win('session', 100)]), usage('home', 'Home', [win('session', 60)])];

async function conflictRig(claudes = EXHAUSTED) {
  const r = await rig(AUTO, claudes);
  r.chat.fail = 'This session can’t take it now.';
  r.chat.failCode = 'CONFLICT';
  return r;
}

test('T-781: a CONFLICT on an exhausted chat retries in 30 s, moves, is not a failure, and its message is logged', async () => {
  const r = await conflictRig();
  r.chat.failTimes = 1;
  const logged: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(' '));
  try {
    r.chat.turnEnds('s1');
    await r.engine.settled();
    assert.equal(r.chat.moves.length, 1);
    assert.equal(r.chat.get('s1')!.claudeId, 'work');
    // R4: the retry leaves one info row in the trail (`deferred`, `busy`).
    assert.deepEqual(r.auto.events('u_a', { kinds: ['deferred'] }).map((e) => e.code), ['busy']);
    r.clock.advance(0.49); // not yet
    await r.engine.settled();
    assert.equal(r.chat.moves.length, 1);
    r.clock.advance(0.02); // 30 s
    await r.engine.settled();
  } finally {
    console.error = orig;
  }
  assert.equal(r.chat.moves.length, 2);
  assert.equal(r.chat.get('s1')!.claudeId, 'home');
  assert.equal(r.auto.events('u_a', { kinds: ['failed'] }).length, 0, 'a CONFLICT is not a failure');
  assert.ok(logged.some((l) => l.includes('can’t take it now')), 'the message is logged');
  r.engine.stop();
});

test('T-781: a CONFLICT on a source that is only low keeps the normal pause (minPauseMin)', async () => {
  const r = await conflictRig(() => [usage('work', 'Work', [win('session', 92)]), usage('home', 'Home', [win('session', 60)])]);
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal(r.auto.events('u_a', { kinds: ['failed'] }).length, 1);
  assert.equal((await r.engine.state('s1', 'u_a')).pausedUntil, at(5));
  r.clock.advance(1);
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 1, 'no retry at 30 s or 1 min');
  r.engine.stop();
});

test('T-781: after a CONFLICT a chat moved by someone else is re-evaluated: no second move', async () => {
  const r = await conflictRig();
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 1);
  r.chat.personMoves('s1', 'spare');
  r.chat.fail = null;
  r.clock.advance(0.6);
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 1);
  assert.equal(r.chat.get('s1')!.claudeId, 'spare');
  r.engine.stop();
});

test('T-781: the CONFLICT retries are capped at 5, then the failure is recorded with the pause', async () => {
  const r = await conflictRig();
  const orig = console.error;
  console.error = () => {};
  try {
    r.chat.turnEnds('s1');
    await r.engine.settled();
    // Stop at the first recorded failure (a tick may add an attempt on its own; each attempt counts the same).
    for (let i = 0; i < 10 && !r.auto.events('u_a', { kinds: ['failed'] }).length; i++) {
      r.clock.advance(0.51);
      await r.engine.settled();
    }
  } finally {
    console.error = orig;
  }
  assert.equal(r.auto.events('u_a', { kinds: ['failed'] }).length, 1);
  assert.equal(r.chat.moves.length, 6, 'the first try and five retries, then the failure');
  assert.ok((await r.engine.state('s1', 'u_a')).pausedUntil, 'the normal pause is set');
  r.engine.stop();
});

test('T-781: the CONFLICT count is forgotten when the chat ends: a chat of the same id starts again at zero (no growth, no inherited cap)', async () => {
  const r = await conflictRig();
  const orig = console.error;
  console.error = () => {};
  try {
    r.chat.turnEnds('s1'); // one CONFLICT counted
    await r.engine.settled();
    assert.equal(r.chat.moves.length, 1);
    r.chat.ends('s1');
    await r.engine.settled();
    r.chat.turnEnds('s1'); // the same id again, idle
    await r.engine.settled();
    for (let i = 0; i < 12 && !r.auto.events('u_a', { kinds: ['failed'] }).length; i++) {
      r.clock.advance(0.51);
      await r.engine.settled();
    }
  } finally {
    console.error = orig;
  }
  assert.equal(r.auto.events('u_a', { kinds: ['failed'] }).length, 1);
  assert.equal(r.chat.moves.length, 7, 'one attempt before the end, then the first try and five retries from zero');
  r.engine.stop();
});

test('T-781: a deleted chat (a `removed` message) reaches the same forgetting: a new chat of that id starts at zero', async () => {
  const r = await conflictRig();
  const orig = console.error;
  console.error = () => {};
  try {
    r.chat.turnEnds('s1'); // one CONFLICT counted
    await r.engine.settled();
    assert.equal(r.chat.moves.length, 1);
    r.chat.removes('s1');
    await r.engine.settled();
    r.chat.sessions.set('s1', chatSession('s1'));
    r.chat.turnEnds('s1');
    await r.engine.settled();
    for (let i = 0; i < 12 && !r.auto.events('u_a', { kinds: ['failed'] }).length; i++) {
      r.clock.advance(0.51);
      await r.engine.settled();
    }
  } finally {
    console.error = orig;
  }
  assert.equal(r.chat.moves.length, 7, 'one attempt before the removal, then the first try and five retries from zero');
  r.engine.stop();
});

test('T-781: a successful move clears the CONFLICT count: a new exhausted episode gets the full five retries', async () => {
  const r = await conflictRig();
  r.chat.failTimes = 3;
  const orig = console.error;
  console.error = () => {};
  try {
    r.chat.turnEnds('s1'); // 3 CONFLICTs, then the 4th try moves
    await r.engine.settled();
    for (let i = 0; i < 10 && r.chat.get('s1')!.claudeId === 'work'; i++) {
      r.clock.advance(0.51);
      await r.engine.settled();
    }
    assert.equal(r.chat.get('s1')!.claudeId, 'home');
    assert.equal(r.chat.moves.length, 4);
    // A new episode: the chat is back on the exhausted Claude and the moves conflict again.
    r.chat.personMoves('s1', 'work');
    r.chat.fail = 'This session can’t take it now.';
    r.chat.failCode = 'CONFLICT';
    r.chat.turnEnds('s1');
    await r.engine.settled();
    for (let i = 0; i < 12 && !r.auto.events('u_a', { kinds: ['failed'] }).length; i++) {
      r.clock.advance(0.51);
      await r.engine.settled();
    }
  } finally {
    console.error = orig;
  }
  assert.equal(r.auto.events('u_a', { kinds: ['failed'] }).length, 1);
  assert.equal(r.chat.moves.length, 10, 'four before, then the first try and five retries (a stale count of 3 would stop at 7)');
  r.engine.stop();
});

test('T-781: inside the 30 s retry window the tick adds no attempt', async () => {
  const r = await conflictRig();
  const orig = console.error;
  console.error = () => {};
  try {
    r.chat.turnEnds('s1');
    await r.engine.settled();
    assert.equal(r.chat.moves.length, 1);
    await r.engine.tick(); // what the 2-minute tick does
    await r.engine.settled();
    assert.equal(r.chat.moves.length, 1, 'the tick waits for the retry timer');
    r.chat.fail = null;
    r.clock.advance(0.51); // the retry timer still works after a blocked tick
    await r.engine.settled();
  } finally {
    console.error = orig;
  }
  assert.equal(r.chat.moves.length, 2);
  assert.equal(r.chat.get('s1')!.claudeId, 'home');
  r.engine.stop();
});

const STUCK = (over: Parameters<typeof chatSession>[1] = {}) => chatSession('s1', { state: 'working', ...over });

test('T-781 hard move: exhausted, still working, no stored event for 3 minutes: the turn is stopped and the chat moves with the handoff skipped, then continues', async () => {
  const r = await rig(AUTO, EXHAUSTED);
  r.chat.sessions.set('s1', STUCK());
  r.chat.stored('s1', [{ at: at(-4) }]); // the limit message, 4 minutes ago on the fake clock
  await r.engine.evaluate('s1');
  await r.engine.settled();
  assert.deepEqual(r.chat.interrupted, ['s1']);
  assert.deepEqual(r.chat.moves, [{ id: 's1', to: 'home', handoff: 'skip' }]);
  assert.equal(r.chat.get('s1')!.claudeId, 'home');
  assert.equal(r.auto.events('u_a', { kinds: ['moved'] })[0]!.reason, 'exhausted');
  assert.equal(r.chat.sent.length, 1, 'told to continue after the move');
  r.engine.stop();
});

test('T-781 hard move: with an event 1 minute ago it waits (and is steered); once 3 minutes are quiet it moves', async () => {
  const r = await rig(AUTO, EXHAUSTED);
  r.chat.sessions.set('s1', STUCK());
  r.chat.stored('s1', [{ at: at(-1) }]);
  await r.engine.evaluate('s1');
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 0, 'an event a minute ago: the turn may still be going');
  assert.equal(r.chat.interrupted.length, 0);
  r.clock.advance(2.1); // 3.1 minutes since the last event; the engine looks again every minute
  await r.engine.settled();
  assert.deepEqual(r.chat.interrupted, ['s1']);
  assert.equal(r.chat.moves.length, 1);
  assert.equal(r.chat.moves[0]!.handoff, 'skip');
  r.engine.stop();
});

test('T-781 hard move: only for an exhausted source: a working chat that is merely low keeps waiting for its boundary, however quiet', async () => {
  const r = await rig(AUTO);
  r.chat.sessions.set('s1', STUCK());
  r.chat.stored('s1', [{ at: at(-30) }]);
  await r.engine.evaluate('s1');
  await r.engine.settled();
  assert.equal(r.chat.interrupted.length, 0);
  assert.equal(r.chat.moves.length, 0);
  r.engine.stop();
});

test('T-781 hard move: an exhausted chat that is idle moves as before, with no interrupt', async () => {
  const r = await rig(AUTO, EXHAUSTED);
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 1);
  assert.equal(r.chat.interrupted.length, 0);
  r.engine.stop();
});

/** An exhausted rig whose usage read runs `between` once: it happens after the chat was read and before the decision is acted on. */
async function hardRig(between: (r: Awaited<ReturnType<typeof rig>>) => void) {
  let ran = false;
  let rr: Awaited<ReturnType<typeof rig>> | null = null;
  const r = await rig(AUTO, () => {
    if (!ran && rr) {
      ran = true;
      between(rr);
    }
    return EXHAUSTED();
  });
  rr = r;
  r.chat.sessions.set('s1', STUCK());
  r.chat.stored('s1', [{ at: at(-4) }]);
  return r;
}

test('T-781 F1\': a person moves the chat between the decision and the stop: no interrupt and no move', async () => {
  const r = await hardRig((x) => x.chat.personMoves('s1', 'spare'));
  await r.engine.evaluate('s1');
  await r.engine.settled();
  assert.equal(r.chat.interrupted.length, 0);
  assert.equal(r.chat.moves.length, 0);
  assert.equal(r.chat.get('s1')!.claudeId, 'spare');
  r.engine.stop();
});

test('T-781 F1\': the chat speaks again between the decision and the stop (the turn is alive): no interrupt and no move', async () => {
  const r = await hardRig((x) => x.chat.stored('s1', [{ at: at(-4) }, { at: at(0) }]));
  await r.engine.evaluate('s1');
  await r.engine.settled();
  assert.equal(r.chat.interrupted.length, 0);
  assert.equal(r.chat.moves.length, 0);
  r.engine.stop();
});

test('T-781 F1\': the chat was restarted (no longer working) between the decision and the stop: no interrupt', async () => {
  const r = await hardRig((x) => x.chat.sessions.set('s1', { ...x.chat.get('s1')!, state: 'interrupted' }));
  await r.engine.evaluate('s1');
  await r.engine.settled();
  assert.equal(r.chat.interrupted.length, 0);
  r.engine.stop();
});

test('T-781: a person moves the chat while the stop is waited for: the move is not overridden', async () => {
  const r = await rig(AUTO, EXHAUSTED);
  r.chat.sessions.set('s1', STUCK());
  r.chat.stored('s1', [{ at: at(-4) }]);
  (r.chat as { interrupt: unknown }).interrupt = async () => {
    r.chat.personMoves('s1', 'spare');
  };
  await r.engine.evaluate('s1');
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 0);
  assert.equal(r.chat.get('s1')!.claudeId, 'spare');
  r.engine.stop();
});

test('T-781: a stop that never settles is given 30 s, then the chat moves anyway', async () => {
  const r = await rig(AUTO, EXHAUSTED);
  r.chat.sessions.set('s1', STUCK());
  r.chat.stored('s1', [{ at: at(-4) }]);
  (r.chat as { interrupt: unknown }).interrupt = () => new Promise<void>(() => {});
  const orig = console.error;
  console.error = () => {};
  try {
    const p = r.engine.evaluate('s1');
    await new Promise((res) => setImmediate(res));
    assert.equal(r.chat.moves.length, 0, 'still waiting for the stop');
    r.clock.advance(0.49);
    await new Promise((res) => setImmediate(res));
    assert.equal(r.chat.moves.length, 0, 'not yet 30 s');
    r.clock.advance(0.02);
    await p;
    await r.engine.settled();
  } finally {
    console.error = orig;
  }
  assert.deepEqual(r.chat.moves, [{ id: 's1', to: 'home', handoff: 'skip' }]);
  r.engine.stop();
});

test('T-781: a stop that rejects does not block the move', async () => {
  const r = await rig(AUTO, EXHAUSTED);
  r.chat.sessions.set('s1', STUCK());
  r.chat.stored('s1', [{ at: at(-4) }]);
  (r.chat as { interrupt: unknown }).interrupt = async () => {
    throw new Error('control request failed');
  };
  const orig = console.error;
  console.error = () => {};
  try {
    await r.engine.evaluate('s1');
    await r.engine.settled();
  } finally {
    console.error = orig;
  }
  assert.deepEqual(r.chat.moves, [{ id: 's1', to: 'home', handoff: 'skip' }]);
  r.engine.stop();
});

test('T-781: an interrupt that throws synchronously does not block the move', async () => {
  const r = await rig(AUTO, EXHAUSTED);
  r.chat.sessions.set('s1', STUCK());
  r.chat.stored('s1', [{ at: at(-4) }]);
  (r.chat as { interrupt: unknown }).interrupt = () => {
    throw new Error('no control channel');
  };
  const orig = console.error;
  console.error = () => {};
  try {
    await r.engine.evaluate('s1');
    await r.engine.settled();
  } finally {
    console.error = orig;
  }
  assert.deepEqual(r.chat.moves, [{ id: 's1', to: 'home', handoff: 'skip' }]);
  r.engine.stop();
});

test('T-781: a chat that is switching is not hard-moved, however quiet', async () => {
  const r = await rig(AUTO, EXHAUSTED);
  r.chat.sessions.set('s1', STUCK({ switching: { toClaude: 'home', step: 'starting' } }));
  r.chat.stored('s1', [{ at: at(-30) }]);
  await r.engine.evaluate('s1');
  await r.engine.settled();
  assert.equal(r.chat.interrupted.length, 0);
  assert.equal(r.chat.moves.length, 0);
  r.engine.stop();
});

test('T-781: an exhausted working chat with no stored event is not hard-moved', async () => {
  const r = await rig(AUTO, EXHAUSTED);
  r.chat.sessions.set('s1', STUCK());
  await r.engine.evaluate('s1');
  await r.engine.settled();
  assert.equal(r.chat.interrupted.length, 0);
  assert.equal(r.chat.moves.length, 0);
  r.engine.stop();
});

test('T-781 S5: a continuation that fails (the chat just restarted) is tried again after 15 s and arrives; the trail has one `continued` row', async () => {
  const r = await rig(AUTO, EXHAUSTED);
  r.chat.sendFails = 1;
  const orig = console.error;
  console.error = () => {};
  try {
    r.chat.turnEnds('s1');
    await r.engine.settled();
    assert.equal(r.chat.moves.length, 1);
    assert.equal(r.chat.sent.length, 0, 'the first attempt failed');
    r.clock.advance(0.2); // 12 s: not yet
    await r.engine.settled();
    assert.equal(r.chat.sendTries, 1);
    r.clock.advance(0.1); // 18 s
    await r.engine.settled();
  } finally {
    console.error = orig;
  }
  assert.equal(r.chat.sent.length, 1, 'the continuation arrived');
  assert.equal(r.chat.sent[0]!.actor, 'portal:autotransfer');
  assert.match(r.chat.sent[0]!.text, /Continue where you stopped/);
  assert.equal(r.auto.events('u_a', { kinds: ['continued'] }).length, 1);
  r.engine.stop();
});

test('T-781 S5: at most 3 attempts to continue, then it stops (no pause, no failed row)', async () => {
  const r = await rig(AUTO, EXHAUSTED);
  r.chat.sendFails = 99;
  const orig = console.error;
  console.error = () => {};
  try {
    r.chat.turnEnds('s1');
    await r.engine.settled();
    for (let i = 0; i < 6; i++) {
      r.clock.advance(0.26);
      await r.engine.settled();
    }
  } finally {
    console.error = orig;
  }
  assert.equal(r.chat.sendTries, 3);
  assert.equal(r.chat.sent.length, 0);
  assert.equal(r.auto.events('u_a', { kinds: ['failed'] }).length, 0);
  r.engine.stop();
});

test('T-781 S5: no retry of the continuation once the chat is on another Claude or has ended', async () => {
  for (const how of ['moved', 'ended'] as const) {
    const r = await rig(AUTO, EXHAUSTED);
    r.chat.sendFails = 1;
    const orig = console.error;
    console.error = () => {};
    try {
      r.chat.turnEnds('s1');
      await r.engine.settled();
      if (how === 'moved') r.chat.personMoves('s1', 'spare');
      else r.chat.ends('s1');
      r.clock.advance(0.3);
      await r.engine.settled();
    } finally {
      console.error = orig;
    }
    assert.equal(r.chat.sent.length, 0, `nothing sent after ${how}`);
    assert.equal(r.chat.sendTries, 1, `no second attempt after ${how}`);
    r.engine.stop();
  }
});

test('T-781 R5: with no destination ceiling for an exhausted source, a herd still spreads (fewest chats on a tie)', async () => {
  const two = () => [usage('work', 'Work', [win('session', 100)]), usage('home', 'Home', [win('session', 60)]), usage('spare', 'Spare', [win('session', 60)])];
  const r = await rig({ ...AUTO, [K.maxPerDestination]: 1 }, two);
  r.chat.sessions.set('s2', chatSession('s2'));
  r.chat.sessions.set('s3', chatSession('s3'));
  r.chat.sessions.set('s4', chatSession('s4'));
  for (const id of ['s1', 's2', 's3', 's4']) {
    r.chat.turnEnds(id);
    await r.engine.settled();
  }
  assert.equal(r.chat.moves.length, 4, 'the ceiling of 1 does not stop an exhausted chat');
  const per = (to: string) => r.chat.moves.filter((m) => m.to === to).length;
  assert.deepEqual([per('home'), per('spare')], [2, 2], 'ties go to the Claude with the fewest chats: no herd on one');
  assert.ok(r.chat.moves.every((m) => m.to !== 'work'));
  // The ping-pong guard for a forced source is the decide.test.ts case "the ping-pong guard (FR9) still refuses an exhausted source the Claude it just left".
  r.engine.stop();
});

test('T-38: a move refused because the folder needs trusting again is recorded as such and notified (not a silent stall)', async () => {
  const r = await rig();
  r.chat.fail = 'This folder’s project settings changed since you trusted it. Check them and trust it again.';
  r.chat.failCode = CHAT_FOLDER_UNTRUSTED;
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal(r.chat.get('s1')!.claudeId, 'work');
  assert.deepEqual(r.auto.events('u_a', { kinds: ['failed'] }).map((e) => e.code), ['folder_untrusted']);
  assert.equal(r.emitted.length, 1);
  assert.deepEqual(r.emitted[0]!.facts, { workspace: 'api-dev', leftPct: 8, to: 'Home', blocked: 'trust' });
  const shown = render(r.emitted[0]!);
  assert.equal(shown.title, 'Move blocked');
  assert.match(shown.body, /trust the folder again/);
  // Any other failure stays move_failed, with no notification.
  const other = await rig();
  other.chat.fail = 'The session host couldn’t start Home.';
  other.chat.turnEnds('s1');
  await other.engine.settled();
  assert.deepEqual(other.auto.events('u_a', { kinds: ['failed'] }).map((e) => e.code), ['move_failed']);
  assert.equal(other.emitted.length, 0);
  r.engine.stop();
  other.engine.stop();
});

test('S12 on the engine: after two moves in a day the chat is refused (session_cap), recorded once', async () => {
  const r = await rig({ ...AUTO, [K.maxPerSessionPerDay]: 2 });
  for (const [from, to] of [
    ['work', 'home'],
    ['home', 'work'],
  ]) {
    r.auto.addEvent({ userId: 'u_a', sessionId: 's1', workspaceId: 'docker/api-dev', kind: 'moved', mode: 'auto', reason: 'low', from: { id: from!, name: from! }, to: { id: to!, name: to! }, facts: null, handoff: 'ask', handoffId: null, code: null, actor: 'portal:autotransfer', at: at(-300) });
  }
  r.chat.turnEnds('s1');
  await r.engine.settled();
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 0);
  const refused = r.auto.events('u_a', { kinds: ['refused'] });
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.code, 'session_cap');
  r.engine.stop();
});

test('S13 on the engine: Bypass in auto: a card, never a move', async () => {
  const r = await rig();
  r.chat.sessions.set('s1', chatSession('s1', { mode: 'bypassPermissions' }));
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 0);
  assert.ok((await r.engine.state('s1', 'u_a')).pending);
  r.engine.stop();
});

test('S13b on the engine: Bypass in auto with automove.allowBypass: moved by itself, through the Move flow that keeps Bypass', async () => {
  const r = await rig({ [K.enabled]: true, [K.automatic]: true, [K.allowBypass]: true });
  r.chat.sessions.set('s1', chatSession('s1', { mode: 'bypassPermissions' }));
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.deepEqual(r.chat.moves, [{ id: 's1', to: 'home', handoff: 'ask' }]);
  assert.equal((await r.engine.state('s1', 'u_a')).pending, null);
  assert.equal(r.auto.events('u_a', { kinds: ['moved'] }).length, 1);
  r.engine.stop();
});

test('T-29 on the engine: only the Opus week is low and the platform prefers the same Claude: the model changes in place, no move; Undo is offered until it is back', async () => {
  const r = await rig({ [K.enabled]: true, [K.automatic]: true, [K.modelFallback]: 'sonnet', [K.keepModelFirst]: false }, () => [
    usage('work', 'Work', [win('session', 40), win('week', 50), win('week_opus', 95)]),
    usage('home', 'Home', [win('session', 30), win('week', 40), win('week_opus', 20)]),
  ]);
  r.chat.sessions.set('s1', chatSession('s1', { model: 'claude-opus-4-1', mode: 'bypassPermissions' }));
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.deepEqual(r.chat.models, [{ id: 's1', model: 'sonnet' }]);
  assert.deepEqual(r.chat.moves, [], 'no move');
  assert.equal(r.chat.get('s1')!.mode, 'bypassPermissions', 'the permission mode is untouched');
  const moved = r.auto.events('u_a', { kinds: ['moved'] });
  assert.equal(moved.length, 1);
  assert.deepEqual([moved[0]!.from?.model, moved[0]!.to?.model, moved[0]!.to?.id], ['opus', 'sonnet', 'work']);
  const st = await r.engine.state('s1', 'u_a');
  assert.deepEqual(st.lastMove?.undo, { ok: true, reason: null });
  r.chat.sessions.set('s1', { ...r.chat.get('s1')!, model: 'claude-opus-4-1' });
  assert.deepEqual((await r.engine.state('s1', 'u_a')).lastMove?.undo, { ok: false, reason: 'Already back.' });
  r.engine.stop();
});

test('the card closes when the source recovers above the threshold, and when the chat ends', async () => {
  let used = 92;
  const r = await rig(ASK, () => [usage('work', 'Work', [win('session', used)]), usage('home', 'Home', [win('session', 60)])]);
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.ok((await r.engine.state('s1', 'u_a')).pending);
  used = 50; // the window reset
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal((await r.engine.state('s1', 'u_a')).pending, null);
  used = 92;
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.ok((await r.engine.state('s1', 'u_a')).pending);
  const ended = { ...r.chat.get('s1')!, state: 'ended' as const };
  r.chat.sessions.set('s1', ended);
  r.chat.dispatch('s1', { type: 'session', session: ended });
  assert.equal(r.auto.openSuggestion('s1'), null);
  r.engine.stop();
});

test('S19 on the engine: the owner may not use Home: nothing moves; another user sees no card and no trail', async () => {
  const { store } = await freshStore();
  const clock = fakeClock();
  const chat = new MoveChat();
  chat.sessions.set('s1', chatSession('s1'));
  const u = fakeUsage(() => [usage('work', 'Work', [win('session', 92)]), usage('home', 'Home', [win('session', 60)])]);
  // u_a owns the chat and Work; Home belongs to u_b.
  const owner = fakeOwner({ 'session:s1': 'u_a', 'claude:work': 'u_a', 'claude:home': 'u_b' });
  const auto = new AutoStore(store, () => new Date(clock.now()));
  const engine = new AutoTransferEngine({ chat, usage: u, owner, clock, store: auto, settings: settingsMap(ASK), bus: null, audit: null, publish: () => {} });
  engine.start();
  chat.turnEnds('s1');
  await engine.settled();
  assert.equal(chat.moves.length, 0);
  assert.equal(auto.events('u_a', { kinds: ['warned'] }).length, 1);
  assert.equal(auto.events('u_b').length, 0);
  engine.stop();
  void T0;
});
