// 2026-11-02: one `list()` answer serves every caller for `listCacheMs` (the Dashboard, CI's repos and the usage card each listed every
// target through the Kubernetes API per poll and kept the portal's event loop busy). Concurrent calls share the one in flight; a change
// through the manager drops it; without the option every call lists, as before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workspace, WorkspaceTarget } from '@portal/contracts';
import type { JsonFile } from '../jsonFile.js';
import { Workspaces } from './manager.js';
import type { Runtime } from './runtime.js';

const saved = { read: () => [] as Workspace[], write: () => undefined } as unknown as JsonFile<Workspace[]>;

function counting(target: string) {
  const t: WorkspaceTarget = { id: target, label: target, kind: 'docker', where: `/${target}`, available: true };
  const calls = { list: 0 };
  const ws: Workspace = { id: `${target}/one`, name: 'one', runtimeName: 'claudepilot-one', target, image: 'img', status: 'running', createdAt: '2026-10-01T00:00:00.000Z' };
  const runtime = {
    target: t,
    check: async () => undefined,
    list: async () => {
      calls.list++;
      await new Promise((r) => setTimeout(r, 20));
      return [ws];
    },
    start: async () => undefined,
  } as unknown as Runtime;
  return { runtime, calls };
}

test('2026-11-02: list() is shared while in flight and for listCacheMs; a change drops it; no option lists every time', async () => {
  const a = counting('docker');
  const m = new Workspaces([a.runtime], saved, { listCacheMs: 200 });
  const [x, y] = await Promise.all([m.list(), m.list()]);
  assert.equal(a.calls.list, 1, 'two concurrent calls, one listing');
  assert.deepEqual(x, y);
  await m.list();
  assert.equal(a.calls.list, 1, 'a call within the cache time is answered from it');
  await m.start('docker', 'one').catch(() => undefined);
  await m.list();
  assert.equal(a.calls.list, 2, 'a start drops the cached list');
  await new Promise((r) => setTimeout(r, 250));
  await m.list();
  assert.equal(a.calls.list, 3, 'an answer older than the cache time is not used');

  const b = counting('docker');
  const plain = new Workspaces([b.runtime], saved);
  await Promise.all([plain.list(), plain.list()]);
  await plain.list();
  assert.equal(b.calls.list, 3, 'without listCacheMs every call lists');
});
