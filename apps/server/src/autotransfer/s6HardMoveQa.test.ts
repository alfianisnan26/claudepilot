// QA T-781 S6 (lane-cp-qa-perf): the hard move of a stuck chat on an exhausted Claude: re-check before the stop, a stop that fails or never ends, the
// 3-minute silence edge, and the history read behind it (F2). Written before the run, NOT run when committed. Expected values: T-781 comments 7946
// and 7939 and the code at ff51fd8d (the S6 head when written). The builder's flips (person move, new event, restart), sync throw and the plain
// cases in engine.test.ts are not repeated. A line "GAP" in a message names an expected failure on that head.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import { AUTO_SETTING_KEYS as K, type NotifyEvent } from '@portal/contracts';
import '../chat/trust.js';
import { PlatformAudit } from '../platform/audit.js';
import { fakeOwner, freshStore } from '../notify/testkit.js';
import { AutoTransferEngine } from './engine.js';
import { AutoStore } from './store.js';
import { MoveChat, T0, at, chatSession, fakeClock, fakeUsage, settingsMap, usage, win } from './testkit.js';

const AUTO = { [K.enabled]: true, [K.automatic]: true };
const EXHAUSTED = () => [usage('work', 'Work', [win('session', 100)]), usage('home', 'Home', [win('session', 60)])];
const LOW = () => [usage('work', 'Work', [win('session', 92)]), usage('home', 'Home', [win('session', 60)])];
const STUCK = (over: Parameters<typeof chatSession>[1] = {}) => chatSession('s1', { state: 'working', ...over });
const iso = (ms: number) => new Date(ms).toISOString();

// Copied from engine.test.ts (test files cannot import each other).
async function rig(settings: Record<string, unknown> = AUTO, claudes: () => ReturnType<typeof usage>[] = LOW) {
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
  const engine = new AutoTransferEngine({ chat, usage: u, owner, clock, store: auto, settings: settingsMap(settings), bus, audit, publish: () => undefined });
  engine.start();
  return { clock, chat, usage: u, auto, engine };
}
type Rig = Awaited<ReturnType<typeof rig>>;

/** An exhausted rig whose usage read runs `between` once: after the chat was read, before the decision is acted on. */
async function hardRig(between: (r: Rig) => void, silenceMs = 4 * 60_000) {
  let ran = false;
  let rr: Rig | null = null;
  const r = await rig(AUTO, () => {
    if (!ran && rr) { ran = true; between(rr); }
    return EXHAUSTED();
  });
  rr = r;
  r.chat.sessions.set('s1', STUCK());
  r.chat.stored('s1', [{ at: iso(T0 - silenceMs) }]);
  return r;
}
const setInterrupt = (r: Rig, fn: unknown) => { (r.chat as unknown as { interrupt: unknown }).interrupt = fn; };

test('QA-S6-b0 positive control: no flip, silent 4 minutes: interrupted [s1], one move with the handoff skipped', async () => {
  const r = await hardRig(() => undefined);
  assert.equal(r.clock.now(), T0, 'the fake clock starts at T0 (the silence arithmetic below relies on it)');
  await r.engine.evaluate('s1');
  await r.engine.settled();
  assert.deepEqual(r.chat.interrupted, ['s1']);
  assert.deepEqual(r.chat.moves, [{ id: 's1', to: 'home', handoff: 'skip' }]);
  r.engine.stop();
});

test('QA-S6-b1 between the decision and the stop: the chat starts switching, ends, or goes idle: no stop (and no move, except that an idle chat may take the normal path)', async () => {
  const flips: [string, (x: Rig) => void][] = [
    ['switching', (x) => x.chat.sessions.set('s1', { ...x.chat.get('s1')!, switching: { toClaude: 'home', step: 'starting' } as never })],
    ['ended', (x) => x.chat.sessions.set('s1', { ...x.chat.get('s1')!, state: 'ended' })],
    ['idle', (x) => x.chat.sessions.set('s1', { ...x.chat.get('s1')!, state: 'idle' })],
  ];
  for (const [name, flip] of flips) {
    const r = await hardRig(flip);
    await r.engine.evaluate('s1');
    await r.engine.settled();
    assert.deepEqual(r.chat.interrupted, [], `${name}: no turn is stopped`);
    if (name !== 'idle') assert.equal(r.chat.moves.length, 0, `${name}: no move`);
    r.engine.stop();
  }
});

test('QA-S6-b2 re-check after the stop: a person moves the chat while interrupt is running: the engine does not move it again', async () => {
  const r = await hardRig(() => undefined);
  setInterrupt(r, async (id: string) => { r.chat.interrupted.push(id); r.chat.personMoves('s1', 'spare'); });
  await r.engine.evaluate('s1');
  await r.engine.settled();
  assert.deepEqual(r.chat.interrupted, ['s1']);
  assert.equal(r.chat.moves.length, 0, 'the chat is on Spare now; the engine must not move it to Home');
  assert.equal(r.chat.get('s1')!.claudeId, 'spare');
  r.engine.stop();
});

