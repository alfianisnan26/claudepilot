// T-257 on a fake clock: a chat left down is reported everywhere a person or its coordinator looks (item 1: the notification, the Needs you
// item, the ticket; item 4: the coordinator's chat after 15 minutes still ended), and a harmless integrity ending does not count against the
// cap: it is recovered in place even after the chat's own cap is reached (item 2).
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { AppError } from '@isnanme/core';
import { CHAT_RECOVER_PAUSED, CHAT_RECOVER_SUSPICIOUS, KEEPGOING_RESTART_CAPS, KEEPGOING_SETTING_KEYS, sessionRef, type Actor } from '@portal/contracts';
import { clearResolvers, ownerActor, registerResolver } from '../authz/seam.js';
import { keepGoingAttentionSource } from './attention.js';
import { rig, settingsMap } from './testkit.js';

type Rig = Awaited<ReturnType<typeof rig>>;

const harmless = { reason: 'a second control response for request r1', classified: 'harmless' as const, case: 'control-duplicate', origin: 'the stream read twice' };
const suspicious = { reason: 'a message this portal didn’t send reached Claude Code', classified: 'suspicious' as const, case: 'replay-unknown', origin: 'unknown origin' };
const end = (r: Rig, id: string, f: typeof harmless | typeof suspicious) => r.chat.patch(id, { state: 'ended', process: 'gone', endedReason: `integrity: ${f.reason}`, endedFor: f });
const user = (userId: string): Actor => ({ kind: 'user', userId, loginSessionId: 'test', via: 'ui' });
const needsYou = (r: Rig, actor: Actor = ownerActor()) => keepGoingAttentionSource(() => r.store.db).list(actor, r.clock.now());

afterEach(() => clearResolvers());

/** A chat (its parent the coordinator `coord`) that ends harmlessly and whose recover keeps waiting: left down 15 minutes on. */
async function leftDown(r: Rig, over: { parentId?: string | null } = {}) {
  r.chat.put('coord', { state: 'idle', process: 'live' });
  r.chat.put('s1', { parentId: 'coord', ...over });
  r.on('s1');
  end(r, 's1', harmless);
  r.chat.recoverError = new AppError(CHAT_RECOVER_PAUSED as never, 'Recovered a moment ago.', { status: 409 });
  await r.engine.round();
  for (let i = 0; i < 14; i++) await r.after(1);
}

test('still ended 15 minutes on: one ticket, one notification, one Needs you item, and the coordinator’s chat is told once; running again clears it', async () => {
  const r = await rig();
  await leftDown(r);
  assert.equal(r.tickets.made.length, 0, 'not before 15 minutes');
  assert.deepEqual(needsYou(r), []);
  assert.equal(r.chat.sent.filter((m) => m.id === 'coord').length, 0);

  await r.after(1);
  // The ticket and the notification (item 1).
  assert.equal(r.tickets.made.length, 1);
  assert.equal(r.tickets.made[0]!.priority, 'high');
  assert.equal(r.emitted.length, 1);
  assert.equal(r.emitted[0]!.kind, 'keepgoing_attention');
  assert.equal(r.emitted[0]!.facts.what, 'down');
  // The Needs you item, linked to the chat and its ticket; the title is clipped agent text, the class a question.
  const [item, ...more] = needsYou(r);
  assert.equal(more.length, 0);
  assert.equal(item!.kind, 'keepgoing_down');
  assert.equal(item!.id, 's1');
  assert.equal(item!.why, 'question');
  assert.equal(item!.link, '/admin/sessions/s1');
  assert.ok(item!.who.some((w) => w.label === 'T-1' && w.link === '/admin/tickets/T-1'));
  // Another person who may not operate the chat sees nothing (the same absence as a missing item).
  registerResolver({ type: 'session', resolve: (id) => ({ ref: sessionRef(id), owner: { kind: 'user', id: 'u_a' } }) });
  assert.deepEqual(needsYou(r, user('u_b')), []);
  clearResolvers();
  // The coordinator's chat (item 4): one message at priority later, as the portal, ids and fixed words only (never the chat's title).
  const told = r.chat.sent.filter((m) => m.id === 'coord');
  assert.equal(told.length, 1);
  assert.equal(told[0]!.priority, 'later');
  assert.match(told[0]!.text, /the chat s1 in docker\/api-dev is left down/);
  assert.match(told[0]!.text, /the ticket is T-1/);
  assert.doesNotMatch(told[0]!.text, /CANARY-TITLE/);
  assert.equal(r.auditRows('keepgoing.escalated').length, 1);

  // Not repeated while it stands.
  for (let i = 0; i < 5; i++) await r.after(1);
  assert.equal(r.chat.sent.filter((m) => m.id === 'coord').length, 1);
  assert.equal(r.emitted.length, 1);
  assert.equal(needsYou(r).length, 1);

  // It runs again: the report clears, and so does the Needs you item.
  r.chat.recoverError = null;
  await r.after(1);
  r.chat.patch('s1', { state: 'idle', process: 'live' });
  await r.after(1);
  assert.deepEqual(needsYou(r), []);
});

