import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAppError } from '@isnanme/core';
import type { SecretsContent as View } from '@portal/contracts';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createPoolRoutes } from '../pools/routes.js';
import type { SecretsContent } from './kind.js';
import { secretsHarness } from './testkit.js';

// Secrets & env FR18: rolling back restores entries and plain values, and secrets keep their CURRENT
// version unless the admin ticks "Restore secret versions". Otherwise a token rotated away after a leak
// would be delivered again by a rollback. Rollback and pins refuse revoked versions.

const OLD = 'ghp_OLDleakedTOKEN0123456789abcdefghij';
const NEW = 'ghp_NEWrotatedTOKEN0123456789abcdefgh';
const code = (c: string) => (e: unknown) => isAppError(e) && e.code === c;
type H = Awaited<ReturnType<typeof secretsHarness>>;
const view = (c: unknown) => c as View;

const revisionContent = (h: H, poolId: string, revision: number) =>
  JSON.parse((h.store.db!.prepare('SELECT content FROM pool_revisions WHERE pool_id = ? AND revision = ?').get(poolId, revision) as { content: string }).content) as SecretsContent;
const noteOf = (h: H, poolId: string, revision: number) => (h.store.db!.prepare('SELECT note FROM pool_revisions WHERE pool_id = ? AND revision = ?').get(poolId, revision) as { note: string }).note;

/** What a workspace following the pool gets, flattened: every file's content and the drop-in's settings. */
function delivered(h: H, poolId: string, ws = 'docker/w1'): string {
  const assigned = h.service.assignedPools<SecretsContent>(ws, 'secrets').filter((a) => a.pool.id === poolId);
  const out = h.kind.fragments(assigned, { workspaceId: ws, running: true, now: new Date() });
  return JSON.stringify(out.map((f) => ({ files: (f.files ?? []).map((x) => [x.path, x.content]), settings: f.settings })));
}

/** A set with TOKEN rotated from OLD (r1) to NEW (r2), a plain value changed and an entry added in r2. */
function rotated(h: H) {
  const p = h.service.create('secrets', {
    name: 'team',
    content: { entries: [{ kind: 'variable', name: 'REGION', value: 'eu' }, { kind: 'secret', name: 'TOKEN', newValue: OLD }] },
  });
  h.service.setAssignments('docker/w1', 'secrets', [{ poolId: p.id }]);
  const entries = view(p.content).entries;
  const r2 = h.service.update(p.id, {
    content: {
      entries: [
        { ...entries[0]!, value: 'us' },
        { ...entries[1]!, newValue: NEW },
        { kind: 'variable', name: 'ADDED', value: '1' },
      ],
    },
    note: 'Rotated TOKEN',
  });
  assert.equal(r2.revision, 2);
  return p;
}

test('a roll back restores entries and plain values, and the secret keeps its current version: the leaked token is not delivered again', async () => {
  const h = await secretsHarness();
  try {
    const p = rotated(h);
    assert.ok(delivered(h, p.id).includes(NEW) && !delivered(h, p.id).includes(OLD));

    h.requests.length = 0;
    const back = h.service.makeCurrent(p.id, 1);
    assert.equal(back.revision, 3, 'published as a new revision: history is never rewritten');
    assert.equal(noteOf(h, p.id, 3), 'Rolled back to r1 (secrets keep their current versions)');
    assert.deepEqual(h.requests, ['docker/w1']);

    const r1 = revisionContent(h, p.id, 1);
    const r2 = revisionContent(h, p.id, 2);
    const r3 = revisionContent(h, p.id, 3);
    // Entries and plain values are r1's…
    assert.deepEqual(r3.entries.map((e) => [e.name, e.value]), [['REGION', 'eu'], ['TOKEN', undefined]]);
    // …and the secret is the version r2 had, not the one r1 named.
    assert.equal(r3.entries[1]!.values!.value, r2.entries[1]!.values!.value);
    assert.notEqual(r3.entries[1]!.values!.value, r1.entries[1]!.values!.value);
    // The old revisions are exactly as they were.
    assert.equal(r1.entries[1]!.values!.value, revisionContent(h, p.id, 1).entries[1]!.values!.value);
    assert.equal(r2.entries.length, 3);

    const now = delivered(h, p.id);
    assert.ok(now.includes(NEW), 'the current token is still delivered');
    assert.ok(!now.includes(OLD), 'the rotated-away token never comes back');
    assert.ok(now.includes('"eu"') || now.includes('REGION'), 'plain values are restored');
    assert.ok(!now.includes('ADDED'), 'an entry added after r1 goes');
    // Nothing the API shows carries a value either.
    for (const out of [back, h.service.get(p.id)]) assert.ok(!JSON.stringify(out).includes(OLD) && !JSON.stringify(out).includes(NEW));
  } finally {
    h.done();
  }
});

