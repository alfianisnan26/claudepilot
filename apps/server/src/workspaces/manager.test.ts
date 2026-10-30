// QA-007: a target that is down (its check ends only by timing out) must not hold up GET /api/workspaces. A checked target
// answers from what was last known while it is checked again in the background; a first ask and a `fresh` ask wait.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workspace, WorkspaceTarget } from '@portal/contracts';
import type { JsonFile } from '../jsonFile.js';
import { Workspaces } from './manager.js';
import type { Runtime } from './runtime.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A runtime whose check the test controls: it counts calls and answers (or hangs) as told. */
function fake(id: string, mode: { check: 'ok' | 'hang' | 'fail' } = { check: 'ok' }, workspaces: Workspace[] = []) {
  const calls = { check: 0, list: 0 };
  const target: WorkspaceTarget = { id, label: id, kind: 'docker', where: `/${id}`, available: true };
  const runtime = {
    target,
    check: () => {
      calls.check++;
      return mode.check === 'ok' ? Promise.resolve() : mode.check === 'fail' ? Promise.reject(new Error('refused')) : new Promise<void>(() => undefined);
    },
    list: async () => {
      calls.list++;
      return workspaces;
    },
  } as unknown as Runtime;
  return { runtime, calls, mode };
}

const saved = { read: () => [] as Workspace[], write: () => undefined } as unknown as JsonFile<Workspace[]>;
const timed = async <T>(p: Promise<T>) => {
  const t = Date.now();
  const value = await p;
  return { value, ms: Date.now() - t };
};

test('a dead target delays only the first ask: later asks answer at once from what is known, and it is checked again in the background', async () => {
  const live = fake('live');
  const dead = fake('dead', { check: 'hang' });
  const w = new Workspaces([live.runtime, dead.runtime], saved, { ttlMs: 60, timeoutMs: 120 });

  const first = await timed(w.targets());
  assert.ok(first.ms >= 100, `the first ask waits for the check (${first.ms} ms)`);
  assert.deepEqual(first.value.map((t) => [t.id, t.available]), [['live', true], ['dead', false]]);
  assert.match(first.value[1]!.problem ?? '', /Timed out/);

  // Fresh within the TTL: nothing runs again.
  const again = await timed(w.targets());
  assert.ok(again.ms < 30);
  assert.equal(dead.calls.check, 1);

  // Stale: answers at once from what was known, and starts one check each, however many ask meanwhile.
  await sleep(80);
  const stale = await Promise.all([timed(w.targets()), timed(w.targets()), timed(w.targets())]);
  for (const s of stale) {
    assert.ok(s.ms < 30, `stale ask took ${s.ms} ms`);
    assert.deepEqual(s.value.map((t) => t.available), [true, false]);
  }
  assert.equal(dead.calls.check, 2, 'one background check, not three');
  assert.ok(live.calls.check <= 3, 'the live one is checked again too, once per stale spell');
  await sleep(160); // the hung check times out and is recorded
  assert.equal(dead.calls.check, 2);
});

test('a target that comes back shows as available after its next background check; one that goes down shows so after its next', async () => {
  const a = fake('a', { check: 'fail' });
  const b = fake('b');
  const w = new Workspaces([a.runtime, b.runtime], saved, { ttlMs: 40, timeoutMs: 200 });
  assert.deepEqual((await w.targets()).map((t) => [t.available, t.problem]), [[false, 'refused'], [true, undefined]]);

  a.mode.check = 'ok';
  b.mode.check = 'fail';
  await sleep(60);
  assert.deepEqual((await w.targets()).map((t) => t.available), [false, true], 'stale answer while the checks run');
  await sleep(30);
  assert.deepEqual((await w.targets()).map((t) => t.available), [true, false], 'the checks finished');
});

test('fresh waits for a new check, and the list is not held up by a target that is down', async () => {
  const live = fake('live', { check: 'ok' }, [{ id: 'live/one', name: 'one', target: 'live', status: 'running', createdAt: '2026-01-01T00:00:00Z' } as unknown as Workspace]);
  const dead = fake('dead', { check: 'hang' });
  // T-1836: the check timeout is wide (300 ms) so that "list did not wait for it" is a clear signal on a busy runner, instead of a hard
  // 40 ms bound on list() that a loaded gate Job sometimes missed.
  const timeoutMs = 300;
  const w = new Workspaces([live.runtime, dead.runtime], saved, { ttlMs: 30, timeoutMs });
  await w.targets(); // warm-up, like the one at start
  await sleep(50);
  const fresh = await timed(w.targets(true));
  assert.ok(fresh.ms >= timeoutMs - 20, `fresh waited for the dead one's timeout (${fresh.ms} ms)`);
  await sleep(50); // the answer is stale now (TTL 30 ms)
  const checksBefore = dead.calls.check;
  const listed = await timed(w.list());
  assert.ok(listed.ms < timeoutMs - 20, `list waited for the dead one's check (${listed.ms} ms)`);
  assert.equal(dead.calls.check, checksBefore + 1, 'the list started a new background check of the down target');
  assert.deepEqual(listed.value.map((x) => x.id), ['live/one']);
  await sleep(timeoutMs + 20); // the hung background check times out and is recorded
});