test('QA-S6-b3 interrupt rejects with CONFLICT: the move still happens, handoff skipped, once', async () => {
  const r = await hardRig(() => undefined);
  setInterrupt(r, async (id: string) => { r.chat.interrupted.push(id); throw new AppError('CONFLICT', 'The session is not running.'); });
  await r.engine.evaluate('s1');
  await r.engine.settled();
  assert.deepEqual(r.chat.moves, [{ id: 's1', to: 'home', handoff: 'skip' }]);
  assert.equal(r.auto.events('u_a', { kinds: ['moved'] }).length, 1, 'one moved row');
  r.engine.stop();
});

test('QA-S6-b4 interrupt never settles: the move still happens (fake clock +5 minutes, or 1.5 s real). GAP expected on ff51fd8d: the engine awaits with no limit', async () => {
  const r = await hardRig(() => undefined);
  setInterrupt(r, () => new Promise<void>(() => undefined));
  void r.engine.evaluate('s1');
  r.clock.advance(5);
  await new Promise((res) => setTimeout(res, 1_500));
  assert.equal(r.chat.moves.length, 1, 'a stop that hangs must not leave the chat stuck on the exhausted Claude');
  r.engine.stop();
});

test('QA-S6-b5 a controller with no interrupt (the port is absent): no crash; the chat is moved or left, never moved twice', async () => {
  const r = await hardRig(() => undefined);
  setInterrupt(r, undefined);
  await r.engine.evaluate('s1');
  await r.engine.settled();
  console.log(`QA-S6-b5 no interrupt port -> moves=${JSON.stringify(r.chat.moves)}`);
  assert.ok(r.chat.moves.length <= 1, 'at most one move');
  r.engine.stop();
});

test('QA-S6-d1 the silence edge, in milliseconds: 179000 and 179999 wait; 180000 and 180001 stop and move once', async () => {
  for (const ms of [179_000, 179_999]) {
    const r = await hardRig(() => undefined, ms);
    await r.engine.evaluate('s1');
    await r.engine.settled();
    assert.deepEqual(r.chat.interrupted, [], `${ms} ms of silence: not yet`);
    assert.equal(r.chat.moves.length, 0, `${ms} ms: no move`);
    r.engine.stop();
  }
  for (const ms of [180_000, 180_001]) {
    const r = await hardRig(() => undefined, ms);
    await r.engine.evaluate('s1');
    await r.engine.settled();
    assert.deepEqual(r.chat.interrupted, ['s1'], `${ms} ms of silence: stop`);
    assert.equal(r.chat.moves.length, 1, `${ms} ms: one move`);
    r.engine.stop();
  }
});

test('QA-S6-e1 F2: a source that is merely low (92%) and working, silent 30 minutes: no history read for the silence, no interrupt, no move', async () => {
  const r = await rig(AUTO, LOW);
  r.chat.sessions.set('s1', STUCK());
  r.chat.stored('s1', [{ at: at(-30) }]);
  const calls: { id: string; after: number | undefined }[] = [];
  const hist = r.chat.history.bind(r.chat);
  r.chat.history = (id: string, after?: number) => { calls.push({ id, after }); return hist(id, after); };
  await r.engine.evaluate('s1');
  await r.engine.settled();
  assert.deepEqual(r.chat.interrupted, []);
  assert.equal(r.chat.moves.length, 0);
  assert.deepEqual(calls.filter((c) => c.id === 's1'), [], `a chat that is only low has no reason to read history: ${JSON.stringify(calls)}`);
  r.engine.stop();
});

test('QA-S6-e2 F2: exhausted and working, but lastSeq is missing or 0: no history read from the start (after missing or 0), no interrupt', async () => {
  for (const lastSeq of [undefined, 0] as const) {
    const r = await rig(AUTO, EXHAUSTED);
    r.chat.sessions.set('s1', STUCK());
    r.chat.stored('s1', [{ at: at(-30) }]);
    r.chat.sessions.set('s1', { ...r.chat.get('s1')!, lastSeq: lastSeq as never });
    const calls: { id: string; after: number | undefined }[] = [];
    const hist = r.chat.history.bind(r.chat);
    r.chat.history = (id: string, after?: number) => { calls.push({ id, after }); return hist(id, after); };
    await r.engine.evaluate('s1');
    await r.engine.settled();
    assert.deepEqual(r.chat.interrupted, [], `lastSeq=${lastSeq}: nothing to measure a silence from`);
    assert.ok(calls.filter((c) => c.id === 's1').every((c) => typeof c.after === 'number' && c.after > 0), `lastSeq=${lastSeq}: history was read from the start: ${JSON.stringify(calls)}`);
    r.engine.stop();
  }
});
