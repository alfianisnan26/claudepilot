// T-2014 (tickets PRD FR36e): the merge gate's record of a ticket's PR. The tool's rule is in portalTools.test.ts; here the REST read route
// (declared view on the ticket, the same 404), the table's own checks, and who the flow programs make a merge gate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { isAppError } from '@isnanme/core';
import { MIGRATIONS } from '../store/migrations.js';
import { policyFor } from '../authz/seam.js';
import { mergeGatesOf, mergeRecordersOf } from '../flow/programs.js';
import { createTicketRoutes } from './routes.js';
import { agent, ticketsHarness, UI } from './testkit.js';

const GATE = 'aaaaaaaa-0000-0000-0000-00000000000a';
const B = 'bbbbbbbb-0000-0000-0000-00000000000b';
const C = 'cccccccc-0000-0000-0000-00000000000c';
const head = (c: string) => c.repeat(40);

test('GET /api/tickets/:id/merge: the latest record per repo; declared view on the ticket; a missing ticket is a 404', async () => {
  const h = await ticketsHarness({ mergeGates: () => [{ tag: 'konfersi-migration', gates: [GATE] }] });
  try {
    const a = new Hono();
    a.onError((e, c) => (isAppError(e) ? c.json(e.toJSON(), e.status as 400) : c.json({ error: String(e) }, 500)));
    a.use(async (c, next) => {
      (c as unknown as { set(k: string, v: unknown): void }).set('token', 'signed-in');
      await next();
    });
    a.route('/api/tickets', createTicketRoutes(h.tickets));
    assert.deepEqual(policyFor('GET /api/tickets/:id/merge'), { kind: 'objects', checks: [{ type: 'ticket', verb: 'view', from: 'path', param: 'id' }] });
    h.sessions.add({ id: GATE, workspaceId: 'docker/api' });
    const t = h.tickets.create(UI, { summary: 'merge me', workspaceId: 'docker/api', tags: ['konfersi-migration'] });
    const by = agent('docker/api', GATE);
    h.tickets.recordMergeStatus(by, t.id, { repo: 'konfersi/api', pr: 3, prHead: head('a'), state: 'waiting' });
    h.tickets.recordMergeStatus(by, t.id, { repo: 'konfersi/api', pr: 3, prHead: head('b'), state: 'conflict', reason: 'base moved' });
    const res = await a.request(`/api/tickets/${t.id}/merge`);
    assert.equal(res.status, 200);
    const list = ((await res.json()) as { data: { repo: string; pr: number; prHead: string; state: string; reason: string | null; actor: string }[] }).data;
    assert.deepEqual(list.map((m) => [m.repo, m.pr, m.prHead, m.state, m.reason, m.actor]), [['konfersi/api', 3, head('b'), 'conflict', 'base moved', `session:${GATE}`]]);
    assert.equal((await a.request('/api/tickets/T-999/merge')).status, 404);
  } finally {
    h.done();
  }
});

test('migration 796: one table; every state but no_pr names the PR and its full head (the database refuses otherwise)', async () => {
  assert.equal(MIGRATIONS.filter((m) => m.version === 796).length, 1);
  const h = await ticketsHarness();
  try {
    const t = h.tickets.create(UI, { summary: 'x' });
    const db = h.store.db!;
    const ins = (pr: number | null, prHead: string | null, state: string) =>
      db.prepare('INSERT INTO ticket_merge_status (ticket_number, repo, pr, pr_head, state, reason, actor, actor_label, at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)').run(t.number, 'o/r', pr, prHead, state, 'ui', 'Admin', new Date().toISOString());
    ins(null, null, 'no_pr');
    ins(1, head('c'), 'ready');
    assert.throws(() => ins(null, null, 'ready'));
    assert.throws(() => ins(1, 'abc', 'merged'));
    assert.throws(() => ins(1, head('c'), 'closed'));
  } finally {
    h.done();
  }
});

test('mergeGatesOf: the configured gate when a lead of the group, else its first lead; a program with no group has each group\'s; off programs none', () => {
  const groups = `${GATE},${B};${C},${B}`;
  assert.deepEqual(mergeGatesOf(`konfersi|konfersi-migration|1|${B}`, groups), [{ tag: 'konfersi-migration', gates: [B] }]);
  assert.deepEqual(mergeGatesOf(`konfersi|konfersi-migration|1|${C}`, groups), [{ tag: 'konfersi-migration', gates: [GATE] }], 'a gate not in the group falls back');
  assert.deepEqual(mergeGatesOf('konfersi|konfersi-migration||', groups), [{ tag: 'konfersi-migration', gates: [GATE, C] }]);
  assert.deepEqual(mergeGatesOf('konfersi|konfersi-migration|1||off', groups), []);
  assert.deepEqual(mergeGatesOf('konfersi|konfersi-migration|3|', groups), [], 'a group that does not exist: nobody');
  assert.deepEqual(mergeGatesOf('konfersi|konfersi-migration||', ''), []);
});

test('mergeRecordersOf (D-99): every lead of the program\'s group records; a program with no group has every group\'s leads; off programs none', () => {
  const groups = `${GATE},${B};${C},${B}`;
  assert.deepEqual(mergeRecordersOf(`konfersi|konfersi-migration|1|${B}`, groups), [{ tag: 'konfersi-migration', gates: [GATE, B] }]);
  assert.deepEqual(mergeRecordersOf('konfersi|konfersi-migration||', groups), [{ tag: 'konfersi-migration', gates: [GATE, B, C] }]);
  assert.deepEqual(mergeRecordersOf('konfersi|konfersi-migration|1||off', groups), []);
  assert.deepEqual(mergeRecordersOf('konfersi|konfersi-migration|3|', groups), [], 'a group that does not exist: nobody');
  assert.deepEqual(mergeRecordersOf('konfersi|konfersi-migration||', ''), []);
});
