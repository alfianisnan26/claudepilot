// The tables: rows round-trip and a damaged one reads as nothing rather than throwing; events page and filter; retention keeps 90 days and a
// cap per workspace; a removed workspace's repositories go and its events stay until they age out.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../store/store.js';
import { generateSecretKey, parseSecretKey } from '../store/secretBox.js';
import { EVENTS_PER_WORKSPACE, RepoStore, type NewEvent } from './store.js';
import type { NodeCore } from './tree.js';

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'cp-repos-store-'));
  const store = await Store.open({ dataDir: dir, secretKey: parseSecretKey(generateSecretKey()) });
  return { store, s: new RepoStore(store), done: () => (store.close(), rmSync(dir, { recursive: true, force: true })) };
}
const node = (path: string, over: Partial<NodeCore> = {}): NodeCore => ({ id: `r_${createHash('sha1').update(path).digest('hex').slice(0, 12)}`, workspaceId: 'docker/a', path, name: path, kind: 'repo', parentId: null, mainId: null, state: null, error: null, worktree: null, submodule: null, drifted: 0, ...over });
const ev = (over: Partial<NewEvent> = {}): NewEvent => ({ at: new Date().toISOString(), workspaceId: 'docker/a', repoId: null, repo: null, kind: 'dirty', actor: 'workspace', sessionId: null, summary: 's', data: {}, ...over });

test('a repository round-trips, keeps when it was first seen and its sync settings through a rescan, and comes back under the same id after being removed', async () => {
  const { s, done } = await rig();
  try {
    const a = node('/h/a', { submodule: { recorded: 'a'.repeat(40), url: 'https://x/a.git', drifted: true }, drifted: 2, worktree: { locked: true, prunable: false } });
    s.save([a], '2026-10-01T00:00:00.000Z');
    s.setSync(a.id, true);
    s.recordSync(a.id, '2026-10-02T00:00:00.000Z', 'refused', 'no upstream');
    s.save([{ ...a, name: 'renamed' }], '2026-10-05T00:00:00.000Z');
    const row = s.row(a.id)!;
    assert.deepEqual([row.name, row.firstSeenAt, row.scannedAt, row.sync, row.submodule, row.drifted, row.worktree], ['renamed', '2026-10-01T00:00:00.000Z', '2026-10-05T00:00:00.000Z', { enabled: true, at: '2026-10-02T00:00:00.000Z', outcome: 'refused', note: 'no upstream' }, a.submodule, 2, a.worktree]);
    s.markRemoved([a.id], '2026-10-06T00:00:00.000Z');
    assert.equal(s.row(a.id), null);
    assert.deepEqual(s.rows('docker/a'), []);
    assert.equal(s.rows('docker/a', { removed: true }).length, 1);
    s.save([a], '2026-10-07T00:00:00.000Z');
    assert.deepEqual([s.row(a.id)!.removedAt, s.row(a.id)!.sync.enabled, s.row(a.id)!.firstSeenAt], [null, true, '2026-10-01T00:00:00.000Z']);
  } finally {
    done();
  }
});

test('damaged rows read as nothing useful rather than throwing', async () => {
  const { store, s, done } = await rig();
  try {
    s.save([node('/h/a')], '2026-10-01T00:00:00.000Z');
    store.db!.prepare(`UPDATE repos SET state = 'not json', extra = '[1]'`).run();
    const row = s.rows('docker/a')[0]!;
    assert.deepEqual([row.state, row.worktree, row.submodule, row.drifted], [null, null, null, 0]);
    store.db!.prepare(`UPDATE repo_events SET data = 'x'`).run();
    s.addEvents([ev()]);
    store.db!.prepare(`UPDATE repo_events SET data = 'x', kind = 'weird'`).run();
    assert.deepEqual([s.events({}).events[0]!.data, s.events({}).events[0]!.kind], [{}, 'scan_failed']);
  } finally {
    done();
  }
});

