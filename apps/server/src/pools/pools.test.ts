import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AppError, isAppError } from '@isnanme/core';
import type { PoolDetail, PoolPreview, PoolSummary, SetWorkspacePoolsResult, WorkspacePools } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { Reconciler, type FragmentProvider } from '../delivery/reconciler.js';
import { MANIFEST_PATH, NODE, ROOT, type Fragment, type Manifest } from '../delivery/types.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { Store } from '../store/store.js';
import type { DeliveryAccess, Runtime } from '../workspaces/runtime.js';
import type { PoolKind } from './kinds.js';
import { createPoolRoutes, createWorkspacePoolRoutes } from './routes.js';
import { PoolService } from './service.js';

/* ---------- A dummy kind, registered only here ---------- */

/** Files and variables, plus a write-only token kept as side data (like a secret value version). */
interface Dummy {
  files: Record<string, string>;
  env: Record<string, string>;
  tokenId: number | null;
  review: boolean;
}

const asRecord = (v: unknown): Record<string, string> =>
  v && typeof v === 'object' && Object.values(v).every((x) => typeof x === 'string') ? (v as Record<string, string>) : {};

function dummyKind(store: Store, hooks: Partial<PoolKind<Dummy>> = {}): PoolKind<Dummy> {
  const db = () => store.db!;
  return {
    type: 'secrets',
    parse(input, prev, ctx) {
      const i = (input ?? {}) as { files?: unknown; env?: unknown; token?: unknown; review?: unknown };
      if (i.files !== undefined && (typeof i.files !== 'object' || i.files === null))
        throw new AppError('VALIDATION_FAILED', 'Files must be an object.', { details: { files: 'Files must be an object.' } });
      let tokenId = prev?.tokenId ?? null;
      if (typeof i.token === 'string') {
        tokenId = Number(db().prepare('INSERT INTO dummy_values (pool_id, value) VALUES (?, ?)').run(ctx!.poolId, i.token).lastInsertRowid);
      } else if (tokenId !== null) {
        // Duplicating: the value belongs to another pool, so the copy gets its own.
        const row = db().prepare('SELECT pool_id, value FROM dummy_values WHERE id = ?').get(tokenId) as { pool_id: string; value: string };
        if (row.pool_id !== ctx!.poolId) tokenId = Number(db().prepare('INSERT INTO dummy_values (pool_id, value) VALUES (?, ?)').run(ctx!.poolId, row.value).lastInsertRowid);
      }
      return { files: asRecord(i.files), env: asRecord(i.env), tokenId, review: i.review === true };
    },
    view: (c) => ({ files: c.files, env: c.env, hasToken: c.tokenId !== null, review: c.review }),
    review: (c) => (c.review ? 'waiting_review' : 'deliverable'),
    parseOptions(input) {
      const skip = (input as { skip?: unknown } | undefined)?.skip;
      if (skip === undefined) return {};
      if (!Array.isArray(skip)) throw new AppError('VALIDATION_FAILED', 'skip must be a list.');
      return { skip };
    },
    fragments(assigned, ctx) {
      const out: Fragment[] = [];
      const env: Record<string, string> = {};
      for (const a of assigned) {
        const skip = (a.options.skip as string[] | undefined) ?? [];
        const files = Object.entries(a.content.files)
          .filter(([name]) => !skip.includes(name))
          .map(([name, content]) => ({ path: `/etc/claudepilot/secrets/${a.pool.id}/${name}`, content, mode: 0o440, uid: ROOT, gid: NODE }));
        if (a.content.tokenId !== null) {
          const row = db().prepare('SELECT value FROM dummy_values WHERE id = ?').get(a.content.tokenId) as { value: string };
          files.push({ path: `/etc/claudepilot/secrets/${a.pool.id}/token`, content: row.value, mode: 0o440, uid: ROOT, gid: NODE, secretRef: `dummy:${a.content.tokenId}` } as never);
        }
        out.push({ owner: 'secrets', pool: { id: a.pool.id, revision: a.pool.revision }, files });
        Object.assign(env, ctx.preview ? Object.fromEntries(Object.keys(a.content.env).map((k) => [k, '«value»'])) : a.content.env);
      }
      if (Object.keys(env).length) out.push({ owner: 'secrets', settings: { env } });
      return out;
    },
    ...hooks,
  };
}

/** A fake reconciler for service tests: records requests. */
function fakeReconciler() {
  const calls: { id: string; why: string; changed: boolean }[] = [];
  return { calls, request: (id: string, why = '', opts: { changed?: boolean } = {}) => (calls.push({ id, why, changed: !!opts.changed }), Promise.resolve()) };
}

async function setup(hooks: Partial<PoolKind<Dummy>> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cp-pools-'));
  const store = await Store.open({ dataDir, secretKey: parseSecretKey(generateSecretKey()) });
  store.db!.exec('CREATE TABLE dummy_values (id INTEGER PRIMARY KEY, pool_id TEXT NOT NULL, value TEXT NOT NULL) STRICT');
  const providers: FragmentProvider[] = [];
  const service = new PoolService(store, { providers });
  service.register(dummyKind(store, hooks));
  const reconciler = fakeReconciler();
  service.reconciler = reconciler;
  let changes = 0;
  service.onChange = () => void changes++;
  const done = () => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  };
  return { store, service, providers, reconciler, changes: () => changes, done, dataDir };
}

const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;
const values = (store: Store) => (store.db!.prepare('SELECT count(*) AS n FROM dummy_values').get() as { n: number }).n;
const removals = (store: Store, ws = 'docker/ws1') =>
  (store.db!.prepare('SELECT pool_type, pool_id FROM removals WHERE workspace_id = ?').all(ws) as { pool_type: string; pool_id: string }[]).map((r) => ({ ...r }));

/* ---------- Service ---------- */

test('the migration gives revisions a status and assignments options; existing rows stay deliverable', async () => {
  const h = await setup();
  try {
    const db = h.store.db!;
    db.exec(`INSERT INTO pools (id, type, name, current_revision, created_at, updated_at) VALUES ('acc', 'account', 'main', 1, 'x', 'x');
      INSERT INTO pool_revisions (pool_id, revision, content, created_at) VALUES ('acc', 1, '{}', 'x');
      INSERT INTO assignments (workspace_id, pool_id, pool_type, assigned_at) VALUES ('docker/a', 'acc', 'account', 'x');`);
    assert.deepEqual({ ...(db.prepare('SELECT status, rollout_paused_at FROM pool_revisions').get() as object) }, { status: 'deliverable', rollout_paused_at: null });
    assert.deepEqual({ ...(db.prepare('SELECT options, delivered_revision FROM assignments').get() as object) }, { options: '{}', delivered_revision: null });
    assert.throws(() => db.exec("UPDATE pool_revisions SET status = 'approved'"), /CHECK/);
  } finally {
    h.done();
  }
});

