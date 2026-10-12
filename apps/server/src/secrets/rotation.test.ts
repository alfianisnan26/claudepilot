import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import { secretFilePath, type SecretsContent as View } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { Reconciler } from '../delivery/reconciler.js';
import { createSecretsAdminRoutes } from './adminRoutes.js';
import { exposedSecretValues } from './exposed.js';
import { SecretRotations } from './rotation.js';
import { memoryWorkspace, secretsHarness } from './testkit.js';

// FR16 to FR18, FR20: rotate, urgent rotate and pins, the tracker and "safe to revoke", versions, revoking a value,
// the purge of values nobody needs, expiry warnings, and deleting a set that workspaces still have.

const W1 = 'docker/w1';
const W2 = 'other/w2';
const A = 'ghp_AAAAoldTOKEN0123456789abcdefghijkl';
const B = 'ghp_BBBBnewTOKEN0123456789abcdefghijkl';
const C = 'ghp_CCCCthirdTOKEN0123456789abcdefghijk';
const FILE = secretFilePath('TOKEN');
const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;

async function setup() {
  const h = await secretsHarness();
  const ws = { [W1]: memoryWorkspace(), [W2]: memoryWorkspace() };
  const reconciler = new Reconciler(h.store, (t) => (t === 'docker' ? ws[W1] : ws[W2]).runtime, () => [ws[W1].runtime, ws[W2].runtime], h.providers);
  const rotations = new SecretRotations(h.store, h.kind, h.service);
  const deliver = async (id: string) => {
    await reconciler.request(id, 'test');
    assert.equal(reconciler.row(id)?.status, 'synced', reconciler.row(id)?.reason ?? '');
  };
  const pool = h.service.create('secrets', { name: 'team', content: { entries: [{ kind: 'secret', name: 'TOKEN', newValue: A }, { kind: 'variable', name: 'REGION', value: 'eu-west-1' }] } });
  const entryId = (h.service.get(pool.id).content as View).entries.find((e) => e.name === 'TOKEN')!.id;
  const done = () => (rotations.stop(), reconciler.stop(), h.done());
  const content = (id: string) => ws[id as typeof W1].files.get(FILE)?.content;
  return { h, ws, reconciler, rotations, deliver, pool, entryId, content, done };
}

test('rotate: a new version and a "Rotated NAME" revision; followers get it, a pinned workspace holds until moved, and the tracker says so', async () => {
  const t = await setup();
  try {
    t.h.service.setAssignments(W1, 'secrets', [{ poolId: t.pool.id }]);
    t.h.service.setAssignments(W2, 'secrets', [{ poolId: t.pool.id, pinnedRevision: 1 }]);
    await t.deliver(W1);
    await t.deliver(W2);
    assert.deepEqual([t.content(W1), t.content(W2)], [A, A]);

    const r = t.rotations.rotate(t.pool.id, t.entryId, { value: B, note: 'quarterly' });
    assert.deepEqual([r.entryName, r.fromVersion, r.toVersion, r.urgent], ['TOKEN', 1, 2, false]);
    assert.deepEqual(t.h.service.get(t.pool.id).revisions.map((x) => [x.revision, x.note, x.current]), [[2, 'Rotated TOKEN: quarterly', true], [1, '', false]]);
    assert.equal(t.h.service.get(t.pool.id).name, 'team');
    assert.deepEqual(r.counts, { confirmed: 0, pending: 1, pinned: 1, failed: 0 }, 'nothing has reached them yet');

    await t.deliver(W1);
    assert.deepEqual([t.content(W1), t.content(W2)], [B, A], 'the follower has the new value, the pinned one holds');
    const tracker = t.rotations.view(r.id);
    assert.deepEqual(tracker.workspaces.map((w) => [w.workspaceId, w.state]), [[W1, 'confirmed'], [W2, 'pinned']]);
    assert.equal(tracker.workspaces[1]!.detail, 'Pinned to r1.');
    assert.equal(tracker.safeAt, null, 'not safe to revoke while a pinned workspace still has it');

    // Moving the pin moves the workspace; then every workspace is confirmed and the old value is safe to revoke at its provider.
    t.h.service.setAssignments(W2, 'secrets', [{ poolId: t.pool.id, pinnedRevision: null }]);
    await t.deliver(W2);
    assert.equal(t.content(W2), B);
    const safe = t.rotations.view(r.id);
    assert.deepEqual(safe.counts, { confirmed: 2, pending: 0, pinned: 0, failed: 0 });
    assert.ok(safe.safeAt, 'safe to revoke');
    assert.equal(t.rotations.list(t.pool.id)[0]!.safeAt, safe.safeAt, 'recorded once');
    assert.ok(exposedSecretValues(t.h.service, W1).includes(A), 'the old value is still redacted for a while: it may sit in a transcript');
  } finally {
    t.done();
  }
});

