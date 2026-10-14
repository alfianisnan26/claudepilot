// D-39 (owner, 2026-10-13; T-105): auto move respects pace. At the threshold a chat moves only when its Claude's projected use at the
// next reset is at least `automove.paceMinPct` (90); under that it stays and the trail says so once, with its numbers. Used up: always at
// once. No confident projection (one reading, a short span): the threshold alone decides, and the trail says so. A working chat with
// sub-agents: one steer, the move at the turn end, the continuation, and no second move within the pause. On the fake clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_SETTING_KEYS as K, estimatedFigure, unavailableFigure, type ClaudeUsage, type ClaudeUsageWindow, type WindowPace } from '@portal/contracts';
import { fakeOwner, freshStore } from '../notify/testkit.js';
import { decisionLine, AutoTransferEngine } from './engine.js';
import { AutoStore } from './store.js';
import { MoveChat, at, chatSession, fakeClock, fakeUsage, settingsMap, usage, win } from './testkit.js';

const AUTO = { [K.enabled]: true, [K.automatic]: true };

/** The pace the usage summary shows for a window: projected `projectedPct` at the reset; `lowConfidence` for one reading or a short span. */
function pace(projectedPct: number, lowConfidence = false): WindowPace {
  return {
    speed: estimatedFigure(1),
    projectedPct: estimatedFigure(projectedPct),
    etaAt: projectedPct >= 100 ? estimatedFigure(at(100)) : unavailableFigure('no_reading'),
    status: estimatedFigure(projectedPct >= 100 ? 'over' : 'under'),
    evenPct: estimatedFigure(50),
    aheadPts: estimatedFigure(0),
    readings: lowConfidence ? 1 : 12,
    spanMin: lowConfidence ? 0 : 120,
    method: lowConfidence ? null : 'least_squares',
    lowConfidence,
  };
}
const paced = (key: string, used: number, p: WindowPace | undefined): ClaudeUsageWindow => ({ ...win(key, used), ...(p ? { pace: p } : {}) });

async function rig(source: ClaudeUsageWindow[], session: Parameters<typeof chatSession>[1] = {}, others: Record<string, ClaudeUsageWindow[]> = { home: [win('session', 50)] }) {
  const { store } = await freshStore();
  const clock = fakeClock();
  const chat = new MoveChat();
  chat.sessions.set('s1', chatSession('s1', session));
  const windows: Record<string, ClaudeUsageWindow[]> = { work: source, ...others };
  const names: Record<string, string> = { work: 'Work', home: 'Home', spare: 'Spare' };
  const claudes = (): ClaudeUsage[] => Object.entries(windows).map(([id, w]) => ({ ...usage(id, names[id]!, w), checkedAt: new Date(clock.now() - 60_000).toISOString() }));
  const auto = new AutoStore(store, () => new Date(clock.now()));
  const usageFake = fakeUsage(claudes);
  const engine = new AutoTransferEngine({ chat, usage: usageFake, owner: fakeOwner({}, { fallback: 'u_a' }), clock, store: auto, settings: settingsMap(AUTO), bus: null, audit: null, publish: () => {} });
  engine.start();
  const rows = () => auto.events('u_a', { session: 's1', limit: 200 }).reverse();
  return {
    chat,
    engine,
    usage: usageFake,
    windows,
    rows,
    async tick(min = 3) {
      clock.advance(min);
      await new Promise((r) => setImmediate(r));
      await engine.settled();
    },
  };
}

test('D-39: projected 85 % at the reset with 8 % left does NOT move; the hold is said once, with its numbers', async () => {
  const r = await rig([paced('session', 92, pace(85))]);
  await r.tick();
  await r.tick();
  assert.equal(r.chat.moves.length, 0);
  const held = r.rows().filter((e) => e.kind === 'refused');
  assert.equal(held.length, 1, 'once per window period, not every tick');
  const f = held[0]!.facts!;
  assert.equal(held[0]!.code, 'pace_under');
  assert.deepEqual([f.leftPct.value, f.thresholdPct, f.projectedPct?.value, f.pace?.verdict, f.pace?.minPct, f.resetsAt.value], [8, 10, 85, 'under', 90, at(180)]);
  assert.match(decisionLine(held[0]!), /^refused session=s1 from=Work left=8% resets=\S+ projected=85% threshold=10% pace=under\(min 90%\) to=- reason=low code=pace_under$/);
  r.engine.stop();
});