test('pools: every content change is a new revision; the same content or a rename makes none', async () => {
  const h = await setup();
  try {
    const p = h.service.create('secrets', { name: ' Team ', description: 'Shared', content: { files: { a: '1' } }, note: 'first' });
    assert.deepEqual([p.name, p.revision, p.latestRevision, p.status, p.workspaces], ['Team', 1, 1, 'deliverable', 0]);
    assert.deepEqual(p.content, { files: { a: '1' }, env: {}, hasToken: false, review: false });

    const r2 = h.service.update(p.id, { content: { files: { a: '2' } }, note: 'changed a' });
    assert.equal(r2.revision, 2);
    const same = h.service.update(p.id, { name: 'Team 2', content: { files: { a: '2' } } });
    assert.deepEqual([same.revision, same.latestRevision, same.name], [2, 2, 'Team 2']);

    const detail = h.service.get(p.id);
    assert.deepEqual(detail.revisions.map((r) => [r.revision, r.status, r.note, r.current]), [
      [2, 'deliverable', 'changed a', true],
      [1, 'deliverable', 'first', false],
    ]);
    assert.ok(h.changes() >= 3, 'every change tells live pages');
    assert.deepEqual(h.service.list('secrets').map((x) => x.id), [p.id]);
  } finally {
    h.done();
  }
});

test('pools: a save that names the revision it opened is refused when the pool has moved on (baseRevision), and one that doesn’t name it still works', async () => {
  const h = await setup();
  try {
    const p = h.service.create('secrets', { name: 'Team', content: { files: { a: '1' } } });
    // Two tabs open r1; the first saves r2.
    const first = h.service.update(p.id, { content: { files: { a: '2' } }, baseRevision: 1 });
    assert.equal(first.latestRevision, 2);
    // The second still holds r1: refused, nothing overwritten, and it is told where things stand.
    assert.throws(
      () => h.service.update(p.id, { content: { files: { a: 'other' } }, baseRevision: 1 }),
      (e) => isAppError(e) && e.code === 'CONFLICT' && /Team changed since you opened it \(r2\)\. Reload to see it\./.test(e.message),
    );
    assert.throws(() => h.service.update(p.id, { name: 'Renamed', baseRevision: 1 }), (e) => isAppError(e) && e.code === 'CONFLICT', 'a rename is held to it too');
    assert.deepEqual(h.service.get(p.id).content, { files: { a: '2' }, env: {}, hasToken: false, review: false });
    assert.equal(h.service.get(p.id).name, 'Team');
    // After a reload it saves; callers that don't send it (the MCP tools, older pages) are unchanged.
    assert.equal(h.service.update(p.id, { content: { files: { a: '3' } }, baseRevision: 2 }).latestRevision, 3);
    assert.equal(h.service.update(p.id, { content: { files: { a: '4' } } }).latestRevision, 4);
    assert.throws(() => h.service.update(p.id, { content: { files: { a: '5' } }, baseRevision: -1 }), (e) => isAppError(e) && e.code === 'VALIDATION_FAILED');
    assert.throws(() => h.service.update(p.id, { content: { files: { a: '5' } }, baseRevision: 1.5 }), (e) => isAppError(e) && e.code === 'VALIDATION_FAILED');
  } finally {
    h.done();
  }
});

test('pools: names are unique per type, and bad input is refused with details', async () => {
  const h = await setup();
  try {
    h.service.create('secrets', { name: 'Team', content: {} });
    assert.throws(() => h.service.create('secrets', { name: 'team', content: {} }), (e: AppError) => e.code === 'CONFLICT' && /already exists/.test(e.message));
    assert.throws(() => h.service.create('secrets', { name: '  ', content: {} }), (e: AppError) => e.code === 'VALIDATION_FAILED' && (e.details as { name?: string }).name !== undefined);
    assert.throws(() => h.service.create('secrets', { name: 'x'.repeat(61), content: {} }), code('VALIDATION_FAILED'));
    assert.throws(() => h.service.create('secrets', { name: 'Bad', content: { files: 'nope' } }), code('VALIDATION_FAILED'));
    assert.equal(h.service.list('secrets').length, 1, 'a refused create leaves nothing behind');
    assert.throws(() => h.service.list('skillset'), code('NOT_FOUND'), 'unregistered types are unknown');
    assert.throws(() => h.service.kind('account'), code('NOT_FOUND'));
  } finally {
    h.done();
  }
});

test('review: a revision waiting for review never becomes current until approved, and the kind may refuse', async () => {
  let refuse = true;
  const h = await setup({
    approve: () => {
      if (refuse) throw new AppError('CONFLICT', 'A skill is still unreviewed.');
    },
  });
  try {
    const waiting = h.service.create('secrets', { name: 'Reviewed', content: { review: true } });
    assert.deepEqual([waiting.revision, waiting.latestRevision, waiting.status], [0, 1, 'waiting_review'], 'nothing deliverable yet');

    const p = h.service.create('secrets', { name: 'Live', content: { files: { a: '1' } } });
    h.service.assignToMany(p.id, ['docker/ws1']);
    h.reconciler.calls.length = 0;
    const r2 = h.service.update(p.id, { content: { files: { a: '2' }, review: true } });
    assert.deepEqual([r2.revision, r2.latestRevision, r2.status], [1, 2, 'waiting_review']);
    assert.equal(h.reconciler.calls.length, 0, 'a waiting revision reaches nobody');
    assert.equal(h.service.assignedPools('docker/ws1', 'secrets')[0]!.pool.revision, 1);

    assert.throws(() => h.service.approve(p.id, 2), /unreviewed/);
    refuse = false;
    const approved = h.service.approve(p.id, 2);
    assert.deepEqual([approved.revision, approved.status], [2, 'deliverable']);
    assert.deepEqual(h.reconciler.calls.map((c) => [c.id, c.changed]), [['docker/ws1', true]]);
    assert.equal(h.service.approve(p.id, 2).revision, 2, 'approving again changes nothing');
    assert.throws(() => h.service.approve(p.id, 9), code('NOT_FOUND'));
  } finally {
    h.done();
  }
});

