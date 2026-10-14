// Keep going against the real chat controller (on its fake workspace): the session payload carries `keepGoing` through the hook, a change
// is heard by the chat's tabs, and the sweep's nudge goes through `send` as the portal at priority `later` (the controller accepts the actor).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEEPGOING_ACTOR, type ChatServerMessage } from '@portal/contracts';
import { liveSession, until } from '../chat/testkit.js';
import { fakeOwner } from '../notify/testkit.js';
import { fakeClock } from '../autotransfer/testkit.js';
import { KeepGoingEngine } from './engine.js';
import { KeepGoingStore } from './store.js';

test('the real controller: keepGoing on the payload, a change heard by the tabs, a nudge sent as the portal at priority later', async () => {
  const s = await liveSession();
  try {
    // The engine's clock runs five minutes ahead of the controller's, so the chat reads idle for five minutes.
    const clock = fakeClock(Date.now() + 5 * 60_000);
    const store = new KeepGoingStore(s.store, () => new Date(clock.now()));
    const c = s.controller;
    const engine = new KeepGoingEngine({
      chat: {
        get: (id) => c.get(id),
        openRequests: (id) => c.openRequests(id),
        send: (id, uuid, text, o) => c.send(id, uuid, text, o),
        respond: (id, r, d, o) => c.respond(id, r, d, o),
        resume: (id) => c.control(id, 'resume'),
      },
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
