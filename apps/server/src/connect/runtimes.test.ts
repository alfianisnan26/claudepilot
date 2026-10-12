// T-MGR (the Connect side, docs/prd/targets-connect.md §12.1, §12.8, FR10, FR36, FR38): enrolled targets' runtimes on the manager as the registry changes,
// the quota and drain checks before a create, and the wait for agents to come back after a restart. The manager and the factory are fakes here;
// T3's tests (workspaces/connect/) run the real ones.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AppError } from '@isnanme/core';
import type { Workspace } from '@portal/contracts';
import type { Runtime } from '../workspaces/runtime.js';
import { helloFor, openModule, serveModule, type TestModule } from './testkit.js';
import type { ConnectNodeRecord, ConnectTargetRecord, NodeLink, RuntimeDeps, RuntimeFactory } from './seams.js';
import { generateNodeKeyPair, dialTunnel } from './tunnel/index.js';

interface Built {
  target: ConnectTargetRecord;
  nodes: { record: ConnectNodeRecord; link: NodeLink }[];
  deps: RuntimeDeps;
  runtime: Runtime;
}

/** A manager that records what Connect does to it, and a factory that makes inert runtimes. */
function fakes() {
  const calls: string[] = [];
  const built: Built[] = [];
  const factory: RuntimeFactory = (target, nodes, deps) => {
    const runtime = { target: { id: target.id, label: target.label, kind: 'docker', where: 'x' } } as unknown as Runtime;
    built.push({ target, nodes, deps, runtime });
    return runtime;
  };
  const manager = {
    addRuntime: (r: Runtime) => void calls.push(`add:${r.target.id}`),
    replaceRuntime: (r: Runtime) => void calls.push(`replace:${r.target.id}`),
    removeRuntime: (id: string) => void calls.push(`remove:${id}`),
    hooks: {},
  };
  return { calls, built, factory, manager };
}

const create = (m: TestModule, over: Record<string, unknown> = {}) => m.admin('POST', '/targets', { kind: 'docker', platform: 'linux', id: 'lab', portalUrl: 'https://pilot.example.com', ...over });
const enroll = (m: TestModule, token: string, hostname = 'box') =>
  m.call('POST', '/connect/v1/enroll', { publicKey: generateNodeKeyPair().publicKey, hello: helloFor('docker', { hostname }) }, { authorization: `Bearer ${token}` });