test('drafts and held revisions stay out of delivery; make current promotes one or rolls back', async () => {
  const h = await setup();
  try {
    const p = h.service.create('secrets', { name: 'Set', content: { files: { a: '1' } } });
    const draft = h.service.update(p.id, { content: { files: { a: 'draft' } }, draft: true });
    assert.deepEqual([draft.revision, draft.latestRevision, draft.status], [1, 2, 'draft']);
    assert.throws(() => h.service.makeCurrent(p.id, 2), code('CONFLICT'), 'a draft is not deliverable');

    const held = h.service.update(p.id, { content: { files: { a: 'trial' } }, hold: true });
    assert.deepEqual([held.revision, held.latestRevision, held.status], [1, 3, 'deliverable'], 'deliverable, but not current');
    // Pin a trial workspace to it, while the others keep following r1.
    h.service.setAssignments('docker/trial', 'secrets', [{ poolId: p.id, pinnedRevision: 3 }]);
    h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: p.id }]);
    assert.equal(h.service.assignedPools('docker/trial', 'secrets')[0]!.pool.revision, 3);
    assert.equal(h.service.assignedPools('docker/ws1', 'secrets')[0]!.pool.revision, 1);

    h.reconciler.calls.length = 0;
    assert.equal(h.service.makeCurrent(p.id, 3).revision, 3);
    assert.deepEqual(h.reconciler.calls.map((c) => c.id), ['docker/ws1'], 'only workspaces following the current revision');
    assert.equal(h.service.makeCurrent(p.id, 1).revision, 1, 'roll back');
    assert.equal(h.service.assignedPools('docker/ws1', 'secrets')[0]!.pool.revision, 1);
  } finally {
    h.done();
  }
});

test('roll back (FR18): a kind that keeps values outside its revisions publishes the roll back as a new revision; forward moves and plain kinds just point', async () => {
  const calls: { target: Dummy; current: Dummy | null; restoreSecrets: boolean }[] = [];
  const h = await setup({
    // What a kind with rotating values does: the old content, with the value as workspaces have it now.
    rollback: (target, current, opts) => {
      calls.push({ target, current, restoreSecrets: opts.restoreSecrets });
      return opts.restoreSecrets ? target : { ...target, tokenId: current?.tokenId ?? null };
    },
  });
  try {
    const p = h.service.create('secrets', { name: 'Set', content: { files: { a: 'one' }, token: 'old-token' } });
    const old = h.service.assignedPools('docker/none', 'secrets');
    void old;
    h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: p.id }]);
    h.service.update(p.id, { content: { files: { a: 'two' }, token: 'new-token' } });
    const tokenOf = (rev: number) => (JSON.parse((h.store.db!.prepare('SELECT content FROM pool_revisions WHERE pool_id = ? AND revision = ?').get(p.id, rev) as { content: string }).content) as Dummy).tokenId;
    assert.notEqual(tokenOf(1), tokenOf(2));

    h.reconciler.calls.length = 0;
    const back = h.service.makeCurrent(p.id, 1);
    assert.deepEqual([back.revision, back.latestRevision], [3, 3], 'a new revision, not a pointer at r1');
    assert.deepEqual(calls.map((c) => c.restoreSecrets), [false]);
    const detail = h.service.get(p.id);
    assert.equal(detail.revisions[0]!.note, 'Rolled back to r1 (secrets keep their current versions)');
    assert.equal(tokenOf(3), tokenOf(2), 'the token keeps the version workspaces had');
    assert.equal((JSON.parse((h.store.db!.prepare('SELECT content FROM pool_revisions WHERE pool_id = ? AND revision = 3').get(p.id) as { content: string }).content) as Dummy).files.a, 'one', 'the rest is r1');
    assert.equal(tokenOf(1), tokenOf(1), 'history is never rewritten');
    assert.deepEqual(h.reconciler.calls.map((c) => [c.id, c.why]), [['docker/ws1', 'rolled back']]);
    assert.equal(h.service.assignedPools('docker/ws1', 'secrets')[0]!.pool.revision, 3);

    // Restoring the old version is a choice. The content is then r1's exactly, so r1 itself becomes current.
    const restored = h.service.makeCurrent(p.id, 1, { restoreSecretVersions: true });
    assert.deepEqual([restored.revision, restored.latestRevision], [1, 3]);
    assert.deepEqual(calls.map((c) => c.restoreSecrets), [false, true]);
    // Where r1 isn't the same as what would be published (here r2 with the current token), a new revision says so.
    h.service.makeCurrent(p.id, 3);
    h.service.update(p.id, { content: { files: { a: 'newer' }, token: 'newest-token' } });
    const again = h.service.makeCurrent(p.id, 3, { restoreSecretVersions: true });
    assert.deepEqual([again.revision, again.latestRevision], [3, 4], 'r3 is what it holds, so it is a pointer move too');
    h.service.update(p.id, { content: { files: { a: 'x' }, token: 'fifth-token' } });
    const fifth = h.service.makeCurrent(p.id, 2, { restoreSecretVersions: false });
    assert.equal(fifth.revision, 6);
    assert.equal(h.service.get(p.id).revisions[0]!.note, 'Rolled back to r2 (secrets keep their current versions)');
    assert.equal(tokenOf(6), tokenOf(5));
    assert.equal(JSON.stringify((JSON.parse((h.store.db!.prepare('SELECT content FROM pool_revisions WHERE pool_id = ? AND revision = 6').get(p.id) as { content: string }).content) as Dummy).files), JSON.stringify({ a: 'two' }));

    // Moving forward to a deliverable revision is a pointer move: the hook isn't asked.
    calls.length = 0;
    assert.equal(h.service.makeCurrent(p.id, 6).revision, 6, 'already current');
    h.service.update(p.id, { content: { files: { a: 'held' } }, hold: true });
    assert.equal(h.service.makeCurrent(p.id, 7).revision, 7);
    assert.deepEqual(calls, []);
    assert.equal(h.service.get(p.id).latestRevision, 7);
  } finally {
    h.done();
  }
});

