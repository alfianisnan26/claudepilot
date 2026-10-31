// T-3189: `heldBy` tells Keep going what a chat holds: the tickets assigned to it (any status), the ones it must work on (open, in progress)
// and the newest change on them; a comment and a status change move that change time, another session's tickets do not count.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ticketsHarness, UI } from './testkit.js';

const WS = 'kubernetes/kohi-event';

test('heldBy: counts per session, active only open and in progress, the newest updated_at moves on a comment and a status change', async () => {
  let now = Date.parse('2026-10-30T08:00:00.000Z');
  const h = await ticketsHarness({ now: () => new Date(now) });
  try {
    h.sessions.add({ id: 'lead', workspaceId: WS });
    h.sessions.add({ id: 'other', workspaceId: WS });
    assert.deepEqual(h.tickets.heldBy('lead'), { total: 0, active: 0, lastChangeAt: null }, 'never held one');

    const assign = (sessionId: string, status: 'in_progress' | 'in_review' | 'blocked') => {
      const t = h.tickets.create(UI, { summary: `a ticket for ${sessionId}`, workspaceId: WS });
      return h.tickets.update(UI, t.id, { assignee: { kind: 'session', sessionId }, status }).id;
    };
    const review = assign('lead', 'in_review');
    now += 60_000;
    const blocked = assign('lead', 'blocked');
    now += 60_000;
    assign('other', 'in_progress');
    const at0 = new Date(now - 60_000).toISOString();
    assert.deepEqual(h.tickets.heldBy('lead'), { total: 2, active: 0, lastChangeAt: at0 });

    now += 60_000;
    h.tickets.comment(UI, review, 'A verdict-like note from QA.');
    assert.equal(h.tickets.heldBy('lead').lastChangeAt, new Date(now).toISOString(), 'a comment moves it');

    now += 60_000;
    h.tickets.update(UI, blocked, { status: 'in_progress' });
    const after = { total: 2, active: 1, lastChangeAt: new Date(now).toISOString() };
    assert.deepEqual(h.tickets.heldBy('lead'), after, 'a status change moves it; in progress is active');

    h.tickets.close(UI, review, { summary: 'done' });
    assert.equal(h.tickets.heldBy('lead').total, 2, 'a closed ticket still counts as held');
    const other = h.tickets.heldBy('other');
    assert.equal(other.total, 1, "another session's tickets are its own");
    assert.equal(other.active, 1);
  } finally {
    h.done();
  }
});
