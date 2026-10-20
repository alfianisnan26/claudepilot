// T-1098 (QA): a ticket argument that is STORED (a session's ticket, a lab draw) is the stable T-<n> whichever form the caller gave, so the
// ticket's session list, usage attribution, CI and the lab, which all match on T-<n>, keep finding it. Filters take both forms too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { liveSession } from '../chat/testkit.js';
import { TicketsAdapter } from '../ci/tickets.js';
import { canonTicket } from '../lab/experiments.js';
import { SpendStore } from '../usagespend/store.js';
import { Tickets } from './service.js';
import { ChatTicketSessions } from './sessions.js';
import { UI } from './testkit.js';

test('a session created or linked with KONF-1 stores T-n and shows in that ticket’s session list; filters take the key', async () => {
  const s = await liveSession();
  const tickets = new Tickets(s.store, new ChatTicketSessions(s.controller));
  s.controller.ticketExists = (id) => tickets.exists(id);
  s.controller.ticketResolve = (id) => tickets.resolve(id);
  s.controller.ticketKeyOf = (id) => tickets.keyOf(id);
  try {
    tickets.create(UI, { summary: 'filler', bucket: 'CP' });
    const t = tickets.create(UI, { summary: 'konf work', bucket: 'KONF', workspaceId: 'docker/ws1' });
    assert.deepEqual([t.id, t.key], ['T-2', 'KONF-1']);

    const made = await s.controller.create({ workspaceId: 'docker/ws1', ticketId: 'konf-1' });
    assert.equal(made.ticketId, 'T-2', 'stored as the stable id');
    assert.equal(s.controller.setTicket(s.id, 'KONF-1').ticketId, 'T-2', 'setTicket too');

    const listed = tickets.get(UI, 'KONF-1').sessions.map((x) => x.id).sort();
    assert.deepEqual(listed, [made.id, s.id].sort(), 'the ticket’s session list finds both');
    assert.deepEqual(s.controller.list({ ticketId: 'KONF-1' }).map((x) => x.id).sort(), [made.id, s.id].sort(), 'a session filter by key');
    assert.deepEqual(s.controller.listPage({ ticketId: 'konf-1' }, {}).items.length, 2);

    const code = (fn: () => unknown) => {
      try {
        fn();
        return 'ok';
      } catch (e) {
        return isAppError(e) ? e.code : String(e);
      }
    };
    assert.equal(code(() => s.controller.setTicket(s.id, 'KONF-9')), 'NOT_FOUND', 'a key that names no ticket is refused');

    // The screens get the key with the session (no lookup per row): the chat list and the usage attribution's sessions.
    assert.equal(s.controller.get(made.id)!.ticketKey, 'KONF-1');
    assert.deepEqual(s.controller.list({ ticketId: 'T-2' }).map((x) => x.ticketKey), ['KONF-1', 'KONF-1']);
    assert.equal(new SpendStore(s.store).sessions([made.id]).get(made.id)!.ticketKey, 'KONF-1');
    assert.equal(tickets.keyOf('T-2'), 'KONF-1');
    assert.equal(tickets.keyOf('T-99'), null);
    // CI's port and the lab resolve the same way.
    assert.equal(new TicketsAdapter(tickets).resolve('KONF-1'), 'T-2');
    assert.equal(canonTicket(s.store.db!, 'konf-1'), 'T-2');
    assert.equal(canonTicket(s.store.db!, 'T-002'), 'T-2');
    assert.equal(canonTicket(s.store.db!, 'KONF-9'), null);
  } finally {
    await s.done();
  }
});