test('roll back: content that would be the same is just a pointer move, and a refusal changes nothing', async () => {
  let refuse = false;
  const h = await setup({
    rollback: (target) => {
      if (refuse) throw new AppError('CONFLICT', 'A name is in use.');
      return target;
    },
  });
  try {
    const p = h.service.create('secrets', { name: 'Set', content: { files: { a: '1' } } });
    h.service.update(p.id, { content: { files: { a: '2' } } });
    assert.equal(h.service.makeCurrent(p.id, 1).revision, 1, 'no new revision when the hook returns the target');
    assert.equal(h.service.get(p.id).latestRevision, 2);

    h.service.makeCurrent(p.id, 2);
    refuse = true;
    h.reconciler.calls.length = 0;
    assert.throws(() => h.service.makeCurrent(p.id, 1), code('CONFLICT'));
    const after = h.service.get(p.id);
    assert.deepEqual([after.revision, after.latestRevision], [2, 2], 'nothing moved, nothing was added');
    assert.deepEqual(h.reconciler.calls, []);
  } finally {
    h.done();
  }
});

test('roll back: a kind that wants a review holds the roll back instead of delivering it unreviewed', async () => {
  const h = await setup({ rollback: (target) => ({ ...target, review: true }) });
  try {
    const p = h.service.create('secrets', { name: 'Set', content: { files: { a: '1' } } });
    h.service.update(p.id, { content: { files: { a: '2' } } });
    assert.throws(() => h.service.makeCurrent(p.id, 1), (e) => code('CONFLICT')(e) && /needs a review/.test((e as Error).message));
    const after = h.service.get(p.id);
    assert.deepEqual([after.revision, after.latestRevision], [2, 2], 'the held roll back was rolled back with its transaction');
  } finally {
    h.done();
  }
});

test('pins: a kind can refuse a revision that holds something revoked', async () => {
  const h = await setup({ unusable: (c) => (c.files.revoked ? 'its token was revoked on 2026-10-01.' : null) });
  try {
    const p = h.service.create('secrets', { name: 'Set', content: { files: { revoked: 'x' } } });
    h.service.update(p.id, { content: { files: { a: '1' } } });
    assert.throws(() => h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: p.id, pinnedRevision: 1 }]), (e) => code('VALIDATION_FAILED')(e) && /can’t be pinned: its token was revoked on 2026-10-01/.test((e as Error).message));
    assert.equal(h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: p.id, pinnedRevision: 2 }]).assignments[0]!.pinnedRevision, 2);
  } finally {
    h.done();
  }
});

test('a one-per-workspace type (personas): setting two is refused, setting one swaps, and bulk assignment replaces with a removal record', async () => {
  const h = await setup({ single: true });
  try {
    const a = h.service.create('secrets', { name: 'A', content: {} });
    const b = h.service.create('secrets', { name: 'B', content: {} });
    assert.throws(() => h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: a.id }, { poolId: b.id }]), (e) => code('VALIDATION_FAILED')(e) && /one secrets pool/.test((e as Error).message));
    assert.throws(() => h.service.checkAddOns({ secrets: [a.id, b.id] }), code('VALIDATION_FAILED'));
    assert.deepEqual(h.service.checkAddOns({ secrets: [a.id] }), { secrets: [a.id] });

    h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: a.id }]);
    const swapped = h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: b.id }]);
    assert.deepEqual(swapped.assignments.map((x) => [x.poolName, x.state]), [['B', 'assigned'], ['A', 'removing']]);

    // Bulk: ws1 has B, ws2 has nothing, ws3 has A. Assigning A replaces B on ws1, fills ws2, leaves ws3 alone.
    h.service.setAssignments('docker/ws3', 'secrets', [{ poolId: a.id }]);
    h.reconciler.calls.length = 0;
    const r = h.service.assignToMany(a.id, ['docker/ws1', 'docker/ws2', 'docker/ws3']);
    assert.deepEqual([r.assigned, r.already, r.replaced], [['docker/ws1', 'docker/ws2'], ['docker/ws3'], ['docker/ws1']]);
    assert.deepEqual(h.service.assignedPools('docker/ws1', 'secrets').map((x) => x.pool.name), ['A']);
    assert.ok(removals(h.store, 'docker/ws1').some((x) => x.pool_id === b.id), 'the pool it replaced leaves with a removal record');
    assert.ok(!removals(h.store, 'docker/ws1').some((x) => x.pool_id === a.id), 'and the pool it got isn’t on its way out');
    assert.deepEqual(h.reconciler.calls.map((c) => c.id).sort(), ['docker/ws1', 'docker/ws2']);
    assert.equal(h.service.assignToMany(a.id, ['docker/ws1']).replaced, undefined);
  } finally {
    h.done();
  }
});

test('assignments: replace semantics, removal records, superseded removals, pins and options', async () => {
  const h = await setup();
  try {
    const a = h.service.create('secrets', { name: 'A', content: { files: { x: '1', y: '2' } } });
    const b = h.service.create('secrets', { name: 'B', content: {} });
    const first = h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: a.id, options: { skip: ['y'] } }, { poolId: b.id }]);
    assert.deepEqual(first.assignments.map((x) => [x.poolName, x.revision, x.state, x.options]), [
      ['A', 1, 'assigned', { skip: ['y'] }],
      ['B', 1, 'assigned', {}],
    ]);
    assert.deepEqual(h.reconciler.calls.at(-1), { id: 'docker/ws1', why: 'pools changed', changed: true });

    // Dropping B records its removal; A keeps its options although the request leaves them out.
    const second = h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: a.id }]);
    assert.deepEqual(second.assignments.map((x) => [x.poolName, x.state]), [
      ['A', 'assigned'],
      ['B', 'removing'],
    ]);
    assert.deepEqual(second.assignments[0]!.options, { skip: ['y'] });
    assert.deepEqual(removals(h.store), [{ pool_type: 'secrets', pool_id: b.id }]);
    // Adding B back supersedes the removal.
    h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: a.id }, { poolId: b.id }]);
    assert.deepEqual(removals(h.store), []);

    const before = h.reconciler.calls.length;
    h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: a.id }, { poolId: b.id }]);
    assert.equal(h.reconciler.calls.length, before, 'no change, no reconcile');

    assert.throws(() => h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: a.id }, { poolId: a.id }]), /twice/);
    assert.throws(() => h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: 'nope' }]), code('VALIDATION_FAILED'));
    assert.throws(() => h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: a.id, pinnedRevision: 7 }]), /no revision 7/);
    assert.throws(() => h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: a.id, options: { skip: 'y' } }]), /skip must be a list/);
    assert.throws(() => h.service.setAssignments('nope', 'secrets', []), code('VALIDATION_FAILED'));
    assert.throws(() => h.service.setAssignments('docker/ws1', 'mcpset', []), code('NOT_FOUND'));

    // Pin, then follow the current revision again.
    h.service.update(a.id, { content: { files: { x: '9' } } });
    assert.equal(h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: a.id, pinnedRevision: 1 }, { poolId: b.id }]).assignments[0]!.revision, 1);
    assert.equal(h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: a.id, pinnedRevision: null }, { poolId: b.id }]).assignments[0]!.revision, 2);
    assert.equal(h.service.list('secrets').find((p) => p.id === a.id)!.workspaces, 1);
  } finally {
    h.done();
  }
});

