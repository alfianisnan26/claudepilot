// T-MGR (docs/prd/targets-connect.md §12.5, §12.8, FR36 to FR38): the manager with runtimes that come and go. Add, replace and remove a
// runtime while running (the check cache follows, the replaced one is disposed, its watcher moves); an unreachable enrolled target
// serves its last list as `unreachable`; scanned ones are skipped as before; a create carries `node` into the runtime and the pending
// entry and goes through `beforeCreate`; a call that meets an outage is a 503 "Target unreachable (since …)"; `resume()` waits for
// `settled` before judging a pending create on a target that is not there yet.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '@isnanme/core';
import type { Workspace } from '@portal/contracts';
import type { JsonFile } from '../../jsonFile.js';
import { Workspaces } from '../manager.js';
import { TargetUnreachableError, type CreateSpec, type Runtime } from '../runtime.js';

function enrolled(id: string, opts: { up?: boolean; list?: Workspace[] } = {}) {
  const state = { up: opts.up ?? true, disposed: 0, watchers: 0, creates: [] as CreateSpec[], list: opts.list ?? [] };
  const ws = (name: string, status: Workspace['status'] = 'running'): Workspace => ({ id: `${id}/${name}`, name, target: id, image: 'img', status, createdAt: '2026-10-12T00:00:00.000Z' });
  const runtime = {
    target: { id, label: id, kind: 'docker' as const, where: 'tunnel', source: 'enrolled' as const, role: 'cluster' as const },
    check: async () => {
      if (!state.up) throw new TargetUnreachableError(id, '2026-10-12T14:02:00.000Z');
    },
    list: async () => {
      if (!state.up) throw new TargetUnreachableError(id, '2026-10-12T14:02:00.000Z');
      return state.list;
    },
    listLastKnown: () => state.list.map((w) => ({ ...w, status: 'unreachable' as const, lastSeenAt: '2026-10-12T14:02:00.000Z' })),
    create: async (spec: CreateSpec) => {
      state.creates.push(spec);
      state.list = [...state.list, ws(spec.name)];
    },
    start: async () => {
      if (!state.up) throw new TargetUnreachableError(id, '2026-10-12T14:02:00.000Z');
    },
    watch: () => {
      state.watchers++;
      return () => void state.watchers--;
    },
    dispose: () => void state.disposed++,
  } as unknown as Runtime;
  return { runtime, state, ws };
}

const memory = (initial: Workspace[] = []) => {
  let saved = initial;
  return { read: () => saved, write: (v: Workspace[]) => void (saved = v) } as unknown as JsonFile<Workspace[]>;
};

test('runtimes are added, replaced and removed while running; caches, watchers and disposal follow', async () => {
  const m = new Workspaces([], memory());
  const changes: (string | null)[] = [];
  m.onRuntimeChange((id, r) => changes.push(r ? `+${id}` : `-${id}`));
  const a = enrolled('cx3-a', { up: false });
  m.addRuntime(a.runtime);
  assert.equal((await m.targets())[0]!.available, false);
  assert.equal(a.state.watchers, 1);
  // A replacement that is up is seen at once: the old check result is not reused.
  const b = enrolled('cx3-a');
  m.replaceRuntime(b.runtime);
  assert.equal(a.state.disposed, 1);
  assert.equal(a.state.watchers, 0);
  assert.equal(b.state.watchers, 1);
  assert.equal((await m.targets())[0]!.available, true);
  m.removeRuntime('cx3-a');
  assert.equal(b.state.disposed, 1);
  assert.deepEqual(await m.targets(), []);
  assert.deepEqual(changes, ['+cx3-a', '+cx3-a', '-cx3-a']);
});

test('an unreachable enrolled target serves its last list as unreachable; calls are a 503 that says since when', async () => {
  const e = enrolled('cx3-e');
  e.state.list = [e.ws('w1')];
  const m = new Workspaces([], memory(), { ttlMs: 0 });
  m.addRuntime(e.runtime);
  assert.equal((await m.list())[0]!.status, 'running');
  e.state.up = false;
  await m.targets(true);
  const [w] = await m.list();
  assert.equal(w!.status, 'unreachable');
  assert.equal(w!.lastSeenAt, '2026-10-12T14:02:00.000Z');
  await assert.rejects(m.start('cx3-e', 'w1'), (err: AppError) => err.code === 'SERVICE_UNAVAILABLE' && /Target unreachable \(since 14:02\)/.test(err.message));
  // exists() answers yes (the next call says why), and usage skips it.
  assert.equal(await m.exists('cx3-e', 'w1'), true);
  assert.deepEqual(await m.usage(), []);
  // The tunnel dropped between the check and the list: the same, not an empty list.
  e.state.up = true;
  await m.targets(true);
  e.state.up = false;
  assert.equal((await m.list())[0]!.status, 'unreachable');
});

