// The wiring of a tunnelled target end to end without the hub: a stand-in Connect module (what `bind` and `onReturned` do) feeds the
// manager a Host single made by the real factory over a FakeLink to T2's host service. The workspace lists Running; the tunnel drops:
// Unreachable with `lastSeenAt`, a 503 "Target unreachable", chat told the target is down; it returns: chat and delivery are told,
// the workspace is Running again. Quota hooks reach Connect's canCreate.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Workspace } from '@portal/contracts';
import { silentLogger } from '../../connect/agent/log.js';
import { createService } from '../../connect/agent/services/host/index.js';
import type { RuntimeFactory } from '../../connect/seams.js';
import type { JsonFile } from '../../jsonFile.js';
import { Workspaces } from '../manager.js';
import { FakeLink, memoryDeps, targetRecord } from './testkit.js';
import { wireConnect } from './wire.js';

test('wireConnect: a Host single through the manager, across an outage', async () => {
  const hold = setInterval(() => undefined, 1000);
  const home = mkdtempSync(join(tmpdir(), 'cx3-wire-'));
  try {
    const link = new FakeLink('n1', 'cx3-box', { host: createService({ mode: 'host', home, log: silentLogger, baseEnv: { PATH: process.env.PATH } }) }).connect();
    const deps = memoryDeps();
    deps.switches.set('cx3-box', true);
    let factory: RuntimeFactory | null = null;
    const returned: ((t: string) => void)[] = [];
    const asked: string[] = [];
    const connect = {
      useRuntimeFactory: (f: RuntimeFactory) => void (factory = f),
      bind: (ws: Workspaces) => ws.addRuntime(factory!(targetRecord({ id: 'cx3-box', kind: 'host' }), [{ record: { id: 'n1', targetId: 'cx3-box', name: 'box', drained: false, keyFingerprint: 'x' }, link }], deps)),
      settled: async () => undefined,
      canCreate: (t: string) => void asked.push(t),
      onReturned: (fn: (t: string) => void) => (returned.push(fn), () => undefined),
    };
    let saved: Workspace[] = [];
    const workspaces = new Workspaces([], { read: () => saved, write: (v: Workspace[]) => void (saved = v) } as unknown as JsonFile<Workspace[]>, { ttlMs: 0, timeoutMs: 300 });
    const chatReturned: string[] = [];
    const chat = { targetState: undefined as undefined | ((id: string) => 'up' | 'down'), targetReturned: (t: string) => void chatReturned.push(t) };
    const delivery: string[] = [];
    const reconciler = { runtimeChanged: (t: string) => void delivery.push(`changed ${t}`), requestTarget: (t: string) => void delivery.push(`returned ${t}`) };
    wireConnect({ connect, workspaces, chat, reconciler });

    assert.deepEqual(delivery, ['changed cx3-box']);
    const [w] = await workspaces.list();
    assert.deepEqual([w!.id, w!.status], ['cx3-box/cx3-box', 'running']);
    assert.equal(chat.targetState!('cx3-box/cx3-box'), 'up');
    const t = (await workspaces.targets()).find((x) => x.id === 'cx3-box')!;
    assert.deepEqual([t.kind, t.source, t.role, t.available], ['local', 'enrolled', 'single', true]);
    // A single has nothing to create (as This machine): the create fails in the background and stays as an error until removed.
    await workspaces.create({ name: 'x', target: 'cx3-box' });
    assert.deepEqual(asked, ['cx3-box']);
    await new Promise((r) => setTimeout(r, 20));
    assert.match((await workspaces.list()).find((x) => x.name === 'x')!.detail!, /Start it instead/);
    await workspaces.remove('cx3-box', 'x').catch(() => undefined);

    link.drop();
    await workspaces.targets(true);
    const [gone] = await workspaces.list();
    assert.equal(gone!.status, 'unreachable');
    assert.ok(gone!.lastSeenAt);
    assert.equal(chat.targetState!('cx3-box/cx3-box'), 'down');
    await assert.rejects(workspaces.exec('cx3-box', 'cx3-box', ['true']), /Target unreachable/);

    link.connect();
    returned.forEach((fn) => fn('cx3-box'));
    assert.deepEqual(chatReturned, ['cx3-box']);
    assert.ok(delivery.includes('returned cx3-box'));
    await workspaces.targets(true);
    assert.equal((await workspaces.list())[0]!.status, 'running');
    workspaces.removeRuntime('cx3-box');
    link.drop();
  } finally {
    clearInterval(hold);
    rmSync(home, { recursive: true, force: true });
  }
});

test('wireConnect: with a long check cache, a target whose tunnel drops is unavailable at once and one that returns is available and Running at once (recheck)', async () => {
  const hold = setInterval(() => undefined, 1000);
  const home = mkdtempSync(join(tmpdir(), 'cx3-wire-'));
  try {
    const link = new FakeLink('n1', 'cx3-box', { host: createService({ mode: 'host', home, log: silentLogger, baseEnv: { PATH: process.env.PATH } }) }).connect();
    const deps = memoryDeps();
    deps.switches.set('cx3-box', true);
    let factory: RuntimeFactory | null = null;
    const returned: ((t: string) => void)[] = [];
    const lost: ((t: string) => void)[] = [];
    const connect = {
      useRuntimeFactory: (f: RuntimeFactory) => void (factory = f),
      bind: (ws: Workspaces) => ws.addRuntime(factory!(targetRecord({ id: 'cx3-box', kind: 'host' }), [{ record: { id: 'n1', targetId: 'cx3-box', name: 'box', drained: false, keyFingerprint: 'x' }, link }], deps)),
      settled: async () => undefined,
      canCreate: () => undefined,
      onReturned: (fn: (t: string) => void) => (returned.push(fn), () => undefined),
      onLost: (fn: (t: string) => void) => (lost.push(fn), () => undefined),
    };
    let saved: Workspace[] = [];
    // A minute of cache: without the recheck the list would keep its first answer for that long.
    const workspaces = new Workspaces([], { read: () => saved, write: (v: Workspace[]) => void (saved = v) } as unknown as JsonFile<Workspace[]>, { ttlMs: 60_000, timeoutMs: 300 });
    const undo = wireConnect({ connect, workspaces });
    assert.equal((await workspaces.list())[0]!.status, 'running');

    link.drop();
    lost.forEach((fn) => fn('cx3-box'));
    await until(async () => (await workspaces.targets()).find((x) => x.id === 'cx3-box')!.available === false);
    assert.equal((await workspaces.list())[0]!.status, 'unreachable');

    link.connect();
    returned.forEach((fn) => fn('cx3-box'));
    await until(async () => (await workspaces.targets()).find((x) => x.id === 'cx3-box')!.available === true);
    assert.equal((await workspaces.list())[0]!.status, 'running');
    undo();
    workspaces.removeRuntime('cx3-box');
    link.drop();
  } finally {
    clearInterval(hold);
    rmSync(home, { recursive: true, force: true });
  }
});

async function until(ok: () => Promise<boolean>, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