test('assignments: a kind can warn about or refuse a removal', async () => {
  let refuse = false;
  const h = await setup({
    beforeUnassign: (ws, poolId) => {
      if (refuse) throw new AppError('CONFLICT', `An MCP set in ${ws} needs ${poolId}.`);
      return ['context7 will lose CONTEXT7_API_KEY.'];
    },
  });
  try {
    const a = h.service.create('secrets', { name: 'A', content: {} });
    h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: a.id }]);
    refuse = true;
    assert.throws(() => h.service.setAssignments('docker/ws1', 'secrets', []), /needs/);
    assert.equal(h.service.assignmentsFor('docker/ws1').length, 1, 'refused: nothing changed');
    refuse = false;
    const r: SetWorkspacePoolsResult = h.service.setAssignments('docker/ws1', 'secrets', []);
    assert.deepEqual(r.warnings, ['context7 will lose CONTEXT7_API_KEY.']);
  } finally {
    h.done();
  }
});

test('bulk assignment adds the pool where it is missing', async () => {
  const h = await setup();
  try {
    const p = h.service.create('secrets', { name: 'A', content: {} });
    h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: p.id }]);
    h.reconciler.calls.length = 0;
    const r = h.service.assignToMany(p.id, ['docker/ws1', 'docker/ws2', 'k8s/ws3', 'docker/ws2']);
    assert.deepEqual(r, { assigned: ['docker/ws2', 'k8s/ws3'], already: ['docker/ws1'] });
    assert.deepEqual(h.reconciler.calls.map((c) => c.id), ['docker/ws2', 'k8s/ws3']);
    assert.throws(() => h.service.assignToMany(p.id, []), code('VALIDATION_FAILED'));
    assert.throws(() => h.service.assignToMany(p.id, ['bad id']), code('VALIDATION_FAILED'));
    // QA-032: an id that could end up in a Docker URL or a selector is not a workspace, whatever calls the service.
    for (const bad of ['docker/x%2f..%2f..%2fcontainers', '../x', 'docker/x?force=true', 'docker/a%00b', `docker/${'x'.repeat(64)}`, 'docker//x']) assert.throws(() => h.service.assignToMany(p.id, [bad]), code('VALIDATION_FAILED'), bad);
  } finally {
    h.done();
  }
});

test('delete is refused while the pool is in use, and the kind may refuse it too', async () => {
  let refuse = true;
  const h = await setup({
    beforeUnassign: (ws) => {
      if (ws === '' && refuse) throw new AppError('CONFLICT', 'A persona lists this set.');
      return [];
    },
  });
  try {
    const p = h.service.create('secrets', { name: 'A', content: { token: 'secret-1' } });
    h.service.assignToMany(p.id, ['docker/ws1', 'docker/ws2']);
    assert.throws(() => h.service.delete(p.id), (e: AppError) => e.code === 'CONFLICT' && /In use by 2 workspaces/.test(e.message));
    h.service.setAssignments('docker/ws1', 'secrets', []);
    h.service.setAssignments('docker/ws2', 'secrets', []);
    assert.throws(() => h.service.delete(p.id), /persona/);
    refuse = false;
    h.service.delete(p.id);
    assert.equal(h.service.list('secrets').length, 0);
    assert.equal(removals(h.store).length, 1, 'removal records outlive the pool');
    assert.deepEqual(h.service.assignmentsFor('docker/ws1').map((a) => [a.poolName, a.state]), [['Removed pool', 'removing']]);
    assert.throws(() => h.service.get(p.id), code('NOT_FOUND'));
  } finally {
    h.done();
  }
});

test('a paused rollout holds back the workspaces it has not reached; pinned ones are unaffected; resume', async () => {
  const h = await setup();
  try {
    const p = h.service.create('secrets', { name: 'A', content: { files: { v: '1' } } });
    h.service.assignToMany(p.id, ['docker/reached', 'docker/behind']);
    h.service.setAssignments('docker/pinned', 'secrets', [{ poolId: p.id, pinnedRevision: 1 }]);
    h.service.update(p.id, { content: { files: { v: '2' } } });
    // r2 reached one workspace before the pause.
    h.store.db!.prepare("UPDATE assignments SET delivered_revision = 2 WHERE workspace_id = 'docker/reached'").run();
    h.store.db!.prepare("UPDATE assignments SET delivered_revision = 1 WHERE workspace_id = 'docker/behind'").run();
    h.reconciler.calls.length = 0;

    const paused = h.service.pauseRollout(p.id, 'Load error on 2 workspaces');
    assert.equal(paused.rolloutPaused?.reason, 'Load error on 2 workspaces');
    assert.deepEqual(h.reconciler.calls.map((c) => c.id).sort(), ['docker/behind', 'docker/reached'], 'pinned workspaces are not asked');
    const rev = (ws: string) => h.service.assignedPools('docker/' + ws, 'secrets')[0]?.pool.revision;
    assert.deepEqual([rev('reached'), rev('behind'), rev('pinned')], [2, 1, 1]);
    h.service.assignToMany(p.id, ['docker/new']);
    assert.equal(rev('new'), 1, 'a newly assigned workspace gets the revision before the paused one');
    assert.equal(h.service.get(p.id).revisions[0]!.rolloutPaused?.reason, 'Load error on 2 workspaces');

    h.service.resumeRollout(p.id);
    assert.deepEqual([rev('reached'), rev('behind'), rev('new'), rev('pinned')], [2, 2, 2, 1]);
    assert.equal(h.service.list('secrets')[0]!.rolloutPaused, null);

    // A pool whose only revision is paused has nothing to give a workspace it hasn't reached.
    const solo = h.service.create('secrets', { name: 'Solo', content: {} });
    h.service.pauseRollout(solo.id);
    h.service.assignToMany(solo.id, ['docker/x']);
    assert.deepEqual(h.service.assignedPools('docker/x', 'secrets'), []);
    assert.equal(h.service.assignmentsFor('docker/x')[0]!.revision, 0);
  } finally {
    h.done();
  }
});