test('D-39: projected 92 % with 8 % left moves; the move row carries the projection and the destination', async () => {
  const r = await rig([paced('session', 92, pace(92))]);
  await r.tick();
  assert.deepEqual(r.chat.moves.map((m) => m.to), ['home']);
  const moved = r.rows().find((e) => e.kind === 'moved')!;
  assert.deepEqual([moved.facts?.projectedPct?.value, moved.facts?.pace?.verdict, moved.to?.name], [92, 'over', 'Home']);
  assert.match(decisionLine(moved), /left=8% .*projected=92% threshold=10% pace=over\(min 90%\) to=Home reason=low/);
  r.engine.stop();
});

test('D-39: a used-up Claude moves at once, whatever its projection', async () => {
  const r = await rig([paced('session', 100, pace(60))]);
  await r.tick();
  assert.deepEqual(r.chat.moves.map((m) => [m.to, m.handoff]), [['home', 'skip']]);
  assert.equal(r.rows().find((e) => e.kind === 'moved')?.reason, 'exhausted');
  r.engine.stop();
});

test('D-39: no confident projection (one reading) falls back to the threshold rule and says so; no pace at all, the same', async () => {
  const one = await rig([paced('session', 92, pace(40, true))]);
  await one.tick();
  assert.deepEqual(one.chat.moves.map((m) => m.to), ['home'], 'the low-confidence 40 % is not trusted: 8 % left moves');
  const f = one.rows().find((e) => e.kind === 'moved')!.facts!;
  assert.deepEqual([f.pace?.verdict, f.projectedPct ?? null], ['unavailable', null]);
  one.engine.stop();
  const none = await rig([paced('session', 92, undefined)]);
  await none.tick();
  assert.equal(none.chat.moves.length, 1);
  assert.equal(none.rows().find((e) => e.kind === 'moved')!.facts!.pace?.verdict, 'unavailable');
  none.engine.stop();
});

test('D-39: "Respect pace" off: the threshold rule alone, as before', async () => {
  const r = await rig([paced('session', 92, pace(85))]);
  (r.engine as unknown as { stop(): void }).stop();
  const { store } = await freshStore();
  const clock = fakeClock();
  const chat = new MoveChat();
  chat.sessions.set('s1', chatSession('s1'));
  const claudes = (): ClaudeUsage[] => [
    { ...usage('work', 'Work', [paced('session', 92, pace(85))]), checkedAt: new Date(clock.now() - 60_000).toISOString() },
    { ...usage('home', 'Home', [win('session', 50)]), checkedAt: new Date(clock.now() - 60_000).toISOString() },
  ];
  const engine = new AutoTransferEngine({ chat, usage: fakeUsage(claudes), owner: fakeOwner({}, { fallback: 'u_a' }), clock, store: new AutoStore(store, () => new Date(clock.now())), settings: settingsMap({ ...AUTO, [K.respectPace]: false }), bus: null, audit: null, publish: () => {} });
  engine.start();
  clock.advance(3);
  await new Promise((res) => setImmediate(res));
  await engine.settled();
  assert.deepEqual(chat.moves.map((m) => m.to), ['home']);
  engine.stop();
});