test('events page newest first with a cursor, and filter by workspace, repository, kind and the audit group', async () => {
  const { s, done } = await rig();
  try {
    const kinds = ['dirty', 'clean', 'head_moved', 'sync', 'worktree_created', 'sync'] as const;
    s.addEvents(kinds.map((kind, i) => ev({ kind, repoId: i % 2 ? 'r_b' : 'r_a', workspaceId: i === 5 ? 'docker/b' : 'docker/a', summary: `e${i}` })));
    const p1 = s.events({ limit: 2 });
    assert.deepEqual(p1.events.map((e) => e.summary), ['e5', 'e4']);
    const p2 = s.events({ limit: 2, before: p1.next! });
    assert.deepEqual(p2.events.map((e) => e.summary), ['e3', 'e2']);
    assert.equal(s.events({ limit: 10, before: p2.next! }).next, null);
    assert.deepEqual(s.events({ workspaceId: 'docker/a' }).events.map((e) => e.summary), ['e4', 'e3', 'e2', 'e1', 'e0']);
    assert.deepEqual(s.events({ repoId: 'r_b' }).events.map((e) => e.summary), ['e5', 'e3', 'e1']);
    assert.deepEqual(s.events({ kind: 'dirty, clean' }).events.map((e) => e.kind), ['clean', 'dirty']);
    assert.deepEqual(s.events({ group: 'audit' }).events.map((e) => e.kind), ['sync', 'worktree_created', 'sync']);
    assert.deepEqual(s.events({ kind: 'nonsense' }).events, [], 'an unknown kind matches nothing');
    assert.equal(s.events({ limit: 9999 }).events.length, 6, 'the limit is capped, not refused');
    assert.deepEqual(s.events({ before: 'x; DROP TABLE repos' }).events.length, 6, 'a cursor that isn’t a number is ignored');
  } finally {
    done();
  }
});

test('retention: events older than 90 days and beyond the per-workspace cap go, repositories gone that long go, a removed workspace’s repositories go at once', async () => {
  const { store, s, done } = await rig();
  try {
    const now = Date.parse('2026-10-12T00:00:00Z');
    const day = 86_400_000;
    s.addEvents([ev({ at: new Date(now - 91 * day).toISOString(), summary: 'old' }), ev({ at: new Date(now - 89 * day).toISOString(), summary: 'recent' })]);
    s.save([node('/h/gone'), node('/h/kept')], new Date(now - 10 * day).toISOString());
    s.markRemoved([node('/h/gone').id], new Date(now - 91 * day).toISOString());
    s.purge(now);
    assert.deepEqual(s.events({}).events.map((e) => e.summary), ['recent']);
    assert.deepEqual(s.rows('docker/a', { removed: true }).map((r) => r.path), ['/h/kept']);
    // the cap
    const many = Array.from({ length: EVENTS_PER_WORKSPACE + 25 }, (_, i) => ev({ at: new Date(now).toISOString(), summary: `n${i}` }));
    s.addEvents(many);
    s.purge(now);
    const left = store.db!.prepare('SELECT count(*) AS n FROM repo_events').get() as { n: number };
    assert.equal(left.n, EVENTS_PER_WORKSPACE);
    assert.equal(s.events({ limit: 1 }).events[0]!.summary, `n${EVENTS_PER_WORKSPACE + 24}`, 'the newest stay');
    s.saveSettings('docker/a', new Date(now).toISOString(), { roots: ['~/x'], auto: false });
    s.forgetWorkspace('docker/a');
    assert.deepEqual([s.rows('docker/a', { removed: true }), s.workspace('docker/a')], [[], null]);
    assert.ok(s.events({}).events.length > 0, 'the audit outlives the workspace until it ages out');
  } finally {
    done();
  }
});

test('settings and the last scan are per workspace and partial updates leave the rest alone', async () => {
  const { s, done } = await rig();
  try {
    const t = '2026-10-12T00:00:00.000Z';
    assert.equal(s.workspace('docker/a'), null);
    s.saveSettings('docker/a', t, { auto: false });
    assert.deepEqual([s.workspace('docker/a')!.roots, s.workspace('docker/a')!.auto], [null, false]);
    s.saveSettings('docker/a', t, { roots: ['~/work'] });
    assert.deepEqual([s.workspace('docker/a')!.roots, s.workspace('docker/a')!.auto], [['~/work'], false]);
    s.saveScan('docker/a', t, { ms: 12, error: 'x', truncated: true });
    assert.deepEqual([s.workspace('docker/a')!.scanAt, s.workspace('docker/a')!.scanMs, s.workspace('docker/a')!.scanError, s.workspace('docker/a')!.scanTruncated], [t, 12, 'x', true]);
    s.saveSettings('docker/a', t, { roots: null });
    assert.equal(s.workspace('docker/a')!.roots, null);
    assert.deepEqual(s.workspaceIds(), ['docker/a']);
  } finally {
    done();
  }
});