describe('the runtime follows the registry', () => {
  test('a target gets a runtime when its first node enrolls, a new one when its shape changes, and none when only a tunnel comes and goes', async () => {
    const m = await openModule();
    const f = fakes();
    m.connect.useRuntimeFactory(f.factory);
    m.connect.bind(f.manager);
    const made = (await create(m, { maxUses: 2 })).json.data;
    assert.deepEqual(f.calls, [], 'a pending target has nothing to run');
    const a = (await enroll(m, made.token, 'one')).json.data.node as string;
    assert.deepEqual(f.calls, ['add:lab']);
    assert.deepEqual(f.built[0]!.nodes.map((n) => n.record.name), ['one']);
    assert.equal(f.built[0]!.target.kind, 'docker');
    assert.equal(f.built[0]!.target.active, true);
    await enroll(m, made.token, 'two');
    assert.deepEqual(f.calls, ['add:lab', 'replace:lab'], 'a second node: the runtime is made again with both');
    assert.equal(f.built[1]!.nodes.length, 2);
    await m.admin('PATCH', '/targets/lab', { settings: { delivery: false } });
    assert.equal(f.calls.at(-1), 'replace:lab', 'delivery changes what the runtime exposes');
    await m.admin('PATCH', `/nodes/${a}`, { drained: true });
    assert.equal(f.calls.at(-1), 'replace:lab');
    assert.equal(f.built.at(-1)!.nodes.find((n) => n.record.id === a)!.record.drained, true);
    const before = f.calls.length;
    await m.admin('PATCH', '/targets/lab', { label: 'Lab' });
    assert.equal(f.calls.length, before + 1, 'a label is part of the target record: rebuilt');
    // a tunnel coming and going is not a registry change: the runtime keeps its links and reads their state
    m.connect.runtimes.sync('lab');
    assert.equal(f.calls.length, before + 1, 'nothing changed: nothing rebuilt');
    await m.close();
  });

  test('the running switch of a single is read through the deps and never rebuilds the runtime', async () => {
    const m = await openModule();
    const f = fakes();
    m.connect.useRuntimeFactory(f.factory);
    m.connect.bind(f.manager);
    const made = (await create(m, { id: 'box', kind: 'container' })).json.data;
    await m.call('POST', '/connect/v1/enroll', { publicKey: generateNodeKeyPair().publicKey, hello: helloFor('container') }, { authorization: `Bearer ${made.token}` });
    assert.deepEqual(f.calls, ['add:box']);
    const deps = f.built[0]!.deps;
    assert.equal(deps.switch.get('box'), true, 'switched on until someone says otherwise');
    deps.switch.set('box', false);
    assert.equal(deps.switch.get('box'), false);
    m.connect.runtimes.sync('box');
    assert.deepEqual(f.calls, ['add:box'], 'no rebuild');
    assert.equal(m.connect.registry.requireTarget('box').settings.running, false);
    await m.close();
  });

  test('removing the target removes the runtime; a factory that throws is logged and the portal carries on', async () => {
    const m = await openModule();
    const f = fakes();
    m.connect.useRuntimeFactory(f.factory);
    m.connect.bind(f.manager);
    const made = (await create(m)).json.data;
    await enroll(m, made.token);
    assert.equal((await m.admin('DELETE', '/targets/lab')).status, 200);
    assert.equal(f.calls.at(-1), 'remove:lab');
    const bad = await openModule();
    bad.connect.useRuntimeFactory(() => {
      throw new Error('factory exploded');
    });
    bad.connect.bind(f.manager);
    const t = (await create(bad)).json.data;
    assert.equal((await enroll(bad, t.token)).status, 200, 'enrolling still works');
    assert.equal(bad.connect.runtimes.has('lab'), false);
    await m.close();
    await bad.close();
  });

  test('a manager that refuses a runtime does not break the registry operation or the start-up', async () => {
    const m = await openModule();
    const f = fakes();
    m.connect.useRuntimeFactory(f.factory);
    m.connect.bind({
      addRuntime: () => {
        throw new Error('duplicate runtime');
      },
      replaceRuntime: () => undefined,
      removeRuntime: () => {
        throw new Error('no such runtime');
      },
      hooks: {},
    });
    const made = (await create(m)).json.data;
    assert.equal((await enroll(m, made.token)).status, 200, 'enrolling still works');
    assert.equal(m.connect.runtimes.has('lab'), false, 'and the next change tries again');
    assert.equal((await m.admin('DELETE', '/targets/lab')).status, 200, 'removing still works');
    await m.close();
  });

  test('when every node was revoked the runtime still exists, with the revoked nodes as drained, so the workspaces stay listed as unreachable', async () => {
    const m = await openModule();
    const f = fakes();
    m.connect.useRuntimeFactory(f.factory);
    m.connect.bind(f.manager);
    const made = (await create(m)).json.data;
    const node = (await enroll(m, made.token)).json.data.node as string;
    await m.admin('DELETE', `/nodes/${node}`);
    const last = f.built.at(-1)!;
    assert.deepEqual(last.nodes.map((n) => [n.record.id, n.record.drained]), [[node, true]]);
    assert.equal(f.calls.at(-1), 'replace:lab');
    await m.close();
  });

  test('Connect turned off: no enrolled runtime is registered', async () => {
    const m = await openModule({ config: { enabled: false } });
    const f = fakes();
    m.connect.useRuntimeFactory(f.factory);
    m.connect.bind(f.manager);
    m.connect.registry.createTarget({ kind: 'docker', platform: 'linux', id: 'lab', portalUrl: 'https://pilot.example.com' }, null, { actor: 'user:u_owner', userId: 'u_owner', ip: null });
    m.connect.runtimes.syncAll();
    assert.deepEqual(f.calls, []);
    await m.close();
  });

  test('the factory arriving after bind, and the manager after the factory, both end in the same place', async () => {
    const m = await openModule();
    const made = (await create(m)).json.data;
    await enroll(m, made.token);
    const f = fakes();
    m.connect.bind(f.manager);
    assert.deepEqual(f.calls, [], 'no factory yet');
    m.connect.useRuntimeFactory(f.factory);
    assert.deepEqual(f.calls, ['add:lab']);
    await m.close();
  });

  test('the deps: the image (the target’s own, else the portal’s), the portal id, snapshots', async () => {
    const m = await openModule();
    const f = fakes();
    m.connect.useRuntimeFactory(f.factory);
    m.connect.bind(f.manager);
    const made = (await create(m, { options: { workspaceImage: 'registry.example.com/ws:1' } })).json.data;
    await enroll(m, made.token);
    const { deps, target } = f.built[0]!;
    assert.equal(deps.image(target), 'registry.example.com/ws:1');
    assert.equal(deps.image({ ...target, settings: {} }), 'ghcr.io/alfianisnan26/claudepilot-workspace:latest');
    assert.equal(deps.portalId(), m.store.portalId);
    assert.equal(deps.snapshots.last('lab'), null);
    const ws: Workspace[] = [{ id: 'lab/a', name: 'a', target: 'lab', image: 'x', status: 'running', createdAt: 'now' }];
    deps.snapshots.save('lab', ws);
    assert.deepEqual(deps.snapshots.last('lab')!.workspaces, ws);
    assert.equal(m.connect.registry.view(m.connect.registry.requireTarget('lab')).workspaces, 1);
    await m.close();
  });
});