test('"Restore secret versions" brings back the old ones, and says so; a version that was revoked can never come back', async () => {
  const h = await secretsHarness();
  try {
    const p = rotated(h);
    const back = h.service.makeCurrent(p.id, 1, { restoreSecretVersions: true });
    // r1's content is exactly what restoring means, so r1 itself becomes current.
    assert.equal(back.revision, 1);
    assert.ok(delivered(h, p.id).includes(OLD), 'the old version is delivered because the admin asked');

    // Revoke the old version (FR16): restoring it, and pinning to a revision that holds it, are refused.
    h.store.db!.prepare("UPDATE secret_values SET revoked_at = '2026-10-01T00:00:00.000Z' WHERE version = 1").run();
    h.service.makeCurrent(p.id, 2);
    assert.throws(() => h.service.makeCurrent(p.id, 1, { restoreSecretVersions: true }), (e) => code('CONFLICT')(e) && /revoked on 2026-10-01/.test((e as Error).message));
    assert.throws(
      () => h.service.setAssignments('docker/w2', 'secrets', [{ poolId: p.id, pinnedRevision: 1 }]),
      (e) => code('VALIDATION_FAILED')(e) && /can’t be pinned: “TOKEN” had a value revoked on 2026-10-01/.test((e as Error).message),
    );
    // An ordinary roll back still works: the secret keeps its current (not revoked) version.
    const plain = h.service.makeCurrent(p.id, 1);
    assert.equal(plain.revision, 3);
    assert.ok(!delivered(h, p.id).includes(OLD));
    assert.ok(delivered(h, p.id).includes(NEW));
  } finally {
    h.done();
  }
});

test('an entry the current revision no longer has comes back with its newest version, or "Needs value" when that was revoked', async () => {
  const h = await secretsHarness();
  try {
    const p = h.service.create('secrets', {
      name: 'team',
      content: { entries: [{ kind: 'secret', name: 'KEEP', newValue: 'keep-value-aaaaaaaaaaaa' }, { kind: 'secret', name: 'GONE', newValue: OLD }] },
    });
    const e1 = view(p.content).entries;
    // r2 rotates GONE; r3 removes it.
    h.service.update(p.id, { content: { entries: [e1[0]!, { ...e1[1]!, newValue: NEW }] } });
    const r3 = h.service.update(p.id, { content: { entries: [e1[0]!] } });
    assert.equal(r3.revision, 3);
    h.service.setAssignments('docker/w1', 'secrets', [{ poolId: p.id }]);
    assert.ok(!delivered(h, p.id).includes('GONE'));

    // Rolling back to r1 brings GONE back: with the rotated value, never the one r1 named.
    const back = h.service.makeCurrent(p.id, 1);
    assert.equal(back.revision, 4);
    const now = delivered(h, p.id);
    assert.ok(now.includes(NEW) && !now.includes(OLD), 'the newest version of a returning entry');

    // If that newest version was revoked, the entry returns without a value, and the old one is not used.
    h.service.makeCurrent(p.id, 3);
    h.store.db!.prepare("UPDATE secret_values SET revoked_at = '2026-10-02T00:00:00.000Z' WHERE version = 2").run();
    const empty = h.service.makeCurrent(p.id, 1);
    assert.equal(empty.revision, 5);
    assert.equal(view(empty.content).entries.find((e) => e.name === 'GONE')!.secret, null, 'Needs value');
    const after = delivered(h, p.id);
    assert.ok(!after.includes(OLD) && !after.includes(NEW), 'neither version is delivered');
    assert.ok(after.includes('keep-value-aaaaaaaaaaaa'), 'the entries that are fine keep delivering');
  } finally {
    h.done();
  }
});

test('a secret whose current value was cleared or revoked is not resurrected by a roll back', async () => {
  const h = await secretsHarness();
  try {
    const p = rotated(h);
    // The value r2 has is revoked: a roll back to r1 must not fall back to OLD (it was rotated away).
    h.store.db!.prepare("UPDATE secret_values SET revoked_at = '2026-10-03T00:00:00.000Z' WHERE version = 2").run();
    const back = h.service.makeCurrent(p.id, 1);
    const token = view(back.content).entries.find((e) => e.name === 'TOKEN')!;
    assert.equal(token.secret, null);
    assert.ok(!delivered(h, p.id).includes(OLD));
  } finally {
    h.done();
  }
});

