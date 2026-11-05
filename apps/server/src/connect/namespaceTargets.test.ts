// PILOT-1167 (portal side of G1, docs/prd/cf-bridge.md): several Kubernetes targets, one per namespace, on ONE enrolled node and tunnel.
// A target made with `POST /targets/:id/namespaces` rides on `:id`'s connector (`settings.via`): it shows that node, gets a runtime built on
// that node's link, follows its connects and losses, and is refused what would cut it loose (an enrollment of its own, the host's removal,
// a chain, a namespace already taken). The authz seam still hides a target from an actor who may not see it (the same 404).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AppError } from '@isnanme/core';
import type { Actor } from '@portal/contracts';
import type { Runtime } from '../workspaces/runtime.js';
import type { ConnectNodeRecord, ConnectTargetRecord, NodeLink, RuntimeFactory } from './seams.js';
import { OWNER, helloFor, openModule, serveModule, until, type TestModule } from './testkit.js';
import { dialTunnel, generateNodeKeyPair } from './tunnel/index.js';

/** A manager that records what Connect does, and a factory that keeps what each runtime was given. */
function fakes() {
  const calls: string[] = [];
  const built = new Map<string, { target: ConnectTargetRecord; nodes: { record: ConnectNodeRecord; link: NodeLink }[] }>();
  const factory: RuntimeFactory = (target, nodes) => {
    built.set(target.id, { target, nodes });
    return { target: { id: target.id, label: target.label, kind: 'kubernetes', where: 'x' } } as unknown as Runtime;
  };
  const manager = {
    addRuntime: (r: Runtime) => void calls.push(`add:${r.target.id}`),
    replaceRuntime: (r: Runtime) => void calls.push(`replace:${r.target.id}`),
    removeRuntime: (id: string) => void calls.push(`remove:${id}`),
    hooks: {},
  };
  return { calls, built, factory, manager };
}

const NAMESPACES = ['isnan-pilot-ws-isnan', 'isnan-pilot-ws-konfersi', 'isnan-pilot-ws-kohilabs'];

/** The cp-bridge: one enrolled Kubernetes target and its node; then a namespace target per further namespace. */
async function bridge(m: TestModule) {
  const made = (
    await m.admin('POST', '/targets', {
      kind: 'kubernetes',
      platform: 'linux',
      id: 'cpb',
      portalUrl: 'https://pilot.example.com',
      options: { namespace: 'claudepilot-workspaces' },
    })
  ).json.data;
  const keys = generateNodeKeyPair();
  const res = await m.call(
    'POST',
    '/connect/v1/enroll',
    { publicKey: keys.publicKey, hello: helloFor('kubernetes', { hostname: 'cp-bridge' }) },
    { authorization: `Bearer ${made.token}` },
  );
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const ids: string[] = [];
  for (const [i, namespace] of NAMESPACES.entries()) {
    const id = `cpb-${i + 1}`;
    const r = await m.admin('POST', '/targets/cpb/namespaces', { id, namespace, storage: '20Gi' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    ids.push(id);
  }
  return { node: res.json.data.node as string, keys, riders: ids };
}

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : String(e);
  }
  return 'ok';
};

