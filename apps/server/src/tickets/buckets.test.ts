// T-1098: ticket buckets (projects). Each bucket has its own id prefix and number counter; `T-<n>` stays a permanent alias everywhere.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { AppError } from '@isnanme/core';
import { normalTicketRef, parseTicketBranch, parseTicketRef, parseTicketTrailers } from '@portal/contracts';
import { MIGRATIONS } from '../store/migrations.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import { tempDirectory } from '../store/testTmp.js';
import { agent, token, ticketsHarness, UI } from './testkit.js';

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? `${e.code}${e.code === 'NOT_FOUND' ? `:${e.message}` : ''}` : `other:${(e as Error).message}`;
  }
  return 'none';
};

test('contracts: a reference is the stable id or a bucket key; branches and trailers name either', () => {
  assert.deepEqual(parseTicketRef('T-12'), { number: 12 });
  assert.deepEqual(parseTicketRef('#12'), { number: 12 });
  assert.deepEqual(parseTicketRef(' 12 '), { number: 12 });
  assert.deepEqual(parseTicketRef('KONF-12'), { bucket: 'KONF', n: 12 });
  assert.deepEqual(parseTicketRef('konf-12'), { bucket: 'KONF', n: 12 }, 'typed by hand, any case');
  assert.equal(parseTicketRef('K-12'), null, 'one letter is not a key (T-12 always means the stable id)');
  assert.equal(parseTicketRef('TOOLONG-1'), null);
  assert.equal(normalTicketRef('cp-3'), 'CP-3');
  assert.equal(parseTicketBranch('ticket/T-1098-ticket-buckets'), 'T-1098');
  assert.equal(parseTicketBranch('ticket/KONF-12-fix-login'), 'KONF-12');
  assert.equal(parseTicketBranch('ticket/fix-12-login'), null, 'a lowercase word is not a bucket key');
  assert.deepEqual(parseTicketTrailers('Fix\n\nTicket: KONF-12\nTicket: T-5\nTicket: #5\nticket: cp-1\nPilot-Ticket: TB-9'), ['KONF-12', 'T-5']);
});

test('new tickets are numbered per bucket in order; T-<n> keeps counting across all of them', async () => {
  const h = await ticketsHarness();
  try {
    const a = h.tickets.create(UI, { summary: 'one', bucket: 'KONF' });
    const b = h.tickets.create(UI, { summary: 'two', bucket: 'CP' });
    const c = h.tickets.create(UI, { summary: 'three', bucket: 'konf' });
    const d = h.tickets.create(UI, { summary: 'four' });
    assert.deepEqual(
      [a, b, c, d].map((t) => [t.id, t.key, t.bucket]),
      [
        ['T-1', 'KONF-1', 'KONF'],
        ['T-2', 'CP-1', 'CP'],
        ['T-3', 'KONF-2', 'KONF'],
        ['T-4', 'PILOT-1', 'PILOT'],
      ],
    );
    assert.equal(h.tickets.get(UI, 'T-1').events[0]!.data!.bucket, 'KONF', 'the created entry says where it went');
    assert.equal(code(() => h.tickets.create(UI, { summary: 'x', bucket: 'NOPE' })), 'NOT_FOUND:No such bucket.');
  } finally {
    h.done();
  }
});

