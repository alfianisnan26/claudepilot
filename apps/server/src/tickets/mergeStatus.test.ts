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

test('T-2016: the caller is checked before the arguments: a session that is not the gate gets FORBIDDEN (audited) even for bad input; the gate gets VALIDATION_FAILED', async () => {
  const h = await ticketsHarness({ mergeGates: () => [{ tag: 'konfersi-migration', gates: [GATE] }] });
  const audits: { kind: string; detail?: Record<string, unknown> }[] = [];
  h.tickets.onAudit = (e) => void audits.push(e);
  try {
    createTicketRoutes(h.tickets); // binds the bucket view rule to this harness's tickets (the previous test's store is closed)
    h.sessions.add({ id: GATE, workspaceId: 'docker/api' });
    h.sessions.add({ id: B, workspaceId: 'docker/api' });
    const t = h.tickets.create(UI, { summary: 'merge me', workspaceId: 'docker/api', tags: ['konfersi-migration'] });
    const code = (by: string, req: Record<string, unknown>) => {
      try {
        h.tickets.recordMergeStatus(agent('docker/api', by), t.id, req);
        return 'ok';
      } catch (e) {
        return isAppError(e) ? e.code : String(e);
      }
    };
    const bad = [
      { repo: '../x y', pr: 7, prHead: head('a'), state: 'ready' },
      { repo: 'konfersi/api', pr: 7, prHead: 'abc', state: 'ready' },
      { repo: 'konfersi/api', pr: 7, prHead: head('a'), state: 'nonsense' },
      { repo: 'konfersi/api', state: 'ready' },
    ];
    for (const req of bad) assert.equal(code(B, req), 'FORBIDDEN', `not the gate, ${JSON.stringify(req)}`);
    const refused = audits.filter((a) => a.kind === 'ticket.merge_status_refused');
    assert.equal(refused.length, bad.length, 'each refusal is audited');
    assert.deepEqual(refused.map((a) => [a.detail?.repo, a.detail?.state]), [[null, 'ready'], ['konfersi/api', 'ready'], ['konfersi/api', null], ['konfersi/api', 'ready']], 'only well-formed fields are named');
    for (const req of bad) assert.equal(code(GATE, req), 'VALIDATION_FAILED', `the gate, ${JSON.stringify(req)}`);
    assert.equal(audits.filter((a) => a.kind === 'ticket.merge_status_refused').length, bad.length, 'a validation error is no refusal');
    assert.deepEqual(h.tickets.mergeStatus(UI, t.id), []);
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

test("T-3198 migration 797: merged may name its head with no PR; the rebuild keeps every row and id; every other state keeps 796's rule", async () => {
  assert.equal(MIGRATIONS.filter((m) => m.version === 797).length, 1);
  const h = await ticketsHarness();
  try {
    const t = h.tickets.create(UI, { summary: 'x' });
    const db = h.store.db!;
    const ins = (pr: number | null, prHead: string | null, state: string) =>
      db
        .prepare(
          'INSERT INTO ticket_merge_status (ticket_number, repo, pr, pr_head, state, reason, actor, actor_label, at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)',
        )
        .run(t.number, 'o/r', pr, prHead, state, 'ui', 'Admin', new Date().toISOString());
    const rows = () =>
      db
        .prepare('SELECT id, pr, pr_head AS head, state FROM ticket_merge_status ORDER BY id')
        .all()
        .map((r) => ({ ...r }));
    // As a portal before 797 left it: 796's table, 796's rule (merged needs its PR), and rows in it.
    db.exec('DROP TABLE ticket_merge_status');
    MIGRATIONS.find((m) => m.version === 796)!.up(db);
    ins(null, null, 'no_pr');
    ins(4, head('c'), 'ready');
    assert.throws(() => ins(null, head('d'), 'merged'), '796 refuses merged without a PR');
    const before = rows();
    db.exec('BEGIN');
    MIGRATIONS.find((m) => m.version === 797)!.up(db);
    db.exec('COMMIT');
    assert.deepEqual(rows(), before, 'every row and id kept');
    ins(null, head('d'), 'merged');
    assert.throws(() => ins(null, null, 'merged'), 'merged still names its head');
    assert.throws(() => ins(null, head('d'), 'ready'));
    assert.throws(() => ins(4, null, 'conflict'));
    assert.throws(() => ins(null, head('d'), 'failed'));
    assert.throws(() => ins(1, 'abc', 'merged'));
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ticket_merge_status' AND name = 'ticket_merge_status_ticket'`,
      )
      .get();
    assert.ok(idx, 'the index is back');
    assert.deepEqual(
      h.tickets.mergeStatus(UI, t.id).map((m) => [m.pr, m.prHead, m.state]),
      [[null, head('d'), 'merged']],
      'the newest per repo',
    );
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