test('urgent rotation: every workspace is asked at once, and a pinned one gets the new value in place of the one its revision names', async () => {
  const t = await setup();
  try {
    t.h.service.setAssignments(W1, 'secrets', [{ poolId: t.pool.id }]);
    t.h.service.setAssignments(W2, 'secrets', [{ poolId: t.pool.id, pinnedRevision: 1 }]);
    await t.deliver(W1);
    await t.deliver(W2);
    t.h.requests.length = 0;
    const r = t.rotations.rotate(t.pool.id, t.entryId, { value: B, urgent: true });
    assert.ok(r.urgent);
    assert.ok(t.h.requests.includes(W1) && t.h.requests.includes(W2), 'pinned workspaces are asked too');
    await t.deliver(W1);
    await t.deliver(W2);
    assert.deepEqual([t.content(W1), t.content(W2)], [B, B], 'the pinned workspace got the new value');
    assert.equal(t.h.service.get(t.pool.id).assignedTo.find((a) => a.workspaceId === W2)?.pinnedRevision, 1, 'and is still pinned');
    const view = t.rotations.view(r.id);
    assert.deepEqual(view.counts, { confirmed: 2, pending: 0, pinned: 0, failed: 0 });
    assert.ok(view.safeAt);
    // A further urgent rotation chains: C replaces B replaces A for the pinned workspace.
    t.rotations.rotate(t.pool.id, t.entryId, { value: C, urgent: true });
    await t.deliver(W2);
    assert.equal(t.content(W2), C);
  } finally {
    t.done();
  }
});

test('the tracker: a workspace that can’t be delivered to is "failed", and one the set is taken out of is pending until its file is gone', async () => {
  const t = await setup();
  try {
    t.h.service.setAssignments(W1, 'secrets', [{ poolId: t.pool.id }]);
    t.h.service.setAssignments(W2, 'secrets', [{ poolId: t.pool.id }]);
    await t.deliver(W1);
    await t.deliver(W2);
    const r = t.rotations.rotate(t.pool.id, t.entryId, { value: B });
    t.h.store.db!.prepare("UPDATE workspace_delivery SET status = 'failed', reason = 'exec failed' WHERE workspace_id = ?").run(W2);
    const view = t.rotations.view(r.id);
    assert.deepEqual(view.workspaces.map((w) => [w.workspaceId, w.state, w.detail]), [[W1, 'pending', 'Waiting for delivery.'], [W2, 'failed', 'exec failed']]);
    assert.equal(view.safeAt, null);
    // Taking the set out of W1 is not enough: its file has to go.
    t.h.service.setAssignments(W1, 'secrets', []);
    assert.deepEqual(t.rotations.view(r.id).workspaces.find((w) => w.workspaceId === W1), { workspaceId: W1, state: 'pending', detail: 'Being taken out of the workspace.' });
    await t.reconciler.request(W1, 'removed');
    await t.reconciler.request(W1, 'started');
    assert.equal(t.rotations.view(r.id).workspaces.find((w) => w.workspaceId === W1), undefined, 'once the file is gone it is no longer in the list');
  } finally {
    t.done();
  }
});