test('ids stay sequential and unique under truly concurrent creates: three threads, three connections, one bucket', async () => {
  // Real concurrency, not interleaving on one event loop: two worker threads each open their own connection to the same file and insert as
  // fast as they can (each insert its own transaction, retried by busy_timeout under SQLite's single writer lock) while the main thread
  // creates through the service. The trigger hands out the number inside each insert's transaction, so no two rows can share one.
  const h = await ticketsHarness();
  const file = join(h.dataDir, 'portal.db');
  const PER_WORKER = 60;
  const code = `
    const { workerData, parentPort } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.file);
    db.exec('PRAGMA busy_timeout = 10000');
    const ins = db.prepare("INSERT INTO tickets (type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, created_at, updated_at, bucket_key) VALUES ('task', 'normal', 2, 'open', ?, 'human', 'ui', 'Admin', ?, ?, ?)");
    const at = new Date().toISOString();
    // Wait for the go, so every thread inserts at the same time.
    const go = new Int32Array(workerData.go);
    parentPort.postMessage('ready');
    Atomics.wait(go, 0, 0);
    // A short pause between inserts (the lock is free then), so the threads' writes take turns instead of one running out first.
    const nap = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < workerData.n; i++) (ins.run('w' + workerData.id + '-' + i, at, at, i % 2 ? 'KONF' : 'CP'), Atomics.wait(nap, 0, 0, 1));
    db.close();
    parentPort.postMessage('done');
  `;
  const go = new SharedArrayBuffer(4);
  const ready: Promise<void>[] = [];
  const run = (id: number) =>
    new Promise<void>((resolve, reject) => {
      const w = new Worker(code, { eval: true, workerData: { file, id, n: PER_WORKER, go } });
      ready.push(new Promise<void>((r) => w.once('message', () => (w.once('message', () => resolve()), r()))));
      w.once('error', reject);
    });
  try {
    h.store.db!.exec('PRAGMA busy_timeout = 10000');
    const workers = [run(1), run(2)];
    await Promise.all(ready);
    Atomics.store(new Int32Array(go), 0, 1);
    Atomics.notify(new Int32Array(go), 0);
    for (let i = 0; i < 40; i++) {
      h.tickets.create(UI, { summary: `main ${i}`, bucket: i % 2 ? 'KONF' : 'CP' });
      await new Promise((r) => setTimeout(r, 1)); // let the workers' inserts land between ours
    }
    await Promise.all(workers);
    const rows = h.store.db!.prepare('SELECT bucket_key AS b, bucket_number AS n FROM tickets ORDER BY bucket_key, bucket_number').all() as { b: string; n: number }[];
    assert.equal(rows.length, 40 + 2 * PER_WORKER);
    // The writers really overlapped: in insert order the three sources alternate, they are not three blocks one after another.
    const order = (h.store.db!.prepare('SELECT summary FROM tickets ORDER BY number').all() as { summary: string }[]).map((r) => r.summary.split(/[- ]/)[0]);
    const switches = order.filter((x, i) => i > 0 && x !== order[i - 1]).length;
    assert.ok(switches > 10, `the sources interleave (${switches} switches)`);
    for (const bucket of ['KONF', 'CP']) {
      const ns = rows.filter((r) => r.b === bucket).map((r) => r.n);
      assert.deepEqual(ns, Array.from({ length: ns.length }, (_, i) => i + 1), `${bucket} is 1..n with no gap or repeat`);
      const next = h.store.db!.prepare('SELECT next_number AS n FROM ticket_buckets WHERE key = ?').get(bucket) as { n: number };
      assert.equal(next.n, ns.length + 1);
    }
  } finally {
    h.done();
  }
});

test('the old T-<n> and the bucket key resolve in every service call: get, update, comment, close, claim, find, search', async () => {
  const h = await ticketsHarness();
  try {
    h.tickets.create(UI, { summary: 'filler', bucket: 'CP' });
    const t = h.tickets.create(UI, { summary: 'Login redirect', bucket: 'KONF', workspaceId: 'docker/api' });
    assert.deepEqual([t.id, t.key], ['T-2', 'KONF-1']);
    for (const ref of ['T-2', '#2', '2', 'KONF-1', 'konf-1']) assert.equal(h.tickets.get(UI, ref).ticket.id, 'T-2', ref);
    assert.equal(code(() => h.tickets.get(UI, 'KONF-9')), 'NOT_FOUND:No such ticket.');
    assert.equal(code(() => h.tickets.get(UI, 'TB-1')), 'NOT_FOUND:No such ticket.');
    h.tickets.update(UI, 'KONF-1', { priority: 'high' });
    h.tickets.comment(UI, 'konf-1', 'via the key');
    assert.equal(h.tickets.resolve('KONF-1'), 'T-2');
    assert.equal(h.tickets.resolve('T-2'), 'T-2');
    assert.equal(h.tickets.resolve('KONF-2'), null);
    assert.equal(h.tickets.brief('KONF-1')!.key, 'KONF-1');
    assert.deepEqual(h.tickets.find({ branch: 'ticket/KONF-1-login', message: 'x\n\nTicket: T-2\nTicket: KONF-1\nTicket: CP-1' }), ['T-2', 'T-1']);
    assert.deepEqual(h.tickets.list(UI, { query: 'KONF-1' }).items.map((x) => x.id), ['T-2'], 'the search finds a key');
    assert.deepEqual(h.tickets.list(UI, { query: 'T-1' }).items.map((x) => x.id), ['T-1'], 'and the old id');
    // Claiming by key (an agent of its workspace).
    const s = h.sessions.add({ workspaceId: 'docker/api', id: 'lead' });
    assert.equal(h.tickets.claimNext(agent('docker/api', s.id), { id: 'KONF-1' })!.id, 'T-2');
    assert.equal(h.tickets.claimNext(agent('docker/api', s.id), { id: 'KONF-77' }), null, 'a key that names nothing claims nothing');
    const closed = h.tickets.close(agent('docker/api', s.id), 'KONF-1', { summary: 'done' });
    assert.equal(closed.status, 'done');
  } finally {
    h.done();
  }
});