test('the name rules of an edit apply to a roll back: it can’t drop a name another pool uses, or clash with another set', async () => {
  const h = await secretsHarness();
  try {
    const p = h.service.create('secrets', { name: 'team', content: { entries: [{ kind: 'secret', name: 'LINEAR_API_KEY', newValue: OLD }] } });
    h.service.update(p.id, { content: { entries: [{ kind: 'secret', name: 'LINEAR_API_KEY', id: view(p.content).entries[0]!.id }, { kind: 'variable', name: 'NEWVAR', value: '1' }] } });
    // Make r1 a revision without NEWVAR but with a name the MCP set uses; then roll back to a revision without it.
    const r3 = h.service.update(p.id, { content: { entries: [{ kind: 'variable', name: 'ONLY', value: '1' }] } });
    assert.equal(r3.revision, 3);
    h.uses.set('LINEAR_API_KEY', [{ poolId: 'm1', poolName: 'Linear', workspaces: ['docker/w1'] }]);
    // Current r3 lacks LINEAR_API_KEY; rolling back to r1 restores it: allowed. Going back to r3 would drop it again: refused.
    h.service.makeCurrent(p.id, 1);
    const before = h.service.get(p.id);
    // r3 is newer than r1, so this is a forward move: the same rule holds for it.
    assert.throws(() => h.service.makeCurrent(p.id, 3), (e) => code('CONFLICT')(e) && /MCP set “Linear” uses “LINEAR_API_KEY”/.test((e as Error).message));
    const after = h.service.get(p.id);
    assert.deepEqual([after.revision, after.latestRevision], [before.revision, before.latestRevision], 'nothing moved and nothing was added');

    // A clash with another set on a workspace that follows this one.
    h.uses.clear();
    const q = h.service.create('secrets', { name: 'other', content: { entries: [{ kind: 'variable', name: 'ONLY', value: '2' }] } });
    h.service.setAssignments('docker/w9', 'secrets', [{ poolId: p.id }, { poolId: q.id }]);
    assert.throws(() => h.service.makeCurrent(p.id, 3), (e) => code('CONFLICT')(e) && /“ONLY” is also in “other”, which w9 uses/.test((e as Error).message));
  } finally {
    h.done();
  }
});

test('a set with no secret values rolls back as a plain pointer move; a held revision promoted forward is one too', async () => {
  const h = await secretsHarness();
  try {
    const p = h.service.create('secrets', { name: 'vars', content: { entries: [{ kind: 'variable', name: 'A', value: '1' }] } });
    h.service.update(p.id, { content: { entries: [{ kind: 'variable', name: 'A', value: '2' }] } });
    const back = h.service.makeCurrent(p.id, 1);
    assert.deepEqual([back.revision, back.latestRevision], [1, 2], 'no new revision: nothing in it moves with time');

    const held = h.service.update(p.id, { content: { entries: [{ kind: 'variable', name: 'A', value: '3' }] }, hold: true });
    assert.deepEqual([held.revision, held.latestRevision], [1, 3]);
    assert.equal(h.service.makeCurrent(p.id, 3).revision, 3);
    assert.equal(h.service.get(p.id).latestRevision, 3);
  } finally {
    h.done();
  }
});

test('a workspace pinned to an older revision stays pinned through a roll back (a pin is an explicit choice)', async () => {
  const h = await secretsHarness();
  try {
    const p = rotated(h);
    h.service.setAssignments('docker/pinned', 'secrets', [{ poolId: p.id, pinnedRevision: 1 }]);
    h.service.makeCurrent(p.id, 1);
    assert.equal(h.service.assignedPools('docker/pinned', 'secrets')[0]!.pool.revision, 1);
    assert.equal(h.service.assignedPools('docker/w1', 'secrets')[0]!.pool.revision, 3);
    assert.ok(delivered(h, p.id, 'docker/pinned').includes(OLD), 'pinning is the staged-rollout tool, and the pin holds its revision as it was');
    assert.ok(!delivered(h, p.id, 'docker/w1').includes(OLD));
  } finally {
    h.done();
  }
});

test('the route: POST …/revisions/:rev/current rolls back keeping secrets, and restoreSecretVersions asks for the old ones', async () => {
  const h = await secretsHarness();
  try {
    const p = rotated(h);
    const app = new Hono();
    app.onError((err, c) => (isAppError(err) ? c.json({ success: false, error: { code: err.code, message: err.message } }, err.status as ContentfulStatusCode) : c.json({}, 500)));
    app.route('/api/pools', createPoolRoutes({ service: h.service }));
    const post = (rev: number, body?: unknown) =>
      app.request(`/api/pools/secrets/${p.id}/revisions/${rev}/current`, { method: 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const plain = await post(1);
    assert.equal(plain.status, 200);
    assert.equal(((await plain.json()) as { data: { revision: number } }).data.revision, 3);
    assert.ok(!delivered(h, p.id).includes(OLD));
    const restore = await post(1, { restoreSecretVersions: true });
    assert.equal(((await restore.json()) as { data: { revision: number } }).data.revision, 1);
    assert.ok(delivered(h, p.id).includes(OLD));
    // Only `true` counts; anything else is the safe default.
    await post(2);
    const strange = await post(1, { restoreSecretVersions: 'yes' });
    assert.equal(((await strange.json()) as { data: { revision: number } }).data.revision, 4);
    assert.ok(!delivered(h, p.id).includes(OLD));
  } finally {
    h.done();
  }
});