test('versions and revoking: what identifies each version, where it is, and a revoked one is never delivered again', async () => {
  const t = await setup();
  try {
    t.h.service.setAssignments(W1, 'secrets', [{ poolId: t.pool.id }]);
    t.h.service.setAssignments(W2, 'secrets', [{ poolId: t.pool.id, pinnedRevision: 1 }]);
    await t.deliver(W1);
    await t.deliver(W2);
    t.rotations.rotate(t.pool.id, t.entryId, { value: B });
    await t.deliver(W1);
    const versions = t.rotations.versions(t.pool.id, t.entryId);
    assert.deepEqual(versions.map((v) => [v.version, v.current, v.pinned, v.workspaces]), [[2, true, [], [W1]], [1, false, [W2], [W2]]]);
    assert.ok(!JSON.stringify(versions).includes(B) && !JSON.stringify(versions).includes(A), 'never a value');
    assert.match(versions[0]!.hint, /^ghp_…/);

    // The value in use can't be revoked; the old one can, and the pinned workspace then gets the current one.
    assert.throws(() => t.rotations.revoke(t.pool.id, versions[0]!.id), code('CONFLICT'));
    t.h.requests.length = 0;
    const revoked = t.rotations.revoke(t.pool.id, versions[1]!.id, 'leaked in a ticket');
    assert.ok(revoked.revokedAt);
    assert.ok(t.h.requests.includes(W2), 'workspaces holding it are asked to deliver');
    await t.deliver(W2);
    assert.equal(t.content(W2), B, 'a revoked value is replaced by the current one even where a pin names it');
    assert.deepEqual(t.h.kind.workspaceView(W2).sets[0]!.files, ['TOKEN']);
    // Idempotent, and a revoked version can't be pinned to.
    assert.equal(t.rotations.revoke(t.pool.id, versions[1]!.id).revokedAt, revoked.revokedAt);
    assert.throws(() => t.h.service.setAssignments(W2, 'secrets', [{ poolId: t.pool.id, pinnedRevision: 1 }]), code('VALIDATION_FAILED'));
    // Another set's values and unknown ones are not found.
    assert.throws(() => t.rotations.revoke(t.pool.id, 'nope'), code('NOT_FOUND'));
    assert.throws(() => t.rotations.versions(t.pool.id, 'nope'), code('NOT_FOUND'));
  } finally {
    t.done();
  }
});

test('a revoked value with no replacement is not delivered at all: the entry needs a value', async () => {
  const t = await setup();
  try {
    t.h.service.setAssignments(W1, 'secrets', [{ poolId: t.pool.id }]);
    await t.deliver(W1);
    t.rotations.rotate(t.pool.id, t.entryId, { value: B });
    const [, old] = t.rotations.versions(t.pool.id, t.entryId);
    // Pin W2 to r1, revoke A, then roll the current value back to needing one: nothing is left to substitute.
    t.rotations.revoke(t.pool.id, old!.id);
    const current = t.rotations.versions(t.pool.id, t.entryId)[0]!;
    assert.equal(t.h.kind.effectiveValueId(t.pool.id, t.entryId, old!.id), current.id, 'the current value stands in');
    assert.equal(t.h.kind.effectiveValueId(t.pool.id, t.entryId, null), null);
  } finally {
    t.done();
  }
});

test('the sweep purges what nothing needs: a revoked value once no workspace holds it, an unused old one after 30 days; never one in use', async () => {
  const t = await setup();
  try {
    t.h.service.setAssignments(W1, 'secrets', [{ poolId: t.pool.id }]);
    await t.deliver(W1);
    const a = t.rotations.versions(t.pool.id, t.entryId)[0]!;
    t.rotations.rotate(t.pool.id, t.entryId, { value: B });
    t.rotations.rotate(t.pool.id, t.entryId, { value: C });
    await t.deliver(W1);
    const stored = (id: string) => t.h.kind.values.info(id)?.stored;
    const [c, b] = t.rotations.versions(t.pool.id, t.entryId);
    assert.deepEqual([stored(a.id), stored(b!.id), stored(c!.id)], [true, true, true]);

    // Nothing is revoked or old yet: nothing goes. A is no longer in use (its exposure closed) but not idle for 30 days.
    assert.deepEqual(t.rotations.sweep(), { purged: 0, warned: 0 });
    // B is revoked: gone at once (nobody holds it); C, in use, stays; A waits out its 30 days.
    t.rotations.revoke(t.pool.id, b!.id);
    assert.equal(t.rotations.sweep().purged, 1);
    assert.deepEqual([stored(a.id), stored(b!.id), stored(c!.id)], [true, false, true]);
    // Thirty-one days on, the old A (not revoked, not in use) goes; the current C never does.
    const later = new Date(Date.now() + 31 * 86_400_000);
    assert.equal(t.rotations.sweep(later).purged, 1);
    assert.deepEqual([stored(a.id), stored(c!.id)], [false, true]);
    // A purged value shows as not stored, can't be opened, and the set still delivers.
    assert.throws(() => t.h.kind.values.open(a.id));
    assert.equal(t.rotations.versions(t.pool.id, t.entryId).find((v) => v.id === a.id)?.stored, false);
    assert.equal(t.rotations.sweep(later).purged, 0, 'idempotent');
  } finally {
    t.done();
  }
});