test('duplicate copies the newest revision, write-only values included', async () => {
  const h = await setup();
  try {
    const p = h.service.create('secrets', { name: 'A', description: 'Desc', content: { files: { a: '1' }, token: 'tok-123' } });
    h.service.update(p.id, { content: { files: { a: '2' } } });
    const copy = h.service.duplicate(p.id, 'A copy');
    assert.deepEqual([copy.name, copy.description, copy.revision, copy.workspaces], ['A copy', 'Desc', 1, 0]);
    assert.deepEqual(copy.content, { files: { a: '2' }, env: {}, hasToken: true, review: false });
    assert.equal(h.service.get(copy.id).revisions[0]!.note, 'Copy of A r2');
    const owners = h.store.db!.prepare('SELECT pool_id FROM dummy_values ORDER BY id').all() as { pool_id: string }[];
    assert.deepEqual(owners.map((o) => o.pool_id), [p.id, copy.id], 'the copy owns its own value');
    assert.throws(() => h.service.duplicate(p.id, 'a'), code('CONFLICT'));
  } finally {
    h.done();
  }
});

test('forgetting a workspace drops its multi-type rows and nothing else', async () => {
  let forgotten = '';
  const h = await setup({ forgetWorkspace: (ws) => void (forgotten = ws) });
  try {
    const p = h.service.create('secrets', { name: 'A', content: {} });
    const q = h.service.create('secrets', { name: 'B', content: {} });
    h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: p.id }, { poolId: q.id }]);
    h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: p.id }]);
    h.store.db!.exec(`INSERT INTO pools (id, type, name, current_revision, created_at, updated_at) VALUES ('acc', 'account', 'main', 1, 'x', 'x');
      INSERT INTO assignments (workspace_id, pool_id, pool_type, assigned_at) VALUES ('docker/ws1', 'acc', 'account', 'x');`);
    h.service.forgetWorkspace('docker/ws1');
    assert.deepEqual(h.service.assignmentsFor('docker/ws1'), []);
    assert.deepEqual(removals(h.store), []);
    assert.equal((h.store.db!.prepare("SELECT count(*) AS n FROM assignments WHERE pool_type = 'account'").get() as { n: number }).n, 1, 'account pools forget their own');
    assert.equal(forgotten, 'docker/ws1');
  } finally {
    h.done();
  }
});

test('preview: one pool compiled, secret files redacted, placeholders in settings, and nothing parse stored is kept', async () => {
  const h = await setup();
  try {
    const p = h.service.create('secrets', { name: 'A', content: { files: { a: 'plain' }, env: { API_URL: 'https://x' }, token: 'super-secret' } });
    assert.equal(values(h.store), 1);
    const stored = h.service.preview('secrets', p.id, {});
    assert.equal(stored.revision, 1);
    const byPath = new Map(stored.files.map((f) => [f.path, f]));
    assert.deepEqual(byPath.get(`/etc/claudepilot/secrets/${p.id}/token`), { path: `/etc/claudepilot/secrets/${p.id}/token`, mode: 0o440, uid: ROOT, gid: NODE, content: '‹redacted›', redacted: true });
    assert.equal(byPath.get(`/etc/claudepilot/secrets/${p.id}/a`)!.content, 'plain');
    const dropIn = byPath.get('/etc/claude-code/managed-settings.d/20-claudepilot-env.json')!;
    assert.deepEqual(JSON.parse(dropIn.content), { env: { API_URL: '«value»' } });
    assert.ok(!JSON.stringify(stored).includes('super-secret'));

    // Unsaved content: parse stores a new value inside the preview, and it's rolled back.
    const unsaved = h.service.preview('secrets', p.id, { content: { files: { b: 'new' }, token: 'other-secret' } });
    assert.equal(unsaved.revision, 2);
    assert.deepEqual(unsaved.files.map((f) => f.path.split('/').pop()), ['b', 'token']);
    assert.equal(values(h.store), 1, 'rolled back');
    assert.equal(h.service.get(p.id).latestRevision, 1);

    // A pool not saved yet.
    const fresh = h.service.preview('secrets', null, { content: { files: { c: 'x' } } });
    assert.equal(fresh.revision, 1);
    assert.equal(h.service.list('secrets').length, 1, 'the preview row is gone');
    assert.throws(() => h.service.preview('secrets', null, {}), code('VALIDATION_FAILED'));

    // As a workspace gets it: its options apply.
    h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: p.id, options: { skip: ['a'] } }]);
    const forWs = h.service.preview('secrets', p.id, { workspaceId: 'docker/ws1' });
    assert.ok(!forWs.files.some((f) => f.path.endsWith('/a')));
    assert.equal(forWs.workspaceId, 'docker/ws1');
  } finally {
    h.done();
  }
});

test('preview turns an ownership violation into a readable error', async () => {
  const h = await setup({ fragments: () => [{ owner: 'secrets', files: [{ path: '/etc/claudepilot/account/x.key', content: 'k', mode: 0o440, uid: ROOT, gid: ROOT }] }] });
  try {
    const p = h.service.create('secrets', { name: 'A', content: {} });
    assert.throws(() => h.service.preview('secrets', p.id, {}), (e: AppError) => e.code === 'VALIDATION_FAILED' && /Configuration error: secrets: may not write/.test(e.message));
  } finally {
    h.done();
  }
});

/* ---------- Provider, through the real reconciler ---------- */

/** A stopped Docker workspace whose files live in a map: what the archive API would write and read. */
function stoppedWorkspace() {
  const files = new Map<string, string>();
  const access: DeliveryAccess = {
    state: async () => ({ exists: true, running: false }),
    run: async () => {
      throw new Error('not running');
    },
    put: async (_name, entries) => {
      for (const e of entries) if (e.type === 'file') files.set(e.path, e.content ?? '');
    },
    read: async (_name, path) => files.get(path) ?? null,
    watchStarts: () => () => {},
  };
  const runtime = { delivery: access, target: { id: 'docker', label: 'Docker', kind: 'docker', where: '' } } as unknown as Runtime;
  const manifest = () => JSON.parse(files.get(MANIFEST_PATH) ?? 'null') as Manifest | null;
  return { files, runtime, manifest };
}