test('the coordinator setting wins over the parent; an ended coordinator, or none at all, is not told (the notification still goes)', async () => {
  const settings = settingsMap({ [KEEPGOING_SETTING_KEYS.coordinator]: 'boss' });
  const r = await rig({ settings });
  r.chat.put('boss', { state: 'idle', process: 'live' });
  await leftDown(r);
  await r.after(1);
  assert.equal(r.chat.sent.filter((m) => m.id === 'boss').length, 1);
  assert.equal(r.chat.sent.filter((m) => m.id === 'coord').length, 0);

  const r2 = await rig();
  await leftDown(r2);
  r2.chat.patch('coord', { state: 'ended', process: 'gone' });
  await r2.after(1);
  assert.equal(r2.emitted.length, 1);
  assert.equal(r2.chat.sent.filter((m) => m.id === 'coord').length, 0);
  assert.equal(r2.auditRows('keepgoing.escalated').length, 0);

  const r3 = await rig();
  await leftDown(r3, { parentId: null });
  await r3.after(1);
  assert.equal(r3.emitted.length, 1);
  assert.equal(r3.tickets.made.length, 1);
  assert.equal(r3.auditRows('keepgoing.escalated').length, 0);
  assert.equal(needsYou(r3).length, 1);
});

test('a harmless ending does not count against the cap: after the integrity cap left the chat down, a harmless ending is still recovered in place', async () => {
  const r = await rig();
  r.chat.put('s1');
  r.on('s1');
  // Suspicious endings whose recover is refused: new chats until the integrity cap, then left down.
  r.chat.recoverError = new AppError(CHAT_RECOVER_SUSPICIOUS as never, 'A line this portal did not send.', { status: 409 });
  const head = () => r.chat.started.at(-1)?.id ?? 's1';
  for (let i = 0; i <= KEEPGOING_RESTART_CAPS.integrity; i++) {
    end(r, head(), suspicious);
    for (let j = 0; j < 10; j++) await r.after(1);
  }
  const n = r.chat.started.length;
  assert.equal(n, KEEPGOING_RESTART_CAPS.integrity);
  assert.equal(r.tickets.made.length, 1, 'the cap: left down, reported');
  assert.equal(needsYou(r).map((i) => i.id).join(), head());
  // A person brings it back; later it ends harmlessly: recovered in place at once, no new chat, nothing reported.
  r.chat.recoverError = null;
  r.chat.patch(head(), { state: 'idle', process: 'live', endedReason: null, endedFor: null });
  await r.after(1);
  assert.deepEqual(needsYou(r), []);
  const before = r.chat.recovered.length;
  end(r, head(), harmless);
  await r.after(1);
  assert.equal(r.chat.recovered.length, before + 1);
  assert.equal(r.chat.recovered.at(-1), head());
  assert.equal(r.chat.started.length, n, 'no new chat: recovered in place');
  assert.equal(r.engine.view(head())!.last?.reason, 'Ended for integrity (harmless): recovered in place.');
  assert.equal(r.tickets.made.length, 1);
  assert.equal(r.emitted.length, 1);
});