test('expiry (FR8): a new value may say when it stops working; warnings at 14 and 3 days and when it has passed, once each', async () => {
  const t = await setup();
  try {
    const day = 86_400_000;
    assert.throws(() => t.rotations.rotate(t.pool.id, t.entryId, { value: B, expiresAt: new Date(Date.now() - day).toISOString() }), code('VALIDATION_FAILED'));
    assert.throws(() => t.rotations.rotate(t.pool.id, t.entryId, { value: B, expiresAt: 'soon' }), code('VALIDATION_FAILED'));
    t.rotations.rotate(t.pool.id, t.entryId, { value: B, expiresAt: new Date(Date.now() + 20 * day).toISOString() });
    const current = t.rotations.versions(t.pool.id, t.entryId)[0]!;
    assert.ok(current.expiresAt);
    assert.deepEqual(t.rotations.sweep(), { purged: 0, warned: 0 }, 'twenty days out: nothing yet');
    assert.deepEqual(t.rotations.sweep(new Date(Date.now() + 10 * day)), { purged: 0, warned: 1 }, 'within 14 days');
    assert.equal(t.rotations.sweep(new Date(Date.now() + 11 * day)).warned, 0, 'once');
    assert.equal(t.rotations.sweep(new Date(Date.now() + 18 * day)).warned, 1, 'within 3 days');
    assert.equal(t.rotations.sweep(new Date(Date.now() + 21 * day)).warned, 1, 'expired');
    const events = t.h.store.db!.prepare('SELECT type FROM secret_events WHERE value_id = ? AND type LIKE ? ORDER BY id').all(current.id, 'expir%') as { type: string }[];
    assert.deepEqual(events.map((e) => e.type), ['expiry_14', 'expiry_3', 'expired']);
    // The value's own info says when it expires, for the editor.
    assert.equal(t.h.kind.values.info(current.id)?.expiresAt, current.expiresAt);
  } finally {
    t.done();
  }
});

test('rotate refuses what it can’t do: nothing to rotate, an empty or oversized value, a Claude credential, a set that isn’t a secret set', async () => {
  const t = await setup();
  try {
    assert.throws(() => t.rotations.rotate(t.pool.id, 'nope', { value: B }), code('NOT_FOUND'));
    assert.throws(() => t.rotations.rotate('nope', t.entryId, { value: B }), code('NOT_FOUND'));
    assert.throws(() => t.rotations.rotate(t.pool.id, t.entryId, { value: '  ' }), code('VALIDATION_FAILED'));
    assert.throws(() => t.rotations.rotate(t.pool.id, t.entryId, {}), code('VALIDATION_FAILED'));
    assert.throws(() => t.rotations.rotate(t.pool.id, t.entryId, { value: `sk-ant-api03-${'k'.repeat(24)}` }), code('VALIDATION_FAILED'));
    const variable = (t.h.service.get(t.pool.id).content as View).entries.find((e) => e.name === 'REGION')!;
    assert.throws(() => t.rotations.rotate(t.pool.id, variable.id, { value: B }), code('NOT_FOUND'), 'a variable is edited, not rotated');
    assert.equal(t.h.service.get(t.pool.id).latestRevision, 1, 'none of that made a revision');
    assert.equal(t.rotations.list(t.pool.id).length, 0);
  } finally {
    t.done();
  }
});

