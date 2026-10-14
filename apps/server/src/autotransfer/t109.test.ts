// T-109 in the engine, on the fake clock: a Fable chat whose Claude runs low moves to a Claude without Fable on Opus (the switch request
// carries the model), the trail row says the model that APPLIES there (not only what was asked), and what a Claude's list_models said
// overrides the guess from its usage windows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_SETTING_KEYS as K, type ClaudeUsage, type ClaudeUsageWindow } from '@portal/contracts';
import { fakeOwner, freshStore } from '../notify/testkit.js';
import { AutoTransferEngine } from './engine.js';
import { AutoStore } from './store.js';
import { MoveChat, chatSession, fakeClock, fakeUsage, settingsMap, usage, win } from './testkit.js';

const AUTO = { [K.enabled]: true, [K.automatic]: true };

async function rig(windows: Record<string, ClaudeUsageWindow[]>, model = 'claude-fable-5-1') {
  const { store } = await freshStore();
  const clock = fakeClock();
  const chat = new MoveChat();
  chat.sessions.set('s1', chatSession('s1', { model }));
  const names: Record<string, string> = { work: 'Work', home: 'Home', spare: 'Spare' };
  const claudes = (): ClaudeUsage[] => Object.entries(windows).map(([id, w]) => ({ ...usage(id, names[id]!, w), checkedAt: new Date(clock.now() - 60_000).toISOString() }));
  const u = fakeUsage(claudes);
  const owner = fakeOwner({}, { fallback: 'u_a' });
  const auto = new AutoStore(store, () => new Date(clock.now()));
  const engine = new AutoTransferEngine({ chat, usage: u, owner, clock, store: auto, settings: settingsMap(AUTO), bus: null, audit: null, publish: () => {} });
  engine.start();
  const moved = () => auto.events('u_a', { session: 's1', limit: 50 }).filter((e) => e.kind === 'moved');
  return {
    chat,
    engine,
    moved,
    async tick() {
      clock.advance(3);
      await new Promise((r) => setImmediate(r));
      await engine.settled();
    },
  };
}

test('T-109: a Fable chat at 10 % left, only a Claude without Fable has room: it moves there and the switch asks for Opus; the trail says Fable to Opus', async () => {
  const r = await rig({ work: [win('session', 92), win('model:fable', 30)], home: [win('session', 20)] });
  await r.tick();
  assert.deepEqual(r.chat.moves, [{ id: 's1', to: 'home', handoff: 'ask', model: 'opus' }]);
  assert.equal(r.chat.models.length, 0, 'no model change in place: the Move flow applies it');
  const [row] = r.moved();
  assert.deepEqual([row?.from?.model, row?.to?.id, row?.to?.model], ['fable', 'home', 'opus']);
  r.engine.stop();
});

test('T-109: the destination applied a lower model than asked (it refused Opus): the trail row says what applies, Sonnet', async () => {
  const r = await rig({ work: [win('session', 92), win('model:fable', 30)], home: [win('session', 20)] });
  r.chat.appliedModel = 'claude-sonnet-4-5';
  await r.tick();
  const [row] = r.moved();
  assert.deepEqual([row?.from?.model, row?.to?.model], ['fable', 'sonnet']);
  r.engine.stop();
});

test('T-109: a Claude with Fable is preferred and the chat keeps its model; list_models saying "no Fable" overrides the Fable window', async () => {
  const windows = { work: [win('session', 92), win('model:fable', 30)], home: [win('session', 20)], spare: [win('session', 50), win('model:fable', 10)] };
  const keep = await rig(windows);
  await keep.tick();
  assert.deepEqual(keep.chat.moves, [{ id: 's1', to: 'spare', handoff: 'ask' }]);
  assert.equal(keep.moved()[0]?.to?.model ?? null, null, 'no model change in the trail');
  keep.engine.stop();

  const listed = await rig(windows);
  listed.chat.families.set('spare', ['opus', 'sonnet', 'haiku']);
  await listed.tick();
  assert.equal(listed.chat.moves[0]?.model, 'opus', 'Spare lists no Fable, so neither Claude keeps it: the one with more room, on Opus');
  listed.engine.stop();
});
