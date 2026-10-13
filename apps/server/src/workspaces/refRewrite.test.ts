// T-42 slice 3 (docs/prd/targets-connect.md §24.4): stored workspace references move from `<target>/<name>` to the stable id. A converted
// module (tickets, the first) writes the id on save, reads either form as the key, and matches either form in a filter; the one-time
// background rewrite moves the rows written before, and is safe to stop and to run again. The payoff: rows of a REMOVED workspace keep its
// id, so a new workspace that takes the name does not inherit them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agent, ticketsHarness, UI } from '../tickets/testkit.js';
import { WorkspaceIdentities } from './identity.js';
import { REF_COLUMNS, rewriteWorkspaceRefs } from './refRewrite.js';

const STABLE = /^ws_[0-9a-f]{12}$/;

async function world() {
  let ids!: WorkspaceIdentities;
  const h = await ticketsHarness({ workspaceRefs: { storedRef: (r) => ids.storedRef(r), keyOf: (s) => ids.keyOf(s), storedForms: (r) => ids.storedForms(r) } });
  ids = new WorkspaceIdentities(h.store);
  const stored = (number: number) => (h.store.db!.prepare('SELECT workspace_id FROM tickets WHERE number = ?').get(number) as { workspace_id: string | null }).workspace_id;
  /** A ticket as it was written before slice 3: the key in the column. */
  const legacy = (workspaceId: string | null) => {
    const t = h.tickets.create(UI, { summary: `old ${workspaceId}` });
    h.store.db!.prepare('UPDATE tickets SET workspace_id = ? WHERE number = ?').run(workspaceId, t.number);
    return t.number;
  };
  return { h, ids: () => ids, stored, legacy };
}

test('tickets: written with the stable id, read as the key, found by either form; an agent still sees its own and the shared queue', async () => {
  const { h, ids, stored, legacy } = await world();
  try {
    const api = ids().allocate('docker', 'api');
    const t = h.tickets.create(UI, { summary: 'new', workspaceId: 'docker/api' });
    assert.equal(stored(t.number), api.id, 'the row holds the id');
    assert.equal(t.workspaceId, 'docker/api', 'the API still speaks the key');
    const old = legacy('docker/api');
    assert.equal(h.tickets.get(UI, `T-${old}`).ticket.workspaceId, 'docker/api', 'an old row reads as it is');
    const byKey = h.tickets.list(UI, { workspaceId: 'docker/api' }).items.map((x) => x.number).sort();
    assert.deepEqual(byKey, [t.number, old].sort(), 'a filter matches both forms');
    const shared = h.tickets.create(UI, { summary: 'shared' });
    const other = h.tickets.create(UI, { summary: 'other', workspaceId: 'docker/web' });
    const seen = h.tickets.list(agent('docker/api', 's1'), {}).items.map((x) => x.number).sort();
    assert.deepEqual(seen, [t.number, old, shared.number].sort(), 'an agent sees its workspace’s tickets in either form, and the shared queue');
    assert.ok(!seen.includes(other.number));
    // A move to another workspace writes that one's id (or the key, when it has none).
    h.tickets.update(UI, `T-${t.number}`, { workspaceId: 'docker/web' });
    assert.equal(stored(t.number), 'docker/web');
    const web = ids().allocate('docker', 'web');
    h.tickets.update(UI, `T-${other.number}`, { workspaceId: 'docker/api' });
    h.tickets.update(UI, `T-${other.number}`, { workspaceId: 'docker/web' });
    assert.equal(stored(other.number), web.id);
  } finally {
    h.done();
  }
});

test('a removed workspace keeps its rows: a new workspace that takes the name does not inherit its tickets', async () => {
  const { h, ids } = await world();
  try {
    ids().allocate('docker', 'api');
    const before = h.tickets.create(UI, { summary: 'for the first api', workspaceId: 'docker/api' });
    ids().retire('docker', 'api');
    const second = ids().allocate('docker', 'api');
    const after = h.tickets.create(UI, { summary: 'for the second api', workspaceId: 'docker/api' });
    assert.deepEqual(h.tickets.list(UI, { workspaceId: 'docker/api' }).items.map((x) => x.number), [after.number]);
    assert.deepEqual(h.tickets.list(agent('docker/api', 's9'), {}).items.map((x) => x.number), [after.number], 'nor does its agent');
    assert.throws(() => h.tickets.get(agent('docker/api', 's9'), before.id), 'not even by its id');
    assert.equal(h.tickets.get(UI, before.id).ticket.workspaceId, 'docker/api', 'the old ticket still says which workspace it was');
    assert.equal(ids().storedRef('docker/api'), second.id, 'new rows go to the new workspace');
  } finally {
    h.done();
  }
});

