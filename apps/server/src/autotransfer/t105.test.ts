// T-105: auto move PROVEN on the fake clock. R1 at the threshold (10 % left moves, 11 % does not), from the tick as well as at a boundary;
// R2 an exhausted source moves at once, pause and caps or not, the ping-pong guard kept; R3 no destination: the chat waits (one row), is
// looked at again by itself with no turn boundary, moves when a Claude frees up or stops waiting when its own window resets; a portal restart
// in the middle; R4 Bypass and a running sub-agent (told once to finish and stop, moved at the boundary, then told to continue); dry run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_SETTING_KEYS as K, type ClaudeUsage } from '@portal/contracts';
import { fakeOwner, freshStore } from '../notify/testkit.js';
import { AutoTransferEngine } from './engine.js';
import { AutoStore } from './store.js';
import { MoveChat, at, chatSession, fakeClock, fakeUsage, settingsMap, usage, win } from './testkit.js';

const AUTO = { [K.enabled]: true, [K.automatic]: true };

async function rig(opts: { settings?: Record<string, unknown>; used: Record<string, number>; session?: Parameters<typeof chatSession>[1] }) {
  const { store } = await freshStore();
  const clock = fakeClock();
  const chat = new MoveChat();
  chat.sessions.set('s1', chatSession('s1', opts.session));
  const used = { ...opts.used };
  const names: Record<string, string> = { work: 'Work', home: 'Home', spare: 'Spare' };
  const claudes = (): ClaudeUsage[] =>
    Object.entries(used).map(([id, pct]) => ({ ...usage(id, names[id]!, [win('session', pct)]), checkedAt: new Date(clock.now() - 60_000).toISOString() }));
  const u = fakeUsage(claudes);
  const owner = fakeOwner({}, { fallback: 'u_a' });
  const auto = new AutoStore(store, () => new Date(clock.now()));
  const settings = settingsMap({ ...AUTO, ...opts.settings });
  const make = () => new AutoTransferEngine({ chat, usage: u, owner, clock, store: auto, settings, bus: null, audit: null, publish: () => {} });
  let engine = make();
  engine.start();
  const kinds = () => auto.events('u_a', { session: 's1', limit: 200 }).map((e) => e.kind).reverse();
  return {
    clock,
    chat,
    auto,
    used,
    usage: u,
    get engine() {
      return engine;
    },
    restart() {
      engine.stop();
      engine = make();
      engine.start();
    },
    kinds,
    /** Lets the tick (every 2 minutes, jittered) run, then waits for the evaluations it queued. */
    async tick(min = 3) {
      this.clock.advance(min);
      await new Promise((r) => setImmediate(r));
      await engine.settled();
    },
  };
}

test('R1: at 10 % left an idle chat moves at the next tick, with no turn boundary; at 11 % nothing happens', async () => {
  const at11 = await rig({ used: { work: 89, home: 50 } });
  await at11.tick();
  await at11.tick();
  assert.equal(at11.chat.moves.length, 0);
  assert.deepEqual(at11.kinds(), []);
  at11.engine.stop();

  const at10 = await rig({ used: { work: 90, home: 50 } });
  await at10.tick();
  assert.deepEqual(at10.chat.moves, [{ id: 's1', to: 'home', handoff: 'ask' }]);
  assert.deepEqual(at10.kinds(), ['moved']);
  assert.equal(at10.chat.sent.length, 0, 'a move at a quiet moment needs no continuation: nothing was interrupted');
  at10.engine.stop();
});

