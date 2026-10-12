// The runtimes over T1's real hub (docs/prd/targets-connect.md §12.3, §12.7): an enrolled node dials the hub over a real WebSocket on
// loopback with its signed handshake; its streams are served by a stand-in agent (T2's host service, and a byte pipe to the DinD
// socket for `docker`). The portal side is `hub.link(node)`, the NodeLink the registry hands the factory. A Host single runs commands
// and delivers through it; the socket is killed and the runtime says Target unreachable, then the node dials again and it works.
// The Docker part needs CLAUDEPILOT_DOCKER_TESTS=1. T2's real agent (`runAgent`) replaces the stand-in when it lands.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { silentLogger } from '../../connect/agent/log.js';
import { createService } from '../../connect/agent/services/host/index.js';
import { openCore, openHub, type Core, type TestHub } from '../../connect/testkit.js';
import { isTargetUnreachable } from '../runtime.js';
import { createTunnelRuntime } from './factory.js';
import { memoryDeps, serveAgentStream, targetRecord, type FakeAgentServices } from './testkit.js';

let core: Core;
let h: TestHub;
let home: string;
let hold: NodeJS.Timeout;

before(async () => {
  hold = setInterval(() => undefined, 1000);
  home = mkdtempSync(join(tmpdir(), 'cx3-real-'));
  core = await openCore();
  h = await openHub(core);
});
after(async () => {
  clearInterval(hold);
  await h.close();
  core.store.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(core.dir, { recursive: true, force: true });
});

const agent = (services: FakeAgentServices) => ({ onStream: (s: Parameters<typeof serveAgentStream>[0]) => void serveAgentStream(s, services) });

test('a Host single over the real hub: exec, delivery, an outage and the return', async () => {
  // Enrolled as a Container single: T1's test wizard does not pass hostAccess to the enrollment of a Host kind yet (told T1). The runtime is the same.
  const n = h.enrollNode({ id: 'cx3-metal', kind: 'container' });
  const services = { host: createService({ mode: 'host', home, log: silentLogger, baseEnv: { PATH: process.env.PATH } }) };
  let d = await h.dial(n.nodeId, n.keys, { kind: 'container', ...agent(services) });
  assert.ok(await h.waitFor(() => h.hub.isConnected(n.nodeId)));
  const link = h.hub.link({ id: n.nodeId, targetId: 'cx3-metal' });
  const deps = memoryDeps();
  deps.switches.set('cx3-metal', true);
  const rt = createTunnelRuntime(targetRecord({ id: 'cx3-metal', kind: 'host' }), [{ record: { id: n.nodeId, targetId: 'cx3-metal', name: 'metal', drained: false, keyFingerprint: 'x' }, link }], deps);
  try {
    await rt.check();
    const s = await rt.exec('cx3-metal', ['sh', '-c', 'echo "$((6*7))"']);
    let out = '';
    s.onData((b) => (out += b.toString()));
    assert.equal(await new Promise((r) => s.onExit(r)), 0);
    assert.equal(out, '42\n');
    await rt.delivery!.put('cx3-metal', [{ path: '/home/node/.cx3-real', type: 'file', content: 'over the hub', mode: 0o600, uid: 1000, gid: 1000 }]);
    assert.equal(readFileSync(join(home, '.cx3-real'), 'utf8'), 'over the hub');

    d.ws.terminate();
    assert.ok(await h.waitFor(() => !link.connected()));
    await assert.rejects(rt.exec('cx3-metal', ['true']), (e) => isTargetUnreachable(e));
    assert.equal(rt.listLastKnown!()[0]!.status, 'unreachable');

    d = await h.dial(n.nodeId, n.keys, { kind: 'container', ...agent(services) });
    assert.ok(await h.waitFor(() => link.connected()));
    assert.equal(await rt.delivery!.read('cx3-metal', '/home/node/.cx3-real'), 'over the hub');
  } finally {
    (rt as { dispose?: () => void }).dispose?.();
  }
});

test('Docker over the real hub on DinD: check and list through the hub', { skip: process.env.CLAUDEPILOT_DOCKER_TESTS !== '1' && 'set CLAUDEPILOT_DOCKER_TESTS=1' }, async () => {
  const n = h.enrollNode({ id: 'cx3-dock' });
  await h.dial(n.nodeId, n.keys, agent({ dockerSocket: '/var/run/docker.sock' }));
  assert.ok(await h.waitFor(() => h.hub.isConnected(n.nodeId)));
  const link = h.hub.link({ id: n.nodeId, targetId: 'cx3-dock' });
  const rt = createTunnelRuntime(targetRecord({ id: 'cx3-dock' }), [{ record: { id: n.nodeId, targetId: 'cx3-dock', name: 'dind', drained: false, keyFingerprint: 'x' }, link }], memoryDeps());
  try {
    await rt.check();
    assert.ok(Array.isArray(await rt.list()));
    assert.match(rt.target.where, /docker|dind/);
  } finally {
    (rt as { dispose?: () => void }).dispose?.();
  }
});