async function withReconciler(hooks: Partial<PoolKind<Dummy>> = {}) {
  const h = await setup(hooks);
  const ws = stoppedWorkspace();
  const reconciler = new Reconciler(h.store, () => ws.runtime, () => [ws.runtime], h.providers);
  h.service.reconciler = reconciler;
  // request() hands back the run in flight; a change made during it is delivered by the queued run
  // after it. The fake workspace answers at once, so a short wait covers that one too.
  const run = async () => {
    await reconciler.request('docker/ws1', 'test');
    await new Promise((r) => setTimeout(r, 20));
  };
  return { ...h, ws, reconciler, run };
}

test('provider: delivers each pool at its effective revision, records what arrived, and clears removals once the manifest drops them', async () => {
  const h = await withReconciler();
  try {
    const a = h.service.create('secrets', { name: 'A', content: { files: { x: 'one' }, env: { A_URL: 'u' }, token: 't1' } });
    const b = h.service.create('secrets', { name: 'B', content: { files: { y: 'two' } } });
    h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: a.id }, { poolId: b.id }]);
    await h.run();
    assert.equal(h.reconciler.row('docker/ws1')?.status, 'synced');
    assert.equal(h.ws.files.get(`/etc/claudepilot/secrets/${a.id}/x`), 'one');
    assert.equal(h.ws.files.get(`/etc/claudepilot/secrets/${a.id}/token`), 't1');
    assert.deepEqual(JSON.parse(h.ws.files.get('/etc/claude-code/managed-settings.d/20-claudepilot-env.json')!), { env: { A_URL: 'u' } });
    assert.deepEqual(h.ws.manifest()!.pools.map((p) => [p.id, p.revision]).sort(), [[a.id, 1], [b.id, 1]].sort());
    const delivered = () => h.store.db!.prepare('SELECT pool_id, delivered_revision FROM assignments ORDER BY pool_id').all() as { pool_id: string; delivered_revision: number }[];
    assert.ok(delivered().every((d) => d.delivered_revision === 1));
    assert.ok((h.store.db!.prepare("SELECT count(*) AS n FROM exposures WHERE secret_ref LIKE 'dummy:%'").get() as { n: number }).n === 1, 'secret files are exposures');

    // A new revision reaches it and is recorded as delivered.
    h.service.update(a.id, { content: { files: { x: 'uno' }, env: { A_URL: 'u' } } });
    await h.run();
    assert.equal(h.ws.files.get(`/etc/claudepilot/secrets/${a.id}/x`), 'uno');
    assert.equal(delivered().find((d) => d.pool_id === a.id)!.delivered_revision, 2);

    // Unassign B: its record stays until a write leaves it out of the manifest, then goes.
    h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: a.id }]);
    assert.equal(removals(h.store).length, 1);
    await h.run();
    assert.deepEqual(h.ws.manifest()!.pools.map((p) => p.id), [a.id]);
    assert.equal(h.ws.files.get(`/etc/claudepilot/secrets/${b.id}/y`), '', 'a stopped workspace gets the file blanked, removed at its next start');
    assert.deepEqual(removals(h.store), []);
    await h.run();
    assert.equal(h.reconciler.row('docker/ws1')?.status, 'synced', 'no freeze afterwards');
  } finally {
    h.done();
  }
});

test('provider: a removal that changes no file keeps its record until the manifest no longer names the pool', async () => {
  // Pools that only add to one shared file, named in contentless fragments: dropping one of two with
  // the same content changes nothing on disk.
  const h = await withReconciler({
    fragments: (assigned) => {
      if (!assigned.length) return [];
      const content = assigned[0]!.content.files.shared ?? 'same';
      return [
        { owner: 'secrets', files: [{ path: '/etc/claudepilot/secrets/shared', content, mode: 0o440, uid: ROOT, gid: NODE }] },
        ...assigned.map((a): Fragment => ({ owner: 'secrets', pool: { id: a.pool.id, revision: a.pool.revision } })),
      ];
    },
  });
  try {
    const a = h.service.create('secrets', { name: 'A', content: {} });
    const b = h.service.create('secrets', { name: 'B', content: {} });
    h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: a.id }, { poolId: b.id }]);
    await h.run();
    assert.equal(h.ws.manifest()!.pools.length, 2);

    h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: a.id }]);
    await h.run();
    assert.equal(h.ws.manifest()!.pools.length, 2, 'same hash: the old manifest stays');
    assert.equal(removals(h.store).length, 1, 'so the record stays');
    await h.run();
    assert.equal(h.reconciler.row('docker/ws1')?.status, 'synced', 'and the workspace isn’t frozen');

    // The next write drops B from the manifest, and then its record.
    h.service.update(a.id, { content: { files: { shared: 'new' } } });
    await h.run();
    assert.deepEqual(h.ws.manifest()!.pools.map((p) => p.id), [a.id]);
    assert.deepEqual(removals(h.store), []);
  } finally {
    h.done();
  }
});

test('provider: knows its own pools only, and refuses fragments under another owner', async () => {
  const h = await setup({ fragments: (assigned) => (assigned.length ? [{ owner: 'account', settings: { apiKeyHelper: 'x' } }] : []) });
  try {
    const p = h.service.create('secrets', { name: 'A', content: {} });
    h.service.setAssignments('docker/ws1', 'secrets', [{ poolId: p.id }]);
    h.store.db!.exec("INSERT INTO removals (workspace_id, pool_type, pool_id, requested_at) VALUES ('docker/ws1', 'secrets', 'gone', 'x'), ('docker/ws1', 'account', 'acc', 'x')");
    const provider = h.providers[0]!;
    assert.equal(provider.type, 'secrets');
    assert.deepEqual(provider.knownPools('docker/ws1').sort(), ['gone', p.id].sort());
    assert.throws(() => provider.fragments('docker/ws1', { running: false, now: new Date() }), /owned by account/);
  } finally {
    h.done();
  }
});

/* ---------- Routes ---------- */