test('R2: an exhausted source moves at once although paused, over the per-chat cap, and keeps away from the Claude it just left; then the chat is told to continue', async () => {
  const r = await rig({ used: { work: 100, home: 60, spare: 40 }, settings: { [K.maxPerSessionPerDay]: 1 } });
  // Two minutes ago the chat came to Work from Spare (a counted move: the cap of 1 is used, the 5-minute pause runs).
  r.auto.addEvent({ userId: 'u_a', sessionId: 's1', workspaceId: 'docker/api-dev', kind: 'moved', mode: 'auto', reason: 'low', from: { id: 'spare', name: 'Spare' }, to: { id: 'work', name: 'Work' }, facts: null, handoff: 'ask', handoffId: null, code: null, actor: 'portal:autotransfer', at: at(-2) });
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.deepEqual(r.chat.moves, [{ id: 's1', to: 'home', handoff: 'skip' }], 'to Home, never back to Spare; no handoff from an exhausted Claude');
  assert.equal(r.chat.sent.length, 1);
  assert.match(r.chat.sent[0]!.text, /^Moved to Home by the portal \(the Claude you were on ran out of quota\)\. Continue where you stopped, and start again the sub-agents and roles the move interrupted\.$/);
  assert.equal(r.chat.sent[0]!.priority, 'next');
  assert.equal(r.chat.sent[0]!.actor, 'portal:autotransfer');
  assert.deepEqual(r.kinds().slice(-2), ['moved', 'continued']);
  r.engine.stop();
});

test('R2: forced moves do not count against the caps', async () => {
  const r = await rig({ used: { work: 95, home: 60 }, settings: { [K.maxPerSessionPerDay]: 1 } });
  r.auto.addEvent({ userId: 'u_a', sessionId: 's1', workspaceId: 'docker/api-dev', kind: 'moved', mode: 'auto', reason: 'exhausted', from: { id: 'spare', name: 'Spare' }, to: { id: 'work', name: 'Work' }, facts: null, handoff: 'skip', handoffId: null, code: null, actor: 'portal:autotransfer', at: at(-60) });
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 1, 'the earlier move was forced: the cap of 1 is still free');
  r.engine.stop();
});

test('R3: nowhere to go: one waiting row, looked at again by itself; a Claude frees up and the chat moves with no turn boundary in between', async () => {
  const r = await rig({ used: { work: 95, home: 95 } });
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.deepEqual(r.kinds(), ['waiting', 'warned']);
  let st = await r.engine.state('s1', 'u_a');
  assert.equal(st.waiting?.code, 'no_destination');
  assert.equal(st.waiting?.nextFreeAt, at(180), 'the soonest reset among the delegated Claudes');
  await r.tick();
  await r.tick();
  assert.deepEqual(r.kinds(), ['waiting', 'warned'], 'said once');
  r.used.home = 40;
  await r.tick();
  assert.deepEqual(r.chat.moves, [{ id: 's1', to: 'home', handoff: 'ask' }]);
  assert.deepEqual(r.kinds(), ['waiting', 'warned', 'resumed', 'moved']);
  st = await r.engine.state('s1', 'u_a');
  assert.equal(st.waiting, null);
  r.engine.stop();
});

test('R3: nowhere to go, then the source window resets: the wait ends, nothing moves', async () => {
  const r = await rig({ used: { work: 95, home: 95 } });
  r.chat.turnEnds('s1');
  await r.engine.settled();
  r.used.work = 3;
  await r.tick();
  assert.equal(r.chat.moves.length, 0);
  assert.deepEqual(r.kinds(), ['waiting', 'warned', 'resumed']);
  assert.equal((await r.engine.state('s1', 'u_a')).waiting, null);
  r.engine.stop();
});

test('R3: a portal restart while waiting: the new engine picks the wait up and moves when a Claude frees up', async () => {
  const r = await rig({ used: { work: 95, home: 95 } });
  r.chat.turnEnds('s1');
  await r.engine.settled();
  r.restart();
  r.used.home = 40;
  await r.tick(0);
  assert.deepEqual(r.chat.moves, [{ id: 's1', to: 'home', handoff: 'ask' }]);
  r.engine.stop();
});