describe('before a create (FR10)', () => {
  const code = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      return e instanceof AppError ? e.code : String(e);
    }
    return 'ok';
  };

  test('maxWorkspaces: LIMIT_REACHED at the limit; drained nodes: CONFLICT; a scanned target and a single are not Connect’s to judge', async () => {
    const m = await openModule();
    const made = (await create(m, { maxUses: 2 })).json.data;
    const a = (await enroll(m, made.token, 'one')).json.data.node as string;
    const b = (await enroll(m, made.token, 'two')).json.data.node as string;
    assert.equal(code(() => m.connect.canCreate('lab')), 'ok');
    assert.equal(code(() => m.connect.canCreate('lab', 'one')), 'ok', 'a node by name');
    assert.equal(code(() => m.connect.canCreate('lab', b)), 'ok', 'a node by id');
    assert.equal(code(() => m.connect.canCreate('lab', 'nope')), 'CONFLICT');
    await m.admin('PATCH', `/nodes/${a}`, { drained: true });
    assert.equal(code(() => m.connect.canCreate('lab', 'one')), 'CONFLICT', 'a drained node takes nothing new');
    assert.equal(code(() => m.connect.canCreate('lab')), 'ok', 'the other node does');
    await m.admin('PATCH', `/nodes/${b}`, { drained: true });
    assert.equal(code(() => m.connect.canCreate('lab')), 'CONFLICT', 'every node drained');
    await m.admin('PATCH', `/nodes/${b}`, { drained: false });
    await m.admin('PATCH', '/targets/lab', { settings: { maxWorkspaces: 2 } });
    m.connect.registry.saveSnapshot('lab', [{ id: 'lab/a', name: 'a', target: 'lab', image: 'x', status: 'running', createdAt: 'n' }]);
    assert.equal(code(() => m.connect.canCreate('lab')), 'ok');
    m.clock.now = new Date(m.clock.now.getTime() + 11_000);
    m.connect.registry.saveSnapshot('lab', [1, 2].map((i) => ({ id: `lab/w${i}`, name: `w${i}`, target: 'lab', image: 'x', status: 'running' as const, createdAt: 'n' })));
    assert.equal(code(() => m.connect.canCreate('lab')), 'LIMIT_REACHED');
    assert.equal(code(() => m.connect.canCreate('docker')), 'ok', 'a scanned target');
    assert.equal(code(() => m.connect.canCreate('nowhere')), 'ok', 'an unknown one is the manager’s to refuse');
    const single = (await create(m, { id: 'box', kind: 'container' })).json.data;
    await m.call('POST', '/connect/v1/enroll', { publicKey: generateNodeKeyPair().publicKey, hello: helloFor('container') }, { authorization: `Bearer ${single.token}` });
    assert.equal(code(() => m.connect.canCreate('box')), 'ok', 'a single refuses creates itself');
    await m.close();
  });
});

describe('after a restart (FR38)', () => {
  test('settled resolves at once when nothing was connected before, waits for the nodes that were, and gives up after the time', async () => {
    const first = await openModule();
    const srv1 = await serveModule(first);
    const made = (await first.admin('POST', '/targets', { kind: 'docker', platform: 'linux', id: 'lab', portalUrl: srv1.origin })).json.data;
    const keys = generateNodeKeyPair();
    const res = await first.call('POST', '/connect/v1/enroll', { publicKey: keys.publicKey, hello: helloFor('docker') }, { authorization: `Bearer ${made.token}` });
    const node = res.json.data.node as string;
    assert.equal(await Promise.race([first.connect.settled(1_000).then(() => 'now'), new Promise((r) => setTimeout(() => r('late'), 100))]), 'now', 'never connected: nothing to wait for');
    const d1 = await dialTunnel({ url: `ws://127.0.0.1:${srv1.port}/connect/v1/tunnel`, nodeId: node, privateKey: keys.privateKey, hello: () => helloFor('docker') });
    for (let i = 0; i < 100 && !first.connect.hub.isConnected(node); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(first.connect.registry.requireNode(node).lastSeenAt !== null, true);
    d1.session.destroy();
    await srv1.close();
    // a restarted portal on the same database: the node was seen before, so it is waited for
    const second = await openModule({ store: first.store, dir: first.dir });
    const srv2 = await serveModule(second);
    const t0 = Date.now();
    const waiting = second.connect.settled(1_500).then(() => Date.now() - t0);
    assert.ok((await Promise.race([waiting, new Promise((r) => setTimeout(() => r(-1), 300))])) === -1, 'still waiting while the node is away');
    assert.ok((await waiting) >= 1_400, 'gave up after the time');
    const t1 = Date.now();
    const again = second.connect.settled(5_000).then(() => Date.now() - t1);
    const d2 = await dialTunnel({ url: `ws://127.0.0.1:${srv2.port}/connect/v1/tunnel`, nodeId: node, privateKey: keys.privateKey, hello: () => helloFor('docker') });
    assert.ok((await again) < 1_000, 'resolved when the node came back');
    const returned: string[] = [];
    second.connect.onReturned((t) => returned.push(t));
    d2.session.destroy();
    await new Promise((r) => setTimeout(r, 100));
    const d3 = await dialTunnel({ url: `ws://127.0.0.1:${srv2.port}/connect/v1/tunnel`, nodeId: node, privateKey: keys.privateKey, hello: () => helloFor('docker') });
    for (let i = 0; i < 100 && returned.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(returned, ['lab'], 'onReturned names the target');
    d3.session.destroy();
    await srv2.close();
  });
});