test('D-39 with T-105: a working chat with sub-agents at 8 % left, projected 97 %: one steer, moved once at the turn end, the continuation, no second move within the pause', async () => {
  const r = await rig([paced('session', 92, pace(97))], { state: 'working', agentsRunning: 3 }, { home: [win('session', 50)], spare: [win('session', 40)] });
  r.chat.dropped = { approvals: 0, queued: 0, agents: 3 };
  await r.tick();
  await r.tick();
  assert.equal(r.chat.moves.length, 0, 'never mid-turn');
  assert.equal(r.chat.sent.length, 1, 'one message');
  assert.match(r.chat.sent[0]!.text, /commit and push your work and every sub-agent's work in progress, put one line per role on your status ticket if you keep one, then stop\. The portal moves this chat to (\S+) at the end of this turn; after the move, start again the sub-agents and roles it interrupted\.$/);
  r.chat.dropped = { approvals: 0, queued: 0, agents: 0 };
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 1);
  assert.equal(r.chat.moves[0]!.handoff, 'skip', 'steered first: the move skips the handoff');
  const to = r.chat.moves[0]!.to;
  assert.ok(r.chat.sent[0]!.text.includes(`to ${to === 'home' ? 'Home' : 'Spare'} at the end`), 'the steer named where it goes');
  assert.equal(r.chat.sent.length, 2);
  assert.match(r.chat.sent[1]!.text, /^Moved to (Home|Spare) by the portal \(as announced\)\. Continue where you stopped/);
  // The new Claude now runs low too, on pace to run out: within the 5-minute pause nothing moves again.
  r.windows[to] = [paced('session', 95, pace(99))];
  r.chat.turnEnds('s1');
  await r.engine.settled();
  await r.tick(1);
  await r.tick(1);
  assert.equal(r.chat.moves.length, 1, 'no second move within the pause');
  assert.deepEqual(
    r.rows().filter((e) => ['steered', 'moved', 'continued'].includes(e.kind)).map((e) => e.kind),
    ['steered', 'moved', 'continued'],
  );
  r.engine.stop();
});

test('D-39 not latched: 8 % left, projected 85 stays (one pace_under row over many polls); the next poll projects 93 and the idle chat moves at once', async () => {
  const r = await rig([paced('session', 92, pace(85))]);
  await r.tick();
  for (let i = 0; i < 3; i++) {
    r.usage.reading();
    await r.tick(0.5); // a usage poll, before the next 2-minute tick
  }
  await r.tick();
  assert.equal(r.chat.moves.length, 0, 'under 90 % projected: the chat stays');
  assert.deepEqual(r.rows().map((e) => [e.kind, e.code]), [['refused', 'pace_under']], 'the hold is said once, not once per poll');
  // The pace climbs: the very next poll moves it, no turn boundary, no tick, no pause from the hold.
  r.windows.work = [paced('session', 92, pace(93))];
  r.usage.reading();
  await r.tick(0.5);
  assert.deepEqual(r.chat.moves, [{ id: 's1', to: 'home', handoff: 'ask' }]);
  const moved = r.rows().at(-1)!;
  assert.equal(moved.kind, 'moved');
  assert.deepEqual([moved.facts?.leftPct.value, moved.facts?.projectedPct?.value, moved.facts?.pace?.verdict, moved.facts?.thresholdPct, moved.facts?.resetsAt.value, moved.to?.name, moved.reason], [8, 93, 'over', 10, at(180), 'Home', 'low']);
  r.engine.stop();
});

test('D-39 not latched, working chat with sub-agents: held at 85, then at 93 on the next poll: the steer at once, the move at the turn end with the handoff skipped, the continuation', async () => {
  const r = await rig([paced('session', 92, pace(85))], { state: 'working', agentsRunning: 2 });
  r.chat.dropped = { approvals: 0, queued: 0, agents: 2 };
  await r.tick();
  r.usage.reading();
  await r.tick(0.5);
  assert.equal(r.chat.sent.length, 0, 'held: no steer');
  r.windows.work = [paced('session', 92, pace(93))];
  r.usage.reading();
  await r.tick(0.5);
  assert.equal(r.chat.sent.length, 1, 'the steer, on that poll');
  assert.match(r.chat.sent[0]!.text, /^Your Claude \(Work\) is at 8% left: .*put one line per role on your status ticket if you keep one, then stop\. The portal moves this chat to Home at the end of this turn; after the move, start again the sub-agents and roles it interrupted\.$/);
  const steered = r.rows().find((e) => e.kind === 'steered')!;
  assert.match(decisionLine(steered), /^steered session=s1 from=Work left=8% resets=\S+ projected=93% threshold=10% pace=over\(min 90%\) to=Home reason=low code=busy$/);
  r.chat.dropped = { approvals: 0, queued: 0, agents: 0 };
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.deepEqual(r.chat.moves, [{ id: 's1', to: 'home', handoff: 'skip' }]);
  assert.equal(r.chat.sent.length, 2);
  assert.match(r.chat.sent[1]!.text, /^Moved to Home by the portal \(as announced\)\./);
  assert.deepEqual(r.rows().map((e) => e.kind), ['refused', 'deferred', 'steered', 'moved', 'continued']);
  r.engine.stop();
});