test('create carries node into the runtime and the pending entry, after beforeCreate', async () => {
  const e = enrolled('cx3-c');
  const m = new Workspaces([], memory());
  m.addRuntime(e.runtime);
  const asked: [string, string | undefined][] = [];
  m.hooks.beforeCreate = (t, n) => {
    asked.push([t, n]);
    if (n === 'full') throw new AppError('LIMIT_REACHED', 'Full.');
  };
  const w = await m.create({ name: 'x1', target: 'cx3-c', node: 'n2' });
  assert.equal(w.node, 'n2');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(e.state.creates[0]!.node, 'n2');
  await assert.rejects(m.create({ name: 'x2', target: 'cx3-c', node: 'full' }), /Full/);
  await assert.rejects(m.create({ name: 'x3', target: 'cx3-c', node: '../x' }), /Pick a node/);
  assert.deepEqual(asked, [['cx3-c', 'n2'], ['cx3-c', 'full']]);
});

test('resume waits for settled: a pending create on an enrolled target that arrives within the grace resumes', async () => {
  const pending: Workspace = { id: 'cx3-r/w9', name: 'w9', target: 'cx3-r', image: '', status: 'creating', createdAt: '2026-10-12T00:00:00.000Z', node: 'n1' };
  const store = memory([pending]);
  const m = new Workspaces([], store);
  const e = enrolled('cx3-r');
  m.hooks.settled = async () => {
    // The agents come back during the grace; connect binds the runtime.
    await new Promise((r) => setTimeout(r, 30));
    m.addRuntime(e.runtime);
  };
  await m.resume();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(e.state.creates[0]?.name, 'w9');
  assert.equal(e.state.creates[0]?.node, 'n1');
  const listed = await m.list();
  assert.equal(listed.find((w) => w.id === 'cx3-r/w9')!.status, 'running');
});

test('without settled (no Connect) resume judges at once, as before', async () => {
  const pending: Workspace = { id: 'gone/w', name: 'w', target: 'gone', image: '', status: 'creating', createdAt: '2026-10-12T00:00:00.000Z' };
  const m = new Workspaces([], memory([pending]));
  await m.resume();
  assert.match((await m.list())[0]!.detail!, /Could not resume after restart/);
});

test('an enrolled target that is not back when the grace ends: the create waits and resumes when it returns (T6: a crash, an agent in its backoff)', async () => {
  const pending: Workspace = { id: 'cx3-s/w8', name: 'w8', target: 'cx3-s', image: '', status: 'creating', createdAt: '2026-10-12T00:00:00.000Z', node: 'n1' };
  const store = memory([pending]);
  const m = new Workspaces([], store, { ttlMs: 0 });
  const e = enrolled('cx3-s', { up: false });
  m.addRuntime(e.runtime);
  m.hooks.settled = async () => undefined; // the grace ran out with the agent still away
  await m.resume();
  const waiting = (await m.list()).find((w) => w.id === 'cx3-s/w8')!;
  assert.equal(waiting.status, 'creating');
  assert.match(waiting.detail!, /Waiting for cx3-s to reconnect/);
  assert.equal(store.read()[0]!.status, 'creating', 'still pending on disk: a second restart keeps waiting');
  assert.equal(e.state.creates.length, 0);
  // The agent comes back: wireConnect calls recheck; two nodes returning at once launch it once.
  e.state.up = true;
  await Promise.all([m.recheck('cx3-s'), m.recheck('cx3-s')]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(e.state.creates.length, 1);
  assert.equal(e.state.creates[0]!.node, 'n1');
  assert.equal((await m.list()).find((w) => w.id === 'cx3-s/w8')!.status, 'running');
});

test('a create waiting for its target can be removed (nothing runs it here), and a scanned target that is down still fails it', async () => {
  const pending: Workspace = { id: 'cx3-t/w7', name: 'w7', target: 'cx3-t', image: '', status: 'creating', createdAt: '2026-10-12T00:00:00.000Z' };
  const m = new Workspaces([], memory([pending]), { ttlMs: 0 });
  const e = enrolled('cx3-t', { up: false });
  m.addRuntime(e.runtime);
  m.hooks.settled = async () => undefined;
  await m.resume();
  await m.remove('cx3-t', 'w7');
  assert.equal((await m.list()).length, 0);
  e.state.up = true;
  await m.recheck('cx3-t');
  assert.equal(e.state.creates.length, 0, 'a removed waiting create is not launched when the target returns');

  const scannedPending: Workspace = { ...pending, id: 'cx3-u/w6', name: 'w6', target: 'cx3-u' };
  const m2 = new Workspaces([], memory([scannedPending]), { ttlMs: 0 });
  const s = enrolled('cx3-u', { up: false });
  (s.runtime.target as { source: string }).source = 'scanned';
  m2.addRuntime(s.runtime);
  m2.hooks.settled = async () => undefined;
  await m2.resume();
  assert.match((await m2.list()).find((w) => w.id === 'cx3-u/w6')?.detail ?? '', /Could not resume after restart/);
});