describe('namespace targets on one connector (PILOT-1167)', () => {
  test('the four workspace namespaces each show as a target backed by the one cp-bridge node', async () => {
    const m = await openModule();
    const { node, riders } = await bridge(m);
    const list = (await m.admin('GET', '/targets')).json.data as {
      source: string;
      id: string;
      state: string;
      nodes: { id: string; name: string }[];
      settings: Record<string, unknown>;
      where: string;
      enrollment: unknown;
    }[];
    const ours = list.filter((t) => t.source === 'enrolled');
    assert.deepEqual(ours.map((t) => t.id).sort(), ['cpb', ...riders].sort());
    for (const t of ours) {
      assert.equal(t.state, 'active', `${t.id} is active`);
      assert.deepEqual(
        t.nodes.map((n) => [n.id, n.name]),
        [[node, 'cp-bridge']],
        `${t.id} shows the one bridge node`,
      );
    }
    const namespaces = ours.map((t) => t.settings.namespace).sort();
    assert.deepEqual(namespaces, ['claudepilot-workspaces', ...NAMESPACES].sort(), 'one target per namespace');
    const rider = ours.find((t) => t.id === 'cpb-2')!;
    assert.equal(rider.settings.via, 'cpb');
    assert.equal(rider.settings.storage, '20Gi');
    assert.equal(rider.enrollment, null, 'no token of its own');
    assert.match(rider.where, /isnan-pilot-ws-konfersi$/);
    assert.equal(m.connect.registry.liveNodes('cpb-2').length, 0, 'no node row of its own: the node stays the host’s');
    assert.deepEqual(
      m.connect.nodeViews('cpb-3').map((n) => n.id),
      [node],
      'what the manager asks for a node pick',
    );
    await m.close();
  });

  test('each rider’s runtime is built on the host node’s link, with its own record; host changes rebuild the riders too', async () => {
    const m = await openModule();
    const f = fakes();
    m.connect.useRuntimeFactory(f.factory);
    m.connect.bind(f.manager);
    const { node, riders } = await bridge(m);
    assert.deepEqual(f.calls, ['add:cpb', ...riders.map((id) => `add:${id}`)]);
    for (const id of riders) {
      const b = f.built.get(id)!;
      assert.deepEqual(
        b.nodes.map((n) => n.record.id),
        [node],
        `${id} runs on the bridge node`,
      );
      assert.equal(b.nodes[0]!.link.nodeId, node);
      assert.equal(b.target.id, id, 'its own target record: its own id, namespace and snapshots');
      assert.equal(b.target.settings.via, 'cpb');
    }
    assert.notEqual(f.built.get('cpb-1')!.target.settings.namespace, f.built.get('cpb-2')!.target.settings.namespace);
    // draining the host's node is a change of every rider's node list
    await m.admin('PATCH', `/nodes/${node}`, { drained: true });
    assert.deepEqual(f.calls.slice(-4).sort(), ['replace:cpb', ...riders.map((id) => `replace:${id}`)].sort());
    assert.equal(f.built.get('cpb-1')!.nodes[0]!.record.drained, true);
    assert.equal(
      codeOf(() => m.connect.canCreate('cpb-1')),
      'CONFLICT',
      'a rider’s create follows the host node’s drain',
    );
    await m.admin('PATCH', `/nodes/${node}`, { drained: false });
    assert.equal(
      codeOf(() => m.connect.canCreate('cpb-1')),
      'ok',
    );
    await m.close();
  });

  test('a host node connecting or dropping is reported for every rider too', async () => {
    const m = await openModule();
    const srv = await serveModule(m);
    const { node, keys, riders } = await bridge(m);
    const returned: string[] = [];
    const lost: string[] = [];
    m.connect.onReturned((t) => returned.push(t));
    m.connect.onLost((t) => lost.push(t));
    const d = await dialTunnel({
      url: `ws://127.0.0.1:${srv.port}/connect/v1/tunnel`,
      nodeId: node,
      privateKey: keys.privateKey,
      hello: () => helloFor('kubernetes', { hostname: 'cp-bridge' }),
    });
    await until(() => returned.length >= 4, 'every target heard the connect');
    assert.deepEqual(returned.sort(), ['cpb', ...riders].sort());
    const view = (await m.admin('GET', '/targets/cpb-3')).json.data;
    assert.equal(view.link, 'connected', 'a rider is connected when its host node is');
    d.session.destroy();
    await until(() => lost.length >= 4, 'every target heard the loss');
    assert.deepEqual(lost.sort(), ['cpb', ...riders].sort());
    await srv.close();
    await m.close();
  });

  test('what would cut a rider loose is refused', async () => {
    const m = await openModule();
    await bridge(m);
    const post = (path: string, body: unknown) => m.admin('POST', path, body);
    // a namespace already on this connector: the host's, or another rider's
    assert.equal((await post('/targets/cpb/namespaces', { id: 'dup1', namespace: 'claudepilot-workspaces' })).status, 409);
    assert.equal((await post('/targets/cpb/namespaces', { id: 'dup2', namespace: NAMESPACES[0] })).status, 409);
    // no chains: a rider can't carry another
    assert.equal((await post('/targets/cpb-1/namespaces', { id: 'chain', namespace: 'other-ns' })).status, 409);
    // a bad namespace, a bad or taken id
    const bad = await post('/targets/cpb/namespaces', { id: 'badns', namespace: 'Bad Ns!' });
    assert.deepEqual([bad.status, Object.keys(bad.json.error.details)], [422, ['namespace']]);
    assert.equal((await post('/targets/cpb/namespaces', { id: 'nons' })).status, 422, 'a namespace is required');
    assert.equal((await post('/targets/cpb/namespaces', { id: 'cpb-1', namespace: 'fresh-ns' })).status, 409, 'id taken');
    assert.equal(
      (await post('/targets/cpb/namespaces', { id: 'docker', namespace: 'fresh-ns' })).status,
      422,
      'a scanned target’s id: the same checkId as POST /targets',
    );
    // only an active Kubernetes target carries riders
    await m.admin('POST', '/targets', { kind: 'docker', platform: 'linux', id: 'lab', portalUrl: 'https://pilot.example.com' });
    assert.equal((await post('/targets/lab/namespaces', { id: 'onlab', namespace: 'fresh-ns' })).status, 409, 'not Kubernetes');
    await m.admin('POST', '/targets', { kind: 'kubernetes', platform: 'linux', id: 'kpending', portalUrl: 'https://pilot.example.com' });
    assert.equal(
      (await post('/targets/kpending/namespaces', { id: 'onpending', namespace: 'fresh-ns' })).status,
      409,
      'nothing enrolled yet',
    );
    assert.equal((await post('/targets/nope/namespaces', { id: 'onnope', namespace: 'fresh-ns' })).status, 404);
    // a rider gets no token; its `via` is fixed; the same value sent back is fine
    assert.equal((await post('/targets/cpb-1/enrollments', { platform: 'linux' })).status, 409);
    assert.equal((await m.admin('PATCH', '/targets/cpb-1', { settings: { via: 'lab' } })).status, 409);
    assert.equal((await m.admin('PATCH', '/targets/cpb-1', { settings: { via: null } })).status, 409);
    assert.equal(
      (await m.admin('PATCH', '/targets/cpb-1', { settings: { via: 'cpb', namespace: NAMESPACES[0], maxWorkspaces: 5 } })).status,
      200,
    );
    assert.equal((await m.admin('PATCH', '/targets/cpb', { settings: { via: 'cpb-1' } })).status, 409, 'a host can’t start riding');
    // the host can't go while riders are on it; nothing was disconnected or forgotten by the refusal
    const refused = await m.admin('DELETE', '/targets/cpb');
    assert.equal(refused.status, 409);
    assert.match(refused.json.error.message, /cpb-1, cpb-2, cpb-3 ride on/);
    assert.ok(m.connect.registry.target('cpb'));
    assert.throws(
      () => m.connect.registry.forgetTarget('cpb', OWNER, { workspaces: 'none' }),
      (e) => e instanceof AppError && e.code === 'CONFLICT',
    );
    // a rider goes on its own, without touching the host's node; then the host can go
    for (const id of ['cpb-1', 'cpb-2', 'cpb-3']) assert.equal((await m.admin('DELETE', `/targets/${id}`)).status, 200);
    assert.equal(m.connect.registry.liveNodes('cpb').length, 1, 'the bridge node is still enrolled');
    assert.equal((await m.admin('DELETE', '/targets/cpb')).status, 200);
    await m.close();
  });

  test('the authz seam: a namespace target is hidden (404) from an actor who may not see it, as any target', async () => {
    const m = await openModule();
    await bridge(m);
    const other: Actor = { kind: 'user', userId: 'u_other' as never, loginSessionId: 'legacy', via: 'ui' } as Actor;
    const admin = m.connect.admin;
    const meta = { ip: null, origin: 'https://pilot.example.com' };
    const notFound = (e: unknown) => e instanceof AppError && e.code === 'NOT_FOUND' && e.status === 404;
    assert.throws(() => admin.view(other, 'cpb-1'), notFound, 'a rider');
    assert.throws(() => admin.view(other, 'cpb'), notFound, 'its host');
    assert.throws(() => admin.view(other, 'nope'), notFound, 'the same answer as a missing one');
    assert.throws(
      () => admin.createNamespaceTarget(other, 'cpb', { id: 'sneak', namespace: 'sneak-ns' }, meta),
      notFound,
      'no rider on a target it can’t see',
    );
    assert.equal(m.connect.registry.target('sneak'), null, 'nothing was made');
    assert.deepEqual(await admin.list(other), [], 'its list holds none of them');
    // the owner sees them all
    const owner: Actor = { kind: 'user', userId: 'u_owner' as never, loginSessionId: 'legacy', via: 'ui' } as Actor;
    assert.equal(admin.view(owner, 'cpb-1').id, 'cpb-1');
    await m.close();
  });
});