test('the background rewrite moves the old rows of live workspaces, keeps the rest, marks the column done, and a rerun changes nothing', async () => {
  const { h, ids, stored, legacy } = await world();
  try {
    const api = ids().allocate('docker', 'api');
    const rows = [legacy('docker/api'), legacy('docker/api'), legacy('docker/gone'), legacy(null), legacy('docker/api')];
    const fresh = h.tickets.create(UI, { summary: 'already an id', workspaceId: 'docker/api' }).number;
    const [r] = await rewriteWorkspaceRefs(h.store, ids(), { pauseMs: 0, batch: 2 });
    assert.deepEqual([r!.table, r!.column, r!.rewritten, r!.kept, r!.done], ['tickets', 'workspace_id', 3, 1, true]);
    assert.deepEqual(rows.map(stored), [api.id, api.id, 'docker/gone', null, api.id]);
    assert.equal(stored(fresh), api.id);
    assert.ok(h.store.db!.prepare("SELECT done_at FROM workspace_ref_rewrites WHERE table_name = 'tickets' AND column_name = 'workspace_id'").get());
    assert.deepEqual(await rewriteWorkspaceRefs(h.store, ids(), { pauseMs: 0 }), [], 'a column that is done is not walked again');
    // And nothing reads differently after it.
    assert.deepEqual(h.tickets.list(UI, { workspaceId: 'docker/api' }).items.map((x) => x.number).sort(), [...rows.filter((_, i) => i !== 2 && i !== 3), fresh].sort());
  } finally {
    h.done();
  }
});

test('the rewrite is safe to stop half way and to run again: what was done stays, the rest follows, nothing twice', async () => {
  const { h, ids, stored, legacy } = await world();
  try {
    const api = ids().allocate('docker', 'api');
    const rows = Array.from({ length: 6 }, () => legacy('docker/api'));
    const stop = new AbortController();
    // Stop after the first batch: the pause between batches is where the abort lands.
    let first: Awaited<ReturnType<typeof rewriteWorkspaceRefs>> = [];
    const run = rewriteWorkspaceRefs(h.store, ids(), { batch: 2, pauseMs: 30, signal: stop.signal }).then((r) => (first = r));
    await new Promise((res) => setTimeout(res, 10));
    stop.abort();
    await run;
    assert.equal(first[0]!.done, false);
    const moved = rows.filter((n) => stored(n) === api.id).length;
    assert.ok(moved >= 2 && moved < rows.length, `stopped part way (${moved} moved)`);
    assert.equal(h.store.db!.prepare('SELECT count(*) AS n FROM workspace_ref_rewrites').get()!.n, 0, 'not marked done');
    // A row changed meanwhile by its module is left as the module wrote it.
    h.store.db!.prepare('UPDATE tickets SET workspace_id = ? WHERE number = ?').run('docker/web', rows[5]!);
    const [again] = await rewriteWorkspaceRefs(h.store, ids(), { pauseMs: 0 });
    assert.equal(again!.done, true);
    assert.equal(again!.rewritten, rows.length - 1 - moved, 'only what was left');
    assert.deepEqual(rows.slice(0, 5).map(stored), Array(5).fill(api.id));
    assert.equal(stored(rows[5]!), 'docker/web', 'no live workspace has that key: kept');
  } finally {
    h.done();
  }
});

test('only known column names reach SQL', async () => {
  const { h, ids } = await world();
  try {
    assert.ok(REF_COLUMNS.every((c) => /^[a-z_]+$/.test(c.table) && /^[a-z_]+$/.test(c.column)));
    await assert.rejects(rewriteWorkspaceRefs(h.store, ids(), { columns: [{ table: 'tickets; DROP TABLE tickets', column: 'x' }] }), /not a column name/);
    assert.ok(STABLE.test(ids().allocate('docker', 'x').id));
  } finally {
    h.done();
  }
});

test('an agent: its ticket stores the id and reads as the key; an old row with the key still is its own, and it can claim it', async () => {
  const { h, ids, stored, legacy } = await world();
  try {
    const api = ids().allocate('docker', 'api');
    h.sessions.add({ id: 's1', workspaceId: 'docker/api' });
    const me = agent('docker/api', 's1');
    const mine = h.tickets.create(me, { summary: 'made by the agent' });
    assert.equal(stored(mine.number), api.id, 'the row holds the id');
    assert.equal(mine.workspaceId, 'docker/api', 'and reads as the key');
    assert.equal(h.tickets.get(me, mine.id).ticket.workspaceId, 'docker/api');
    const old = legacy('docker/api');
    assert.equal(h.tickets.get(me, `T-${old}`).ticket.workspaceId, 'docker/api', 'an old row is still its own');
    h.tickets.update(UI, mine.id, { status: 'done' });
    const claimed = h.tickets.claimNext(me, {});
    assert.equal(claimed?.number, old, 'and it can claim it');
    assert.equal(stored(old), api.id, 'a claim writes the id');
    // No "workspace changed" entry for a row that only changed form.
    const events = h.store.db!.prepare("SELECT count(*) AS n FROM ticket_events WHERE ticket_number = ? AND kind = 'workspace'").get(old) as { n: number };
    assert.equal(events.n, 0);
  } finally {
    h.done();
  }
});

