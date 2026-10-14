// Keep going against the real chat controller (on its fake workspace): the session payload carries `keepGoing` through the hook, a change
// is heard by the chat's tabs, and the sweep's nudge goes through `send` as the portal at priority `later` (the controller accepts the actor).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEEPGOING_ACTOR, type ChatServerMessage } from '@portal/contracts';
import { liveSession, until } from '../chat/testkit.js';
import { fakeOwner } from '../notify/testkit.js';
import { fakeClock } from '../autotransfer/testkit.js';
import { KeepGoingEngine } from './engine.js';
import { keepGoingChatPort } from './index.js';
import { KeepGoingStore } from './store.js';

test('the real controller: keepGoing on the payload, a change heard by the tabs, a nudge sent as the portal at priority later', async () => {
  const s = await liveSession();
  try {
    // The engine's clock runs five minutes ahead of the controller's, so the chat reads idle for five minutes.
    const clock = fakeClock(Date.now() + 5 * 60_000);
    const store = new KeepGoingStore(s.store, () => new Date(clock.now()));
    const c = s.controller;
    const engine = new KeepGoingEngine({
      chat: keepGoingChatPort(c)!,
      owner: fakeOwner({}, { fallback: 'u_owner' }),
      clock,
      store,
      settings: null,
      bus: null,
      audit: null,
      tickets: null,
      random: () => 0,
      changed: (id) => c.keepGoingChanged(id),
    });
    assert.equal(c.get(s.id)!.keepGoing, undefined, 'no hook: no field');
    c.keepGoingOf = (id) => engine.view(id);
    assert.equal(c.get(s.id)!.keepGoing ?? null, null, 'no policy yet: absent');
    const before = s.messages.length;
    engine.set(s.id, 'u_owner', 'ui', { enabled: true });
    const heard = s.messages.slice(before).find((m): m is Extract<ChatServerMessage, { type: 'session' }> => m.type === 'session');
    assert.equal(heard?.session.keepGoing?.enabled, true, 'the tabs hear the change');
    assert.equal(c.get(s.id)!.keepGoing?.enabled, true);
    assert.equal(await engine.round(), 1);
    await until(() => s.messages.some((m) => m.type === 'events' && m.items.some((e) => e.kind === 'user' && e.actor === KEEPGOING_ACTOR)));
    const written = s.ws.sends.map((x) => x.line).join('');
    assert.match(written, /"priority":"later"/);
    assert.match(written, /Portal message \(portal:keepgoing\)/);
    assert.equal(c.get(s.id)!.keepGoing?.nudgesToday, 1);
  } finally {
    await s.done();
  }
});

test('the real controller: an ended chat is continued by a new session (continuedFrom, as the portal, not bypass-capable) that gets the brief', async () => {
  const s = await liveSession();
  try {
    const clock = fakeClock(Date.now());
    const store = new KeepGoingStore(s.store, () => new Date(clock.now()));
    const c = s.controller;
    const port = keepGoingChatPort(c);
    assert.ok(port, 'the module wires the real controller (create and recover included)');
    const engine = new KeepGoingEngine({ chat: port, owner: fakeOwner({}, { fallback: 'u_owner' }), clock, store, settings: null, bus: null, audit: null, tickets: null, random: () => 0 });
    engine.set(s.id, 'u_owner', 'ui', { enabled: true, prompt: 'Go on with {ticket}.' });
    // The process died (not a person's close): the row reads ended.
    s.store.db!.prepare("UPDATE chat_sessions SET state = 'ended', process = 'gone', ended_reason = 'the process exited (code 1)' WHERE id = ?").run(s.id);
    assert.equal(c.get(s.id)!.state, 'ended');
    await engine.round();
    const next = c.list().find((x) => x.continuedFrom === s.id);
    assert.ok(next, 'a new session continues it');
    assert.equal(next.workspaceId, 'docker/ws1');
    assert.equal(next.bypassCapable, false);
    assert.equal(store.policy(next.id)?.enabled, true, 'the policy went with it');
    assert.equal(store.policy(s.id)?.enabled, false);
    await until(() => s.messages.some((m) => m.type === 'events' && m.session === next.id && m.items.some((e) => e.kind === 'user' && e.actor === KEEPGOING_ACTOR)));
  } finally {
    await s.done();
  }
});