async function routes() {
  const h = await withReconciler();
  const app = new Hono();
  // Like app.ts: AppErrors keep their status, message and details.
  app.onError((e, c) => {
    const err = isAppError(e) ? e : new AppError('INTERNAL_ERROR', undefined, { cause: e });
    return c.json(err.toJSON(), err.status as ContentfulStatusCode);
  });
  // Like app.ts's session guard: the caller is the signed-in owner (the workspace routes ask the seam, T-531).
  app.use('*', async (c, next) => {
    (c as unknown as { set(k: string, v: unknown): void }).set('token', 'signed-in');
    await next();
  });
  app.route('/api/pools', createPoolRoutes({ service: h.service }));
  app.route('/api/workspaces', createWorkspacePoolRoutes({ service: h.service, reconciler: h.reconciler }));
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = (await res.json()) as { data: T; error?: { code: string; message: string } };
    return { status: res.status, data: json.data, error: json.error };
  };
  return { ...h, call };
}

test('routes: pools of a registered type; anything else is a 404', async () => {
  const h = await routes();
  try {
    assert.deepEqual((await h.call<{ types: string[] }>('GET', '/api/pools')).data, { types: ['secrets'] });
    assert.equal((await h.call('GET', '/api/pools/skillset')).status, 404);
    assert.equal((await h.call('GET', '/api/pools/account')).status, 404);
    // Personas and browser & desktop are in the union, but a portal with no kind for them doesn't serve them:
    // a clear 404 on every route, never a crash, and they're left out of the listing above.
    for (const type of ['persona', 'browser']) {
      for (const [method, path] of [['GET', `/api/pools/${type}`], ['POST', `/api/pools/${type}`], ['POST', `/api/pools/${type}/preview`], ['GET', `/api/pools/${type}/x`], ['PUT', `/api/pools/${type}/x`], ['POST', `/api/pools/${type}/x/assign`]] as const)
        assert.equal((await h.call(method, path, method === 'GET' ? undefined : { name: 'x', content: {}, workspaceIds: ['docker/a'] })).status, 404, `${method} ${path}`);
    }

    const created = await h.call<PoolSummary>('POST', '/api/pools/secrets', { name: 'Team', content: { files: { a: '1' }, token: 'route-secret' }, note: 'first' });
    assert.equal(created.status, 201);
    const id = created.data.id;
    assert.ok(!JSON.stringify(created.data).includes('route-secret'), 'write-only values never come back');
    assert.equal((await h.call<PoolSummary[]>('GET', '/api/pools/secrets')).data.length, 1);
    assert.equal((await h.call('GET', `/api/pools/mcpset/${id}`)).status, 404, 'the URL’s type must match');
    assert.equal((await h.call('GET', '/api/pools/secrets/nope')).status, 404);

    const updated = await h.call<PoolSummary>('PUT', `/api/pools/secrets/${id}`, { content: { files: { a: '2' }, review: true }, note: 'needs a look' });
    assert.deepEqual([updated.data.revision, updated.data.latestRevision, updated.data.status], [1, 2, 'waiting_review']);
    assert.equal((await h.call<PoolSummary>('POST', `/api/pools/secrets/${id}/revisions/2/approve`)).data.revision, 2);
    assert.equal((await h.call<PoolSummary>('POST', `/api/pools/secrets/${id}/revisions/1/current`)).data.revision, 1);
    assert.equal((await h.call('POST', `/api/pools/secrets/${id}/revisions/zero/current`)).status, 400);
    const detail = await h.call<PoolDetail>('GET', `/api/pools/secrets/${id}`);
    assert.deepEqual(detail.data.revisions.map((r) => r.revision), [2, 1]);

    assert.equal((await h.call<PoolSummary>('POST', `/api/pools/secrets/${id}/rollout`, { paused: true, reason: 'Load error' })).data.rolloutPaused?.reason, 'Load error');
    assert.equal((await h.call<PoolSummary>('POST', `/api/pools/secrets/${id}/rollout`, { paused: false })).data.rolloutPaused, null);
    assert.equal((await h.call('POST', `/api/pools/secrets/${id}/rollout`, {})).status, 422);

    const copy = await h.call<PoolSummary>('POST', `/api/pools/secrets/${id}/duplicate`, { name: 'Team copy' });
    assert.equal(copy.status, 201);

    const assigned = await h.call('POST', `/api/pools/secrets/${id}/assign`, { workspaceIds: ['docker/ws1', 'docker/ws2'] });
    assert.deepEqual(assigned.data, { assigned: ['docker/ws1', 'docker/ws2'], already: [] });
    const refused = await h.call('DELETE', `/api/pools/secrets/${id}`);
    assert.deepEqual([refused.status, refused.error?.message], [409, 'In use by 2 workspaces. Remove it from them first.']);
    assert.equal((await h.call('DELETE', `/api/pools/secrets/${copy.data.id}`)).status, 200);
  } finally {
    h.done();
  }
});

test('routes: a workspace’s pools, with its delivery status, and changing one type’s list', async () => {
  const h = await routes();
  try {
    const a = (await h.call<PoolSummary>('POST', '/api/pools/secrets', { name: 'A', content: { token: 'tok' } })).data;
    const put = await h.call<SetWorkspacePoolsResult>('PUT', '/api/workspaces/docker/ws1/pools/secrets', { items: [{ poolId: a.id }] });
    assert.deepEqual(put.data.assignments.map((x) => [x.poolName, x.revision]), [['A', 1]]);
    assert.equal((await h.call('PUT', '/api/workspaces/docker/ws1/pools/skillset', { items: [] })).status, 404);
    assert.equal((await h.call('PUT', '/api/workspaces/docker/ws1/pools/secrets', { items: 'x' })).status, 422);

    await h.run();
    const view = await h.call<WorkspacePools>('GET', '/api/workspaces/docker/ws1/pools');
    assert.equal(view.data.workspaceId, 'docker/ws1');
    assert.deepEqual(view.data.types.map((t) => [t.type, t.assignments.length]), [['secrets', 1]]);
    assert.equal(view.data.delivery?.status, 'synced');
    assert.ok(view.data.delivery?.checkedAt);

    const preview = await h.call<PoolPreview>('POST', `/api/pools/secrets/${a.id}/preview`, { workspaceId: 'docker/ws1' });
    assert.equal(preview.data.files.find((f) => f.path.endsWith('/token'))?.content, '‹redacted›');
    const unsaved = await h.call<PoolPreview>('POST', '/api/pools/secrets/preview', { content: { files: { n: 'x' } } });
    assert.deepEqual(unsaved.data.files.map((f) => f.path.split('/').pop()), ['n']);
    assert.equal((await h.call('POST', '/api/pools/secrets/preview')).status, 422, 'nothing to preview');
  } finally {
    h.done();
  }
});