test('after a rename (slice 2) the tickets keep resolving: by the key, by the new label, and for its agent', async () => {
  const { h, ids, legacy } = await world();
  try {
    const api = ids().allocate('docker', 'api');
    const t = h.tickets.create(UI, { summary: 'before the rename', workspaceId: 'docker/api' });
    const old = legacy('docker/api');
    ids().relabel(api.id, 'isnan-pod');
    const want = [t.number, old].sort();
    assert.deepEqual(h.tickets.list(UI, { workspaceId: 'docker/api' }).items.map((x) => x.number).sort(), want);
    assert.deepEqual(h.tickets.list(UI, { workspaceId: 'docker/isnan-pod' }).items.map((x) => x.number).sort(), want, 'the label is a form of it');
    assert.deepEqual(h.tickets.list(agent('docker/api', 's1'), {}).items.map((x) => x.number).sort(), want);
    assert.equal(h.tickets.get(UI, t.id).ticket.workspaceId, 'docker/api', 'the key never changes with a rename');
  } finally {
    h.done();
  }
});

test('a removed workspace: its rows still holding the key (not yet rewritten) are given its id at the remove, so the next of that name never sees them', async () => {
  const { h, ids, stored, legacy } = await world();
  try {
    const first = ids().allocate('docker', 'api');
    const old = legacy('docker/api');
    const shared = legacy(null);
    const elsewhere = legacy('docker/web');
    ids().retire('docker', 'api');
    assert.equal(stored(old), first.id, 'pinned to the removed workspace');
    assert.equal(stored(shared), null);
    assert.equal(stored(elsewhere), 'docker/web', 'other workspaces untouched');
    ids().allocate('docker', 'api');
    h.sessions.add({ id: 's2', workspaceId: 'docker/api' });
    const next = agent('docker/api', 's2');
    assert.deepEqual(h.tickets.list(next, {}).items.map((x) => x.number), [shared]);
    assert.throws(() => h.tickets.get(next, `T-${old}`));
    assert.equal(h.tickets.claimNext(next, { id: `T-${old}` }), null, 'nor claim it');
    assert.equal(h.tickets.get(UI, `T-${old}`).ticket.workspaceId, 'docker/api', 'it still says which workspace it was');
  } finally {
    h.done();
  }
});

test('the rewrite stops between two rows when aborted (mid batch), records nothing, and the next run finishes and records the column', async () => {
  const { h, ids, stored, legacy } = await world();
  try {
    const api = ids().allocate('docker', 'api');
    const rows = Array.from({ length: 5 }, () => legacy('docker/api'));
    const stop = new AbortController();
    let calls = 0;
    const real = ids();
    // A registry that aborts while the third row is being looked at: the batch (of 50) is cut there, between rows.
    const aborting = Object.assign(Object.create(real) as typeof real, {
      storedRef: (r: string | null) => {
        if (++calls === 3) stop.abort();
        return real.storedRef(r);
      },
    });
    const [first] = await rewriteWorkspaceRefs(h.store, aborting, { batch: 50, pauseMs: 0, signal: stop.signal });
    assert.deepEqual([first!.rewritten, first!.done], [3, false]);
    assert.deepEqual(rows.map(stored), [api.id, api.id, api.id, 'docker/api', 'docker/api']);
    assert.equal((h.store.db!.prepare('SELECT count(*) AS n FROM workspace_ref_rewrites').get() as { n: number }).n, 0);
    const [second] = await rewriteWorkspaceRefs(h.store, real, { pauseMs: 0 });
    assert.deepEqual([second!.rewritten, second!.done], [2, true]);
    assert.deepEqual(rows.map(stored), Array(5).fill(api.id));
    const rec = h.store.db!.prepare("SELECT rewritten, done_at FROM workspace_ref_rewrites WHERE table_name = 'tickets' AND column_name = 'workspace_id'").get() as { rewritten: number; done_at: string };
    assert.equal(rec.rewritten, 2, 'the rows the finishing pass moved');
    assert.ok(!Number.isNaN(Date.parse(rec.done_at)));
  } finally {
    h.done();
  }
});
