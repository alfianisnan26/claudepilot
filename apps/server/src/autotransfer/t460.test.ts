// T-460: a chat told to stop for a move (the steer) is told at once when the move is off, and the audit says why (`move.cancelled`).
// Imports only what exists before the fix, so the same file runs against the base for the PROOF (the rule is in t460rule.test.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUTO_SETTING_KEYS as K, type ClaudeUsage } from '@portal/contracts';
import type { AuditInput } from '../platform/audit.js';
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
  const names: Record<string, string> = { work: 'Work', home: 'Home' };
  const claudes = (): ClaudeUsage[] => Object.entries(used).map(([id, pct]) => ({ ...usage(id, names[id]!, [win('session', pct, at(180))]), checkedAt: new Date(clock.now() - 60_000).toISOString() }));
  const audits: AuditInput[] = [];
  const auto = new AutoStore(store, () => new Date(clock.now()));
  const engine = new AutoTransferEngine({
    chat,
    usage: fakeUsage(claudes),
    owner: fakeOwner({}, { fallback: 'u_a' }),
    clock,
    store: auto,
    settings: settingsMap({ ...AUTO, ...opts.settings }),
    bus: null,
    audit: { record: (e) => void audits.push(e) },
    publish: () => {},
  });
  engine.start();
  return {
    chat,
    used,
    engine,
    audits,
    cancelled: () => audits.filter((a) => a.kind === 'move.cancelled'),
    async tick(min = 3) {
      clock.advance(min);
      await new Promise((r) => setImmediate(r));
      await engine.settled();
    },
  };
}

const OFF = /^The move is off: /;

test('T-460: a steered move that does not happen (the source recovered) tells the chat the move is off, once, and audits move.cancelled with the reason', async () => {
  const r = await rig({ used: { work: 92, home: 50 }, session: { state: 'working' } });
  await r.tick();
  assert.equal(r.chat.sent.length, 1, 'the steer');
  assert.match(r.chat.sent[0]!.text, /then stop\./, 'the warning says stop while a move is queued');
  assert.equal(r.cancelled().length, 0);
  r.used.work = 40; // the Claude recovered: auto move stands down
  await r.tick();
  assert.equal(r.chat.moves.length, 0);
  assert.equal(r.chat.sent.length, 2, 'the continue line');
  assert.match(r.chat.sent[1]!.text, OFF);
  assert.doesNotMatch(r.chat.sent[1]!.text, /then stop|stop and wait/i, 'no stop and wait once the move is off');
  assert.equal(r.chat.sent[1]!.priority, 'next', 'the same channel as the steer');
  assert.equal(r.chat.sent[1]!.actor, 'portal:autotransfer');
  const rows = r.cancelled();
  assert.equal(rows.length, 1);
  assert.equal((rows[0]!.detail as { reason: string }).reason, 'above_threshold');
  assert.equal(rows[0]!.subject, 'session:s1');
  await r.tick();
  await r.tick();
  assert.equal(r.chat.sent.length, 2, 'said once');
  assert.equal(r.cancelled().length, 1);
  r.engine.stop();
});

test('T-460: no destination any more: the steered chat is told the move is off, with the reason', async () => {
  const r = await rig({ used: { work: 92, home: 50 }, session: { state: 'working' } });
  await r.tick();
  r.used.home = 95; // nowhere to go
  await r.tick();
  assert.equal(r.chat.moves.length, 0);
  assert.match(r.chat.sent.at(-1)!.text, OFF);
  assert.equal(r.cancelled().length, 1);
  assert.ok((r.cancelled()[0]!.detail as { reason: string }).reason);
  r.engine.stop();
});

test('T-460: a move that happens sends the continue line and no "move is off"; the audit has no move.cancelled', async () => {
  const r = await rig({ used: { work: 92, home: 50 }, session: { state: 'working' } });
  await r.tick();
  r.chat.turnEnds('s1');
  await r.engine.settled();
  assert.equal(r.chat.moves.length, 1);
  assert.equal(r.chat.sent.length, 2);
  assert.match(r.chat.sent[1]!.text, /^Moved to Home by the portal/);
  assert.ok(r.chat.sent.every((m) => !OFF.test(m.text)));
  assert.equal(r.cancelled().length, 0);
  r.engine.stop();
});

test('T-460: a dry run said nothing, so nothing is said when it ends; the audit still records the cancel', async () => {
  const r = await rig({ used: { work: 92, home: 50 }, settings: { [K.dryRun]: true }, session: { state: 'working' } });
  await r.tick();
  r.used.work = 40;
  await r.tick();
  assert.equal(r.chat.sent.length, 0);
  assert.equal(r.cancelled().length, 1);
  assert.equal((r.cancelled()[0]!.detail as { told: boolean }).told, false);
  r.engine.stop();
});