test('the bucket a create lands in: named, the workspace’s, the session’s or its lead’s ticket’s, else PILOT; an agent only in its own', async () => {
  const h = await ticketsHarness();
  try {
    h.tickets.createBucket(UI, { key: 'API', name: 'API work', defaultWorkspaceId: 'docker/api', defaultTags: ['api'] });
    // The workspace's bucket, its default tags merged.
    const w = h.tickets.create(UI, { summary: 'in api', workspaceId: 'docker/api', tags: ['x'] });
    assert.deepEqual([w.key, w.tags], ['API-1', ['api', 'x']]);
    // No workspace named: the bucket's default workspace; an explicit null keeps the shared queue.
    const named = h.tickets.create(UI, { summary: 'named', bucket: 'API' });
    assert.equal(named.workspaceId, 'docker/api');
    assert.equal(h.tickets.create(UI, { summary: 'shared', bucket: 'API', workspaceId: null }).workspaceId, null);
    // An agent's workspace picks its bucket.
    h.sessions.add({ workspaceId: 'docker/api', id: 'a1' });
    assert.equal(h.tickets.create(agent('docker/api', 'a1'), { summary: 'from agent' }).bucket, 'API');
    // In a workspace with no bucket, the bucket of the ticket its lead works on.
    const konf = h.tickets.create(UI, { summary: 'konf lead work', bucket: 'KONF' });
    h.sessions.add({ workspaceId: 'docker/web', id: 'lead', ticketId: konf.id });
    h.sessions.add({ workspaceId: 'docker/web', id: 'w1', parentId: 'lead' });
    assert.equal(h.tickets.create(agent('docker/web', 'w1'), { summary: 'worker' }).bucket, 'KONF');
    // Nothing to go by: PILOT.
    h.sessions.add({ workspaceId: 'docker/web', id: 'lone' });
    assert.equal(h.tickets.create(agent('docker/web', 'lone'), { summary: 'lone' }).bucket, 'PILOT');
    // An agent may not file in another workspace's bucket: the same not found as a missing one.
    assert.equal(code(() => h.tickets.create(agent('docker/web', 'lone'), { summary: 'no', bucket: 'API' })), 'NOT_FOUND:No such bucket.');
    assert.equal(code(() => h.tickets.bucket(agent('docker/web', 'lone'), 'API')), 'NOT_FOUND:No such bucket.');
    assert.deepEqual(h.tickets.buckets(agent('docker/web', 'lone')).map((b) => b.key), ['CP', 'KONF', 'PILOT', 'TB']);
    assert.deepEqual(h.tickets.buckets(agent('docker/api', 'a1')).map((b) => b.key), ['API', 'CP', 'KONF', 'PILOT', 'TB']);
  } finally {
    h.done();
  }
});

test('bucket admin: a person or an admin token makes and changes one; an agent and a lesser token are refused; keys are checked', async () => {
  const h = await ticketsHarness();
  try {
    h.sessions.add({ workspaceId: 'docker/api', id: 'a1' });
    assert.equal(code(() => h.tickets.createBucket(agent('docker/api', 'a1'), { key: 'AG', name: 'x' })), 'FORBIDDEN');
    assert.equal(code(() => h.tickets.createBucket(token('t1', 'operate'), { key: 'AG', name: 'x' })), 'FORBIDDEN');
    assert.equal(code(() => h.tickets.createBucket(UI, { key: 'X', name: 'x' })), 'VALIDATION_FAILED');
    assert.equal(code(() => h.tickets.createBucket(UI, { key: 'AB1', name: 'x' })), 'VALIDATION_FAILED');
    assert.equal(code(() => h.tickets.createBucket(UI, { key: 'KONF', name: 'again' })), 'CONFLICT');
    assert.equal(code(() => h.tickets.createBucket(UI, { key: 'NONAME' })), 'VALIDATION_FAILED');
    const b = h.tickets.createBucket(token('t2', 'admin'), { key: 'ops', name: 'Ops', vaultId: 'v_ops' });
    assert.deepEqual([b.key, b.name, b.nextNumber, b.vaultId, b.open], ['OPS', 'Ops', 1, 'v_ops', 0]);
    const u = h.tickets.updateBucket(UI, 'OPS', { description: 'Operations', defaultTags: ['ops'], vaultId: null });
    assert.deepEqual([u.description, u.defaultTags, u.vaultId, u.name], ['Operations', ['ops'], null, 'Ops']);
    assert.equal(code(() => h.tickets.updateBucket(UI, 'NOPE', { name: 'x' })), 'NOT_FOUND:No such bucket.');
    assert.equal(h.tickets.bucketOwner('OPS'), 'u_owner');
  } finally {
    h.done();
  }
});