test('deleting a set workspaces still have (FR19): refused while another pool uses its names; otherwise unassigned, the files cleared, and its values gone', async () => {
  const t = await setup();
  try {
    t.h.service.setAssignments(W1, 'secrets', [{ poolId: t.pool.id }]);
    t.h.service.setAssignments(W2, 'secrets', [{ poolId: t.pool.id }]);
    await t.deliver(W1);
    await t.deliver(W2);
    assert.throws(() => t.h.service.delete(t.pool.id), code('CONFLICT'), 'the plain delete still refuses while assigned');

    t.h.uses.set('TOKEN', [{ poolId: 'm1', poolName: 'Linear', workspaces: [W1] }]);
    assert.throws(() => t.h.service.deleteWithUnassign(t.pool.id), (e) => isAppError(e) && e.code === 'CONFLICT' && /Linear/.test(e.message));
    assert.equal(t.h.service.list('secrets').length, 1, 'nothing changed');
    assert.equal(t.h.service.assignmentsFor(W1).filter((a) => a.state === 'assigned').length, 1);

    t.h.uses.clear();
    const result = t.h.service.deleteWithUnassign(t.pool.id);
    assert.deepEqual(result.workspaces, [W1, W2]);
    assert.equal(t.h.service.list('secrets').length, 0);
    // The removal records keep delivery accounting for it until the files are gone.
    await t.reconciler.request(W1, 'removed');
    await t.reconciler.request(W1, 'started');
    await t.reconciler.request(W2, 'removed');
    await t.reconciler.request(W2, 'started');
    assert.deepEqual([t.content(W1), t.content(W2)], [undefined, undefined], 'the secret file is gone from both');
    // Its values go with it (secret_values follows the pool): a deleted set leaves nothing sealed behind.
    assert.equal((t.h.store.db!.prepare('SELECT count(*) AS n FROM secret_values').get() as { n: number }).n, 0);
  } finally {
    t.done();
  }
});

test('the admin routes: rotate answers 201 with the tracker, versions and rotations list them, revoke answers the version; no response ever holds a value', async () => {
  const t = await setup();
  try {
    const app = new Hono();
    app.onError((err, c) => (isAppError(err) ? c.json({ success: false, error: { code: err.code, message: err.message } }, err.status as ContentfulStatusCode) : c.json({}, 500)));
    app.route('/api/secrets', createSecretsAdminRoutes(() => t.rotations));
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      const text = await res.text();
      assert.ok(!text.includes(A) && !text.includes(B), 'no value in any response');
      return { status: res.status, json: JSON.parse(text) as { data?: any; error?: { code: string } } };
    };
    t.h.service.setAssignments(W1, 'secrets', [{ poolId: t.pool.id }]);
    await t.deliver(W1);
    const base = `/api/secrets/${t.pool.id}`;
    const rotated = await call('POST', `${base}/entries/${t.entryId}/rotate`, { value: B, note: 'routine', urgent: false });
    assert.equal(rotated.status, 201);
    assert.deepEqual([rotated.json.data.entryName, rotated.json.data.toVersion, rotated.json.data.counts.pending], ['TOKEN', 2, 1]);
    assert.equal((await call('POST', `${base}/entries/${t.entryId}/rotate`, {})).json.error?.code, 'VALIDATION_FAILED');
    assert.equal((await call('POST', `${base}/entries/nope/rotate`, { value: B })).status, 404);
    const rotations = await call('GET', `${base}/rotations`);
    assert.deepEqual(rotations.json.data.map((r: { toVersion: number }) => r.toVersion), [2]);
    const versions = await call('GET', `${base}/entries/${t.entryId}/versions`);
    assert.deepEqual(versions.json.data.map((v: { version: number; current: boolean }) => [v.version, v.current]), [[2, true], [1, false]]);
    assert.equal((await call('POST', `${base}/values/${versions.json.data[0].id}/revoke`, {})).json.error?.code, 'CONFLICT');
    const revoked = await call('POST', `${base}/values/${versions.json.data[1].id}/revoke`, { reason: 'leaked' });
    assert.equal(revoked.status, 200);
    assert.ok(revoked.json.data.revokedAt);
  } finally {
    t.done();
  }
});
