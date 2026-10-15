// T-515 fix round S2: what S1 left open.
// - A workspace shown `unavailable` (last-known data) takes no runtime action: the server refuses at once with a clear error instead of
//   waiting for the Kubernetes client's timeout.
// - The whole list wait (the target's check plus its list) is bounded by one deadline, not 4 s + 8 s.
// - A bad element in the stored last-known file (or a corrupt or missing file) is skipped, never the whole list.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Workspace, WorkspaceTarget } from '@portal/contracts';
import { isAppError } from '@isnanme/core';
import { FakeKube } from '../connect/agent/testkit/fakeKube.js';
import { JsonFile } from '../jsonFile.js';
import { kubeRuntimeOn } from './kubeTestkit.js';
import { Workspaces, type LastKnownLists } from './manager.js';
import type { Runtime } from './runtime.js';

const pendingFile = { read: () => [] as Workspace[], write: () => undefined } as unknown as JsonFile<Workspace[]>;
const AT = '2026-01-01T00:00:00.000Z';
const kohi: Workspace = { id: 'kubernetes/kohi', name: 'kohi', target: 'kubernetes', image: 'img', status: 'running', createdAt: AT };

/** A target whose list can be made to fail; every runtime action counts its calls and never answers (as a hung API would). */
function flaky() {
  const calls: string[] = [];
  const hang = (what: string) => () => (calls.push(what), new Promise<never>(() => undefined));
  const state = { fail: false, listed: 0 };
  const runtime = {
    target: { id: 'kubernetes', label: 'Kubernetes', kind: 'kubernetes', where: 'ns' } as Omit<WorkspaceTarget, 'available' | 'problem'>,
    check: async () => undefined,
    list: async () => {
      state.listed++;
      if (state.fail) throw new Error('connection refused');
      return [kohi];
    },
    start: hang('start'),
    stop: hang('stop'),
    remove: hang('remove'),
    exec: hang('exec'),
    shell: hang('shell'),
    recreate: hang('recreate'),
  } as unknown as Runtime;
  return { runtime, calls, state };
}

const refused = (e: unknown) => isAppError(e) && e.code === 'SERVICE_UNAVAILABLE' && /Kubernetes isn’t answering \(connection refused\)/.test(e.message);

test('an unavailable workspace takes no runtime action: refused at once with the reason, nothing sent to the runtime', async () => {
  const { runtime, calls, state } = flaky();
  const ws = new Workspaces([runtime], pendingFile, { ttlMs: 0, timeoutMs: 100, listTimeoutMs: 100 });
  assert.equal((await ws.list())[0]?.status, 'running');
  // Before the outage the actions reach the runtime (they hang here, so only the call is counted).
  void ws.start('kubernetes', 'kohi').catch(() => undefined);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, ['start']);
  calls.length = 0;

  state.fail = true;
  assert.equal((await ws.list())[0]?.status, 'unavailable');
  const t = Date.now();
  const actions: Array<[string, () => Promise<unknown>]> = [
    ['start', () => ws.start('kubernetes', 'kohi')],
    ['stop', () => ws.stop('kubernetes', 'kohi')],
    ['remove', () => ws.remove('kubernetes', 'kohi')],
    ['exec', () => ws.exec('kubernetes', 'kohi', ['true'])],
    ['shell', () => ws.shell('kubernetes', 'kohi', { cols: 80, rows: 24 })],
    ['recreate', () => ws.recreate('kubernetes', 'kohi', 'img', () => undefined)],
  ];
  // A call that is not refused hangs (the runtime never answers): the race turns that into a failure instead of a stuck test.
  const within = <T>(p: Promise<T>) => {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([p, new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error('hung: not refused')), 500)))]).finally(() => clearTimeout(timer));
  };
  for (const [name, run] of actions) await assert.rejects(within(run()), refused, `${name} is refused with the clear error`);
  assert.ok(Date.now() - t < 80, `all refused in ${Date.now() - t} ms`);
  assert.deepEqual(calls, [], 'nothing reached the runtime');
  assert.ok((await ws.list()).some((w) => w.id === 'kubernetes/kohi'), 'remove did not forget the workspace');

  // It answers again: the refusal ends with the next good list.
  state.fail = false;
  assert.equal((await ws.list())[0]?.status, 'running');
  void ws.stop('kubernetes', 'kohi').catch(() => undefined);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, ['stop']);
});

test('the whole list wait is bounded: a first check that hangs does not add its time to the list’s', async () => {
  const fake = await FakeKube.start();
  const dir = mkdtempSync(join(tmpdir(), 't515s2-'));
  try {
    const lastKnown = new JsonFile<LastKnownLists>(join(dir, 'last.json'), {});
    lastKnown.write({ kubernetes: { at: AT, workspaces: [kohi] } });
    fake.stalled = true;
    // The check may take 1.5 s and the list 0.2 s: S1 waited for both (1.5 s on a first ask); one deadline of 0.2 s now.
    const ws = new Workspaces([kubeRuntimeOn(fake, undefined, { targetId: 'kubernetes' })], pendingFile, { ttlMs: 10_000, timeoutMs: 1_500, listTimeoutMs: 200 }, undefined, lastKnown);
    const t = Date.now();
    const list = await ws.list();
    const ms = Date.now() - t;
    assert.ok(ms < 900, `the list answered in ${ms} ms`);
    assert.deepEqual(list.map((w) => [w.id, w.status, w.lastSeenAt]), [['kubernetes/kohi', 'unavailable', AT]]);
    assert.match(list[0]?.detail ?? '', /Timed out/);
    assert.equal(ws.isUnavailable('kubernetes'), true);
  } finally {
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A Workspaces whose runtime fails its list, started from `file` as the stored last-known lists. */
async function listFrom(file: JsonFile<LastKnownLists>) {
  const { runtime, state } = flaky();
  state.fail = true;
  return new Workspaces([runtime], pendingFile, { ttlMs: 0, timeoutMs: 100, listTimeoutMs: 100 }, undefined, file);
}

test('the stored last-known file: a missing file lists nothing, a corrupt one lists nothing, neither fails the list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't515s2-'));
  try {
    const missing = await listFrom(new JsonFile<LastKnownLists>(join(dir, 'none.json'), {}));
    assert.deepEqual(await missing.list(), []);
    const bad = join(dir, 'corrupt.json');
    writeFileSync(bad, '{"kubernetes": {"at": "2026-01-01', 'utf8');
    assert.deepEqual(await (await listFrom(new JsonFile<LastKnownLists>(bad, {}))).list(), []);
    for (const [name, body] of [['null.json', 'null'], ['array.json', '[1,null]'], ['text.json', '"x"']] as const) {
      const p = join(dir, name);
      writeFileSync(p, body, 'utf8');
      assert.deepEqual(await (await listFrom(new JsonFile<LastKnownLists>(p, {}))).list(), [], name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the stored last-known file: a null or wrong-shaped element is skipped, the good ones and the other targets stay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't515s2-'));
  try {
    const p = join(dir, 'last.json');
    const stored = {
      kubernetes: { at: AT, workspaces: [null, 7, 'x', { id: 'kubernetes/odd' }, { ...kohi, name: 5 }, kohi, []] },
      docker: null,
      other: { at: AT, workspaces: 'nope' },
    };
    writeFileSync(p, JSON.stringify(stored), 'utf8');
    const ws = await listFrom(new JsonFile<LastKnownLists>(p, {}));
    const list = await ws.list();
    assert.deepEqual(list.map((w) => [w.id, w.status]), [['kubernetes/kohi', 'unavailable']]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