test('a list filters by bucket and counts unfinished tickets per bucket', async () => {
  const h = await ticketsHarness();
  try {
    h.tickets.create(UI, { summary: 'k1', bucket: 'KONF' });
    h.tickets.create(UI, { summary: 'k2', bucket: 'KONF' });
    const done = h.tickets.create(UI, { summary: 'c1', bucket: 'CP' });
    h.tickets.close(UI, done.id, { summary: 'ok' });
    const l = h.tickets.list(UI, { bucket: 'KONF' });
    assert.deepEqual(l.items.map((t) => t.key).sort(), ['KONF-1', 'KONF-2']);
    assert.deepEqual(l.counts.byBucket, { KONF: 2 });
    assert.equal(h.tickets.listPage(UI, { bucket: 'CP', includeClosed: true }).items.length, 1);
  } finally {
    h.done();
  }
});

test('migration 47 puts existing tickets in buckets by tag, numbers each bucket in creation order, and the counters continue', async () => {
  assert.ok(MIGRATIONS.some((m) => m.version === 47 && m.name.startsWith('tickets: buckets')));
  const secretKey = parseSecretKey(generateSecretKey());
  const dataDir = tempDirectory('cp-tickets-buckets-');
  const old = await Store.open({ dataDir, secretKey, migrations: MIGRATIONS.filter((m) => m.version !== 47) });
  const insert = old.db!.prepare(
    "INSERT INTO tickets (type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, created_at, updated_at) VALUES ('task', 'normal', 2, 'open', ?, 'human', 'ui', 'Admin', ?, ?)",
  );
  const tag = old.db!.prepare('INSERT INTO ticket_tags (ticket_number, tag) VALUES (?, ?)');
  // Created out of number order on purpose: T-3 is older than T-1.
  const made: [string, string, string[]][] = [
    ['k-late', '2026-10-03T00:00:00.000Z', ['konfersi-migration']],
    ['cp', '2026-10-02T00:00:00.000Z', ['claudepilot', 'ui']],
    ['k-early', '2026-10-01T00:00:00.000Z', ['konfersi-migration', 'claudepilot']],
    ['tb', '2026-10-04T00:00:00.000Z', ['tradingbot']],
    ['other', '2026-10-05T00:00:00.000Z', ['misc']],
    ['bare', '2026-10-06T00:00:00.000Z', []],
  ];
  made.forEach(([summary, at, tags], i) => {
    insert.run(summary, at, at);
    for (const t of tags) tag.run(i + 1, t);
  });
  old.close();

  const store = await Store.open({ dataDir, secretKey });
  try {
    const rows = store.db!.prepare('SELECT summary, bucket_key AS b, bucket_number AS n FROM tickets ORDER BY number').all().map((r) => ({ ...r }));
    assert.deepEqual(rows, [
      { summary: 'k-late', b: 'KONF', n: 2 },
      { summary: 'cp', b: 'CP', n: 1 },
      { summary: 'k-early', b: 'KONF', n: 1 },
      { summary: 'tb', b: 'TB', n: 1 },
      { summary: 'other', b: 'PILOT', n: 1 },
      { summary: 'bare', b: 'PILOT', n: 2 },
    ]);
    const next = Object.fromEntries((store.db!.prepare('SELECT key, next_number AS n FROM ticket_buckets').all() as { key: string; n: number }[]).map((r) => [r.key, r.n]));
    assert.deepEqual(next, { CP: 2, KONF: 3, PILOT: 3, TB: 2 });
    // A new row continues its bucket's count.
    store.db!.prepare("INSERT INTO tickets (type, priority, priority_rank, status, summary, source, reporter_kind, reporter_label, created_at, updated_at, bucket_key) VALUES ('task', 'normal', 2, 'open', 'new', 'human', 'ui', 'Admin', 'x', 'x', 'KONF')").run();
    assert.equal((store.db!.prepare("SELECT bucket_number AS n FROM tickets WHERE summary = 'new'").get() as { n: number }).n, 3);
    assert.throws(() => store.db!.prepare("INSERT INTO ticket_buckets (key, name, created_at, updated_at) VALUES ('ab', 'x', 'x', 'x')").run(), /CHECK/, 'keys are capitals');
  } finally {
    store.close();
  }
});