test('R4: a long turn with a sub-agent running crosses the threshold: told once to finish and stop, moved at the boundary (Bypass kept), then told to continue', async () => {
  const r = await rig({ used: { work: 92, home: 50 }, settings: { [K.allowBypass]: true }, session: { state: 'working', mode: 'bypassPermissions', agentsRunning: 1 } });
  r.chat.dropped = { approvals: 0, queued: 0, agents: 1 };
  await r.tick();
  await r.tick();
  await r.tick();
  assert.equal(r.chat.moves.length, 0, 'never mid-turn');
  assert.equal(r.chat.sent.length, 1, 'the steer, once per window period');
  assert.match(r.chat.sent[0]!.text, /^Your Claude \(Work\) is at 8% left: finish the current step, commit and push your work and every sub-agent's work in progress, put one line per role on your status ticket if you keep one, then stop\. The portal moves this chat to Home at the end of this turn; after the move, start again the sub-agents and roles it interrupted\.$/);
  const st = await r.engine.state('s1', 'u_a');
  assert.equal(st.pendingMove?.to.id, 'home');
  // 45 minutes later the turn is still running: no card for an unattended chat, just the wait.
  await r.tick(45);
  assert.equal((await r.engine.state('s1', 'u_a')).pending, null);
  r.chat.dropped = { approvals: 0, queued: 0, agents: 0 };
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.deepEqual(r.chat.moves, [{ id: 's1', to: 'home', handoff: 'skip' }], 'steered: no handoff turn on the nearly-out Claude');
  assert.equal(r.chat.get('s1')!.mode, 'bypassPermissions');
  assert.equal(r.chat.sent.length, 2);
  assert.match(r.chat.sent[1]!.text, /^Moved to Home by the portal \(as announced\)\. Continue where you stopped, and start again the sub-agents and roles the move interrupted\.$/);
  assert.ok(r.kinds().includes('steered') && r.kinds().at(-1) === 'continued');
  r.engine.stop();
});

test('dry run: the trail says what would happen; nothing moves and nothing is said', async () => {
  const r = await rig({ used: { work: 92, home: 50 }, settings: { [K.dryRun]: true }, session: { state: 'working' } });
  await r.tick();
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 0);
  assert.equal(r.chat.sent.length, 0);
  const dry = r.auto.events('u_a', { session: 's1', kinds: ['dry_run'] }).map((e) => e.actor).sort();
  assert.deepEqual(dry, ['portal:autotransfer:move', 'portal:autotransfer:steer']);
  const state = await r.engine.engineState('u_a');
  assert.equal(state.dryRun, true);
  assert.equal(state.sessions[0]?.sessionId, 's1');
  r.engine.stop();
});

test('the mode off: the tick reads nothing', async () => {
  const r = await rig({ used: { work: 95, home: 50 }, settings: { [K.enabled]: false } });
  await r.tick();
  assert.equal(r.chat.moves.length, 0);
  assert.deepEqual(r.kinds(), []);
  r.engine.stop();
});

test('item 2: a new usage reading is evaluated within seconds, not at the next tick; a burst is one look, and looks are 30 s apart at least', async () => {
  const r = await rig({ used: { work: 80, home: 50 }, session: { state: 'working' } });
  r.used.work = 92;
  for (let i = 0; i < 5; i++) r.usage.reading();
  await r.tick(0.25); // 15 s: before the 2-minute tick
  const first = r.usage.calls;
  assert.ok(first >= 1 && first <= 2, 'five readings, one look (one report for the tick, one for the evaluation it queued)');
  assert.equal(r.chat.sent.length, 1, 'the steer came from the reading');
  assert.match(r.chat.sent[0]!.text, /^Your Claude \(Work\) is at 8% left/);
  r.usage.reading();
  await r.tick(0.25); // 15 s after the first look: not yet
  assert.equal(r.usage.calls, first);
  await r.tick(0.25); // 30 s after it
  assert.ok(r.usage.calls > first, 'the next look, 30 s after the last');
  const after = r.usage.calls;
  r.engine.stop();
  r.usage.reading();
  await r.tick(1);
  assert.equal(r.usage.calls, after, 'a stopped engine no longer listens');
});
